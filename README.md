# Lateral — narrative memory

## Why

News is built to be forgotten. Each story arrives as if it had no past: a headline, a burst of coverage, then the next thing. Months later you remember that something happened (a lawsuit, a recall, a promise from someone in power) but not how it ended, or whether it ended at all.

Feeds don't help. They rank what's new, not what's unfinished. Search finds articles, not arcs.

Lateral is for the stories you don't want to lose track of. You tell it what you're following, and it keeps the timeline, gathers new coverage, tells you when something moves, and saves readable copies so the record survives dead links. When you think you know where a story is heading, you can write that down as a prediction and watch the evidence build for or against it, then keep score of how often you were right.

It runs on your own machine. Your stories, notes and predictions stay there.

Lateral is a local-first tool for following stories that unfold over months. You track a story, and Lateral keeps its timeline,
gathers fresh coverage, shows you what changed, and lets you test predictions against the evidence as it arrives.

It is a single-page app (`index.html`) plus a small Node server. It runs on your own machine and uses [Ollama](https://ollama.com)
for the AI parts; cloud LLM providers are optional.

## Screenshots

![The home overview in the Midnight theme: status cards, a breakdown of every tracked story, and a feed of the latest coverage](screenshots/overview-midnight.webp)

*The home overview (Midnight theme): every tracked story at a glance, with the latest coverage for each below. Lateral has three themes (Beige, Ledger and Midnight); pick one in Settings → Basic, or press `t` to cycle.*

![A story page: an episode timeline, the latest headlines, and video, podcast and social context](screenshots/story-view.webp)

*A story page: the episode timeline, the latest headlines (with the relevance filter's **Check relevance** button), and video, podcast and social context.*

## Features

- **Story timelines** — episodes, headlines, video and podcast context, intelligence briefs, a connection map, and shareable pages.
- **Discovery** — a home feed by category, plus a per-story "Discover" search with AI-generated queries.
- **Relevance filter** — keyword search drags in junk ("military duty" in a football story). A local model reads each article
  against the topic it was filed under and moves off-topic ones into a **Filtered out** list you can review and restore.
  Nothing is silently deleted.
- **Predictions** — write a falsifiable claim, attach *signals* (searches that watch for evidence), and Lateral finds articles and
  scores each as supporting, contradicting, complicating, or irrelevant. You can override any call. The **evidence balance** shows
  which way the news leans; it is *not* a probability and it never changes your own confidence.
- **Change alerts** — Lateral tells you when something you follow has moved. The **Activity** inbox (the bell, or press `a`) lists
  what it noticed: a prediction's evidence changing direction or shifting meaningfully, a resolution date getting close, a story
  picking up new coverage, setup problems, and Tavily credits running low. In **Settings → Alerts**, add [ntfy](https://ntfy.sh)
  (phone push), Discord, Slack, or any webhook to get the important ones instantly and everything else as a daily digest, even
  with the app closed. Optionally let Lateral re-run your predictions' searches on a schedule so evidence keeps moving while you
  are away (it shows the Tavily credit cost first, and pauses at 90%).
- **RSS and Atom, both ways** — *Out:* **Settings → Feeds** gives you Atom feeds for any feed reader: everything on your Activity list,
  all your stories, or one story (for a prediction: its evidence and movements), plus an OPML file to subscribe to all of them at
  once. A secret in each address is the only password, and you can reset it. *In:* open a story, choose **Feeds** in the Latest
  Headlines bar, and paste a site or feed address (the feed is found for you) or import an OPML file. New items from those feeds
  join the story's headlines and its alerts, and are read on the background refresh too.
- **Same-story grouping** — one announcement carried by BBC, Axios, CBS and Bloomberg is one piece of evidence, not four. Lateral finds
  candidate duplicates (headline wording, plus embeddings if available) and has the local model judge each pair, then counts a group
  of articles once in a prediction's evidence balance. Repeats stay listed, dimmed and marked, and **Not the same story** puts one
  back. It leans cautious: when in doubt articles stay separate.
- **Saved copies and a Library** — Lateral keeps a readable text copy of the articles you track (new episodes, and evidence found
  for predictions), so timelines survive dead links. Open the **Library** tab in the left panel (or press `l`) to browse and search
  the full text of everything saved; each article opens in the main panel and is linked to the tracked story or prediction it came
  from (you can relink it, or filter the list by story). **Save & link everything I already track** catches up on what you had
  before. Copies stay on your computer; turn the automatic saving off in Settings → Basic.
- **Track record** — when a prediction settles, record whether it happened. Lateral keeps score of whether the evidence balance
  leaned the right way (only clear leans count) and whether your own confidence was on the right side, with a Brier score. Treat it
  as an anecdote until you have ten or more.
- **Setup check and backups** — **Settings → Status** shows whether Ollama, your models, Tavily and news search are working, with the
  fix next to anything that isn't. The same screen exports your data to one file and restores it. API keys are never included.
- **Keyboard shortcuts** — `/` search, `h` home, `n` new story, `p` new prediction, `,` settings, `t` theme, `?` for the list.
- **Article images that actually load** — many news results arrive as opaque Google News links. Lateral resolves them to the real
  article, reads the page, recovers bot-blocked pages with Tavily, and runs every candidate past a small vision model so logos,
  tiny thumbnails and unrelated images are rejected. Anything left shows a clean fallback card.

## Requirements

- **Docker** with Compose v2
- **Ollama** running on the host, with these models:
  ```bash
  ollama pull qwen3:latest     # relevance filter, evidence scoring, query generation, image-fit judge
  ollama pull moondream        # image judge (optional — without it images are accepted unjudged)
  ollama pull nomic-embed-text # same-story grouping (optional — without it grouping relies on headline wording)
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
| `alerts.json` | Alert settings (including your delivery-channel addresses, so **treat it as secret**), the Activity inbox, and what has already been reported. Not part of the Settings → Status export. |
| `feeds.json` | The secret that protects your outgoing feeds, and the feeds you follow for each story. **Secret.** Not part of the Settings → Status export. |
| `archive/` | Saved copies of articles (one JSON file each, plus `index.json`). Not part of the Settings → Status export; copy this folder to back it up. |
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
| `LATERAL_DEDUPE_MODEL` | the relevance model | Judges whether two articles report the same story. |
| `LATERAL_EMBED_MODEL` | `nomic-embed-text` | Optional; proposes candidate duplicate pairs. |
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
| `POST /api/lateral/archive/save` · `/queue` · `/backfill` | Save an article's readable text now (`{"url": …}`), save several in the background, or queue everything already in your stories and predictions. |
| `GET /api/lateral/archive/search?q=` · `/list` · `/get?key=` · `/stats` | Full-text search of saved copies (quote a phrase to match it exactly), newest-first list, one saved article, counters. |
| `POST /v2/predictions/:id/group` · `POST /v2/links/:id/separate` | Run same-story grouping for a prediction in the background; or count one article on its own (`{"separate": true}`). Links in `GET /v2/links` carry a `group`, and the evidence reports `echoes` and `events`. |
| `GET /api/lateral/alerts/events` · `/unread` · `/status` | The Activity inbox, its unread count, and the engine's state. |
| `GET/POST /api/lateral/alerts/config` | Read or change alert settings (channel secrets are masked on the way out). |
| `POST /api/lateral/alerts/test` · `/digest` · `/check` · `/watch` | Send a test message, build or send the digest (`{"preview":true}` to look), run every detector now, or run the prediction watcher now. |
| `GET /api/lateral/feed/<secret>/activity.xml` · `/stories.xml` · `/story/<id>.xml` · `/lateral.opml` | The Atom feeds and OPML file. The secret is shown in Settings → Feeds. |
| `POST /api/lateral/feeds/preview` · `/subs` · `/subs/remove` · `/fetch` · `/opml` | Find a feed from an address, follow or unfollow one for a story, read a story's feeds now, or import OPML. `GET /feeds/info` and `POST /feeds/token/reset` manage the secret. |
| `GET /v2/calibration` | Track record across resolved predictions. Set an outcome with `PATCH /v2/predictions/:id` and `{"outcome":"yes"}`, `"no"` or `null` to reopen. |
| `GET /api/lateral/health/check` | Setup check: Ollama, models, Tavily key, news search, data folder. |
| `GET /api/lateral/backup` · `POST /api/lateral/restore` | Export your data as one JSON bundle, or restore one (`{"bundle": …, "dryRun": true}` previews without writing). |
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
- **"Save a copy" says the site blocks automated readers** — some publishers refuse plain requests. Lateral then tries Tavily
  Extract (shared with the image pipeline's daily cap); if that also fails, the article simply isn't saved. Video, audio and
  social pages are never saved as articles.
- **Images missing** — check `moondream` is installed and look at `/api/lateral/images/stats`. Articles with no usable image get the
  fallback card by design.

## What's new in v2.0

- Predictions with editable signals, background search-and-score with live progress, per-article overrides and re-scoring, an evidence
  balance, and share pages that include the tracked evidence.
- The relevance filter and its reviewable "Filtered out" lists (Home Discovery, story Headlines, Discover modal).
- The image pipeline: Google News link resolution, image validation, vision judging, Tavily Extract recovery, and a fallback card.
- Prediction outcomes with a track record, a Settings → Status setup check, data export/import, and keyboard shortcuts.
- A **Web search** tab in Settings to save and test the Tavily key.
- A standalone `docker-compose.yml` stack.

## License

Lateral is **source-available** under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).
You may use, modify and share it for personal, educational, research and other noncommercial purposes. Commercial use requires
separate permission from the copyright holder. See `LICENSE`.
