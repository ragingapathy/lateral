#!/usr/bin/env python3
"""
Lateral transcription worker (optional).

A small local HTTP service that turns a podcast episode URL into a timestamped transcript using
faster-whisper. Lateral's proxy talks to it; nothing leaves your machine.

    pip install faster-whisper
    python tools/transcribe_worker.py                      # 127.0.0.1:3007, model small.en
    python tools/transcribe_worker.py --host 0.0.0.0 --token SECRET   # reachable from Docker

Runs on CPU by default (int8), so it does not compete with a local language model for the GPU.
One job at a time; extra jobs wait in a queue.

API (JSON):
    GET  /health                -> { ok, engine, model, device, queued, running }
    POST /jobs   { url, model?, language? }  -> { id }
    GET  /jobs/<id>             -> { state: queued|downloading|transcribing|done|error, progress: 0..1,
                                     error?, result?: { language, duration, model, segments: [{s, e, t}] } }
    DELETE /jobs/<id>           -> cancel / forget

If --token (or LATERAL_WORKER_TOKEN) is set, every request needs "Authorization: Bearer <token>".
"""
import argparse
import hmac
import ipaddress
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 700 * 1024 * 1024          # refuse absurd downloads (about 12 hours of 128 kbps audio)
DOWNLOAD_TIMEOUT = 60
KEEP_FINISHED_SECS = 6 * 3600
UA = "Mozilla/5.0 (compatible; LateralTranscribeWorker/1.0)"

JOBS = {}                      # id -> dict
QUEUE = []                     # job ids waiting
LOCK = threading.Lock()
WAKE = threading.Event()
MODELS = {}                    # name -> loaded WhisperModel
ARGS = None


# ── Safety: only fetch public http(s) audio ──────────────────────────────────────────────────────

