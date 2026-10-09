# Library narration and For You — 2026-10-08

Saved articles have an on-demand local narration panel, defaulting to HermesVoice through the existing Chatterbox Turbo service. Samara is also selectable. Browser read-aloud remains available, with a device voice picker that prefers Google English if supplied by the browser.

Generation is explicit and asynchronous: one article at a time, eight queued articles maximum, 380-character sections, 60,000-character input limit, 256 MB output limit. Completed sections survive failures/restarts for retry; identical article text/title/byline/voice reuses finished audio. A revision or changed voice gets a separate cache. No article website is fetched for narration. The current service runs on CPU. Initial model loading can take several minutes, and long articles take longer to generate. Cancellation stops subsequent sections and discards the active result once its existing synthesis finishes, since Chatterbox has no inference-cancel endpoint.

Finished WAV audio supports seeking via byte ranges, normal play/pause, speed controls, download, and the existing floating player for listening while browsing. Deleting the saved article removes its audio variants too. Narration data is stored under `<LATERAL_DATA_DIR>/article-audio/` alongside saved copies. Existing application access rules also apply to generated audio.

Configuration: `LATERAL_TTS_URL` defaults to `http://chatterbox-tts:8880` on the existing Docker network; `LATERAL_TTS_VOICE` defaults to `HermesVoice`. The standalone compose stack should set `LATERAL_TTS_URL=http://host.docker.internal:8883` to reach a host-published Chatterbox instance. The browser only uses the same-origin `/api/lateral/article-audio/` API and never receives the internal service address.

Routes: GET `voices`; GET `status?key=&voice=`; POST `generate` and `cancel` with `{key,voice}`; GET/HEAD `file?id=`. Voices and saved article keys are validated. Status responses do not trigger synthesis. Failed or interrupted work can be retried from its completed sections.

For You offers up to three saved articles, prioritizing active-story connections, then ready Hermes narration, with a deterministic daily rotation and publisher variety. The explanation states whether a piece is connected to a followed story or is simply a saved piece to return to. This is not unread tracking or AI ranking. Read opens the saved copy; ready audio plays in the floating player; other Listen actions open the narration panel without automatically generating.

The service-worker cache version changes and HTML navigations prefer the network, retaining an offline fallback. Browser tests cover public For You → Library, Hermes controls, progress and mobile layout. Isolated backend checks cover chunking, WAV stitching, deduplication, retries, cancellation, voice validation, text-change invalidation, range requests, article deletion, and Library picks. A real 121-word saved article generated 60 seconds of Hermes audio; public byte-range seeking, cached replay, and desktop playback controls passed separately from the synthetic fixture.

