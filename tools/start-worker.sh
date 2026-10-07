#!/usr/bin/env sh
# Starts the Lateral transcription worker in the background (macOS / Linux).
# Token: LATERAL_WORKER_TOKEN if set, otherwise the one in data/podcast-worker.json (if any).
cd "$(dirname "$0")/.." || exit 1
if [ -z "$LATERAL_WORKER_TOKEN" ] && [ -f data/podcast-worker.json ]; then
  LATERAL_WORKER_TOKEN=$(python3 -c "import json;print(json.load(open('data/podcast-worker.json')).get('token',''))")
  export LATERAL_WORKER_TOKEN
fi
PY=python3
[ -x tools/.venv/bin/python ] && PY=tools/.venv/bin/python
nohup "$PY" tools/transcribe_worker.py >> tools/worker.log 2>&1 &
echo "Lateral transcription worker starting on port 3007 (log: tools/worker.log)."