def _public_host(host):
    """Reject loopback, private, link-local and similar addresses so the worker can't be pointed at the LAN."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return False
    return True


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _check_url(url):
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("Only http(s) audio URLs are allowed.")
    if not _public_host(p.hostname):
        raise ValueError("That address is not a public host.")


# ── Download + transcribe ────────────────────────────────────────────────────────────────────────

def _get_model(name):
    if name not in MODELS:
        from faster_whisper import WhisperModel
        MODELS.clear()  # keep one model in memory
        MODELS[name] = WhisperModel(name, device=ARGS.device, compute_type=ARGS.compute_type, cpu_threads=ARGS.threads)
    return MODELS[name]


def _download(job, dest):
    _check_url(job["url"])
    opener = urllib.request.build_opener(_SafeRedirect)
    req = urllib.request.Request(job["url"], headers={"User-Agent": UA, "Accept": "*/*"})
    with opener.open(req, timeout=DOWNLOAD_TIMEOUT) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        if total and total > MAX_BYTES:
            raise ValueError("Audio file is too large.")
        done = 0
        while True:
            if job["cancel"]:
                raise InterruptedError("cancelled")
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            done += len(chunk)
            if done > MAX_BYTES:
                raise ValueError("Audio file is too large.")
            f.write(chunk)
            if total:
                job["progress"] = min(0.99, done / total)
    job["bytes"] = done


def _run(job):
    tmp = tempfile.NamedTemporaryFile(suffix=".audio", delete=False)
    tmp.close()
    try:
        job["state"] = "downloading"
        job["progress"] = 0
        _download(job, tmp.name)
        job["state"] = "transcribing"
        job["progress"] = 0
        model = _get_model(job["model"])
        segments, info = model.transcribe(
            tmp.name,
            language=job["language"] or None,
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        duration = float(info.duration or 0)
        out = []
        for seg in segments:
            if job["cancel"]:
                raise InterruptedError("cancelled")
            text = seg.text.strip()
            if text:
                out.append({"s": round(seg.start, 2), "e": round(seg.end, 2), "t": text})
            if duration:
                job["progress"] = min(0.99, seg.end / duration)
        job["result"] = {"language": info.language, "duration": round(duration, 1), "model": job["model"], "segments": out}
        job["progress"] = 1
        job["state"] = "done"
    except InterruptedError:
        job["state"] = "error"
        job["error"] = "Cancelled."
    except Exception as e:  # noqa: BLE001 - report any failure to the caller
        job["state"] = "error"
        job["error"] = str(e)[:300] or e.__class__.__name__
    finally:
        job["finished"] = time.time()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _worker_loop():
    while True:
        WAKE.wait()
        while True:
            with LOCK:
                jid = QUEUE.pop(0) if QUEUE else None
                if jid is None:
                    WAKE.clear()
                    break
                job = JOBS.get(jid)
            if job and not job["cancel"]:
                _run(job)
        _sweep()


def _sweep():
    now = time.time()
    with LOCK:
        for jid in [k for k, j in JOBS.items() if j.get("finished") and now - j["finished"] > KEEP_FINISHED_SECS]:
            JOBS.pop(jid, None)


# ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

def _public_job(job, with_result=True):
    out = {"id": job["id"], "state": job["state"], "progress": round(job["progress"], 3)}
    if job.get("error"):
        out["error"] = job["error"]
    if with_result and job["state"] == "done":
        out["result"] = job["result"]
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "LateralWorker/1.0"

    def log_message(self, fmt, *a):  # quiet
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        if not ARGS.token:
            return True
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got, "Bearer " + ARGS.token)

    def do_GET(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/health":
            with LOCK:
                running = sum(1 for j in JOBS.values() if j["state"] in ("downloading", "transcribing"))
                return self._send(200, {"ok": True, "engine": "faster-whisper", "model": ARGS.model, "device": ARGS.device,
                                        "queued": len(QUEUE), "running": running})
        if self.path.startswith("/jobs/"):
            job = JOBS.get(self.path[6:])
            return self._send(200, _public_job(job)) if job else self._send(404, {"error": "no such job"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        if self.path != "/jobs":
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            url = str(body.get("url") or "")
            _check_url(url)
        except Exception as e:  # noqa: BLE001
            return self._send(400, {"error": str(e)[:200]})
        model = str(body.get("model") or ARGS.model)
        if not all(c.isalnum() or c in ".-_" for c in model):
            return self._send(400, {"error": "bad model name"})
        job = {"id": uuid.uuid4().hex[:12], "url": url, "model": model, "language": str(body.get("language") or ""),
               "state": "queued", "progress": 0, "cancel": False, "created": time.time()}
        with LOCK:
            JOBS[job["id"]] = job
            QUEUE.append(job["id"])
        WAKE.set()
        self._send(200, {"id": job["id"]})

    def do_DELETE(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        if self.path.startswith("/jobs/"):
            with LOCK:
                job = JOBS.get(self.path[6:])
                if job:
                    job["cancel"] = True
                    if job["state"] in ("queued", "done", "error"):
                        JOBS.pop(job["id"], None)
                        if job["id"] in QUEUE:
                            QUEUE.remove(job["id"])
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})


def main():
    global ARGS
    ap = argparse.ArgumentParser(description="Lateral transcription worker")
    ap.add_argument("--host", default=os.environ.get("LATERAL_WORKER_HOST"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("LATERAL_WORKER_PORT", "3007")))
    ap.add_argument("--token", default=os.environ.get("LATERAL_WORKER_TOKEN", ""))
    ap.add_argument("--model", default=os.environ.get("LATERAL_WHISPER_MODEL", "small.en"),
                    help="faster-whisper model: tiny.en, base.en, small.en (default), medium.en, or multilingual names")
    ap.add_argument("--device", default=os.environ.get("LATERAL_WHISPER_DEVICE", "cpu"))
    ap.add_argument("--compute-type", dest="compute_type", default=os.environ.get("LATERAL_WHISPER_COMPUTE", "int8"))
    ap.add_argument("--threads", type=int, default=int(os.environ.get("LATERAL_WHISPER_THREADS", "8")))
    ARGS = ap.parse_args()
    if not ARGS.host:
        ARGS.host = "0.0.0.0" if ARGS.token else "127.0.0.1"
    if ARGS.host not in ("127.0.0.1", "localhost", "::1") and not ARGS.token:
        print("Refusing to listen beyond localhost without --token.", file=sys.stderr)
        sys.exit(2)
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        print("faster-whisper is not installed. Run: pip install faster-whisper", file=sys.stderr)
        sys.exit(1)
    threading.Thread(target=_worker_loop, daemon=True).start()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    print(f"Lateral transcription worker on http://{ARGS.host}:{ARGS.port} (model {ARGS.model}, {ARGS.device}/{ARGS.compute_type})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
