# Lateral — narrative memory

Lateral is a local-first tool for following stories that unfold over months. You track a story, and Lateral keeps its timeline,
gathers fresh coverage, shows you what changed, and lets you test predictions against the evidence as it arrives.

It is a single-page app (`index.html`) plus a small Node server. It runs on your own machine and uses [Ollama](https://ollama.com)
for the AI parts; cloud LLM providers are optional.

## Features

- **Story timelines** — episodes, headlines, video and podcast context, intelligence briefs, a connection map, and shareable pages.
- **Discovery** — a home feed by category, plus a per-story "Discover" search with AI-generated queries.
- **Relevance filter** — keyword search drags in junk ("military duty" in a football story). A local model reads each article
  against the topic it was filed under and moves off-topic ones into a **Filtered out** list you can review and restore.
  Nothing is silently deleted.
- **Predictions** — write a falsifiable claim, attach *signals* (searches that watch for evidence), and Lateral finds articles and
  scores each as supporting, contradicting, complicating, or irrelevant. You can override any call. The **evidence balance** shows
  which way the news leans; it is *not* a probability and it never changes your own confidence.
- **Article images that actually load** — many news results arrive as opaque Google News links. Lateral resolves them to the real
  article, reads the page, recovers bot-blocked pages with Tavily, and runs every candidate past a small vision model so logos,
  tiny thumbnails and unrelated images are rejected. Anything left shows a clean fallback card.

## Requirements

- **Docker** with Compose v2
- **Ollama** running on the host, with these models:
  ```bash
  ollama pull qwen3:latest     # relevance filter, evidence scoring, query generation, image-fit judge
  ollama pull moondream        # image judge (optional — without it images are accepted unjudged)
  ```
- A **Tavily API key** (a free tier exists): <https://app.tavily.com>. It powers web search for evidence and briefs, and recovers
  images from pages that block scrapers.

## Quick start

```bash
git clone https://github.com/ragingapathy/lateral.git && cd lateral

# 1. Give SearXNG a private secret (any random string):
#    edit searxng/settings.yml  ->  server.secret_key

# 2. Optional: set keys through the environment (or paste them in the app instead)
cp .env.example .env

# 3. Start everything
docker compose up -d

# 4. Open the app:  http://localhost:8080
```

Then click the **⚙ Settings** icon → **Web search** → paste your Tavily key → **Save key**. Lateral runs a test search straight
away so you know the key works. The app opens with a fictional sample story so you can see how things look; delete it whenever.

## How the pieces fit

| Service | What it does |
|---|---|
| `web` (Caddy) | Serves `index.html` and forwards `/api/lateral/*` and `/v2/*` to the proxy, and `/ollama/*` to Ollama on the host. |
| `lateral-proxy` (Node) | News search, the predictions API, the relevance and image pipelines, saved settings, LLM passthrough. Code in `proxy/`. |
| `searxng` | Meta-search used for news results (JSON output enabled in `searxng/settings.yml`). |

## Your data

Everything that belongs to your install lives in `./data` (mounted into the proxy container at `/data`). It starts empty, is created
as you use the app, and is **git-ignored** — only `.gitkeep` and `llm-secrets.example.json` are tracked.

| File | What it holds |
|---|---|
| `llm-secrets.json` | API keys you save from Settings (Tavily, optional LLM providers, podcast services). **Secret.** |
| `stories.json` | The stories you track and their episodes. |
| `v2.json` | Predictions, their signals, and the articles scored against them. |
| `cache.json` | Cached headlines, discovery feed and briefs. Safe to delete; it rebuilds. |
| `settings.json` | Preferences such as location and refresh interval. |
| `relevance-cache.json` | AI relevance verdicts (what was filtered out of a topic and why), plus any you restored. |
| `image-cache.json`, `image-stats.json` | Resolved article image URLs, and pipeline counters including Tavily Extract usage. |
| `intelligence.log`, `refresh-log.json`, `purged-ids.json` | Operational logs and bookkeeping. |

To back up, copy the folder. To start fresh, stop the stack and empty it (keep `.gitkeep` in a git checkout).

## Configuration

Set on the `lateral-proxy` service in `docker-compose.yml`:

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Where the proxy reaches Ollama. |
| `SEARXNG_URL` | `http://searxng:8080` | News search backend. |
| `TAVILY_API_KEY` | — | Optional; a key saved in Settings takes priority. |
| `LATERAL_SCORING_MODEL` | `qwen3:latest` | Evidence scoring. |
| `LATERAL_RELEVANCE_MODEL` | `qwen3:latest` | Relevance judge. |
| `LATERAL_VISION_MODEL` | `moondream:latest` | Describes candidate images. |
| `LATERAL_IMAGE_JUDGE_MODEL` | `qwen3:latest` | Decides photo-vs-logo and headline fit. |
| `LATERAL_TAVILY_EXTRACT_PER_DAY` | `40` | Daily cap on Tavily Extract calls (used only for pages that block direct fetching). |
| `LATERAL_NEWS_ENGINES` | see `proxy/server.js` | Which SearXNG news engines to use. |
| `LATERAL_DATA_DIR` | `/data` | Where state is stored inside the container. |

## Scripting and automation

The proxy exposes a plain JSON API, so scripts and other tools can drive Lateral without the UI.

| Endpoint | Purpose |
|---|---|
| `GET/POST /v2/predictions` | List or create predictions (`statement`, `confidence`, `resolutionDate`, `signals[]`). |
| `GET/PATCH/DELETE /v2/predictions/:id` | Read (with evidence balance), edit, or delete a prediction. |
| `POST /v2/predictions/:id/search` | Start the background search-and-score job; poll `GET /v2/predictions/:id/search/status`. |
| `POST /v2/signals/suggest` | Suggest search signals for a statement. |
| `GET /v2/links?predictionId=` | Articles linked to a prediction, with stance, weight and reasoning. |
| `POST /v2/links/:id/review` · `/score` | Override a stance by hand, or have the model score it again. |
| `POST /v2/items` | Add an article as evidence, optionally linked to a prediction with a stance. |
| `POST /api/lateral/relevance/check` · `/relevance/override` | Relevance judge, and "restore" overrides. |
| `POST /api/lateral/images/resolve` · `GET /api/lateral/images/stats` | Image pipeline, and its counters. |

Optional local routes: a git-ignored `proxy/v2.local.js` may export `route(req, reqUrl, res, ctx)` to add private endpoints.

## Chrome extension

`extension/` is a small companion that clips the page you're reading into a new story or a new episode.

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder (the one containing `manifest.json`).
3. Open the extension's settings and set your Lateral URL (default `http://localhost:8080`).

## Things to know

- **The evidence balance is a direction, not a probability.** It counts weighted supporting vs. contradicting articles; it knows
  nothing about base rates, time horizon, or whether several articles describe the same event.
- **Local models vary.** Scores and relevance calls can shift slightly between runs. Overrides and restores are always kept.
- **Google News link resolution** uses an undocumented Google endpoint. If it ever stops working, Lateral falls back to its older
  behaviour: nothing breaks, but more articles show the fallback card.
- **Tavily usage.** Search and scoring use Tavily Search. Tavily Extract is only used for pages that block direct fetching, and is
  capped per day. `GET /api/lateral/images/stats` shows the counters, including estimated Extract credits.
- **Privacy.** Everything runs locally. Outbound traffic is: your searches (through SearXNG's upstream engines and Tavily), fetching
  the article pages you track, and any cloud LLM provider *you* configure.

## Troubleshooting

- **"Tavily API key not configured"** — add it under Settings → Web search.
- **AI features fail / "Ollama unreachable"** — confirm Ollama is running and the models above are pulled. On Linux you may need
  Ollama to listen on all interfaces (`OLLAMA_HOST=0.0.0.0`) so containers can reach it.
- **News search returns little** — individual SearXNG engines come and go; check `docker compose logs searxng`.
- **Images missing** — check `moondream` is installed and look at `/api/lateral/images/stats`. Articles with no usable image get the
  fallback card by design.

## What's new in v2.0

- Predictions with editable signals, background search-and-score with live progress, per-article overrides and re-scoring, an evidence
  balance, and share pages that include the tracked evidence.
- The relevance filter and its reviewable "Filtered out" lists (Home Discovery, story Headlines, Discover modal).
- The image pipeline: Google News link resolution, image validation, vision judging, Tavily Extract recovery, and a fallback card.
- A **Web search** tab in Settings to save and test the Tavily key.
- A standalone `docker-compose.yml` stack.

## License

Lateral is **source-available** under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).
You may use, modify and share it for personal, educational, research and other noncommercial purposes. Commercial use requires
separate permission from the copyright holder. See `LICENSE`.
