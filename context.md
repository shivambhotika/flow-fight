# Flow Fight · Product and Engineering Context

This file is the shared source of truth for product decisions, architecture, and change history. Keep it current whenever the game changes so another agent or platform can understand the project without reconstructing prior work.

## Product goal

Flow Fight is a Wispr Flow activation game that lets one person compare how much they can produce by typing for 60 seconds versus speaking for 60 seconds. The intended takeaway is personal and immediate: the player sees their own “voice lift,” not a head-to-head outcome against another participant.

## Current experience

1. The landing screen explains the solo challenge and shows the shared top-score leaderboard.
2. The player starts the solo challenge; there is no game-mode selection screen.
3. The player enters a name by either:
   - using push-to-talk, transcribed through OpenAI's Audio Transcriptions API, or
   - typing any name directly.
4. Round 1 is a 60-second keyboard challenge.
5. A 10-second transition gives the player time to switch input methods.
6. Round 2 is a 60-second voice challenge designed for Wispr Flow dictation into the focused voice box.
7. Results compare typed words with spoken words and show the player's voice multiplier.
8. The shared leaderboard is updated, then the app resets for the next player.

The historical WPM Fight and Voice vs Keyboard modes, the preloaded attendee-name list, and company capture have been removed from the player experience.

## Architecture

- Frontend: static HTML, CSS, and browser JavaScript in `public/`.
- Server: Node.js 20+, Express, and WebSockets in `server.js`.
- Hosting: Render web service (`render.yaml`). Vercel config remains for compatibility, but Render is the deployed production surface.
- Data: JSON files under `data/` for prompts, runs, config, and leaderboard.
- Challenge content: 20 original, clean rap-style micro-verses with dense alliteration and internal rhyme. Every playable line is punctuation-free so typing and speech rounds use the same simple word sequence. No copyrighted artist lyrics are stored.
- Brand asset: the landing header and browser tab use the supplied Wispr logo stored at `public/wisprlogo.png` rather than the former text-based placeholder mark.
- Speech-to-text: server-side call to `POST /v1/audio/transcriptions`, defaulting to the currently recommended file-transcription model, `gpt-transcribe`.

### Independent multi-device sessions

Every browser tab creates a random ID stored in `sessionStorage`. The server keeps a separate runtime keyed by that ID. Game state, countdowns, timers, rounds, and results are sent only to the owning WebSocket. Players on two or more devices can therefore start and play at the same time without seeing or changing one another's game.

Only leaderboard data is shared. Disconnected sessions are held for 30 minutes so a short WebSocket reconnect can resume the same run, then cleaned up to avoid memory leaks.

This is sufficient on one Render instance and does not require changing hosting for the expected two-device use case. If the service is scaled to multiple Node instances later, move runtime state to Redis (including timer/phase state) and durable results to Postgres, then use pub/sub for leaderboard/display events. Sticky WebSocket routing alone is not enough for failover.

### Push-to-talk security and privacy

- Browser audio is recorded only after the player grants microphone access.
- Audio is posted to `/api/transcribe-name` on the same origin.
- `OPENAI_API_KEY` stays on the server and is never sent to the browser.
- The endpoint limits recordings to 4 MB and 12 attempts per IP per minute.
- The game does not write name audio to disk; it forwards the in-memory recording for transcription and returns text.
- When the API key, microphone, or transcription service is unavailable, typed name entry remains usable.

Required production variables:

```text
OPENAI_API_KEY=<secret server-side key>
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
```

## Operational notes

- Render supports the required WebSocket connection. A different platform is not necessary for independent play on two devices.
- The current JSON persistence is acceptable for a single small event instance. Render filesystems may be ephemeral depending on service configuration, so use Postgres before treating leaderboard/run history as durable business data.
- `GET /api/status` exposes active-player and active-session counts plus whether speech entry is configured.
- `POST /api/reset` resets all active player sessions; `Ctrl+Shift+R` resets only the current browser session through its WebSocket.
- A real OpenAI key is intentionally not committed. Configure it in Render's environment settings.

## Change history

### 2026-08-08 · Wispr logo and punctuation-free prompts

- Replaced the circular “W” placeholder in the landing-page brand lockup with the supplied Wispr logo asset and reused it as the browser-tab icon.
- Removed commas, semicolons, periods, and all other punctuation from every playable prompt used in both typing and speaking rounds.
- Added smoke-test coverage that prevents punctuation from being reintroduced into playable prompt text and catches a missing logo asset.

### 2026-08-05 · Rap challenge, speech upgrade, and pacing

- Replaced every playable prompt with a repository of 20 original, clean, challenging rap-style micro-verses. The content evokes rhythmic wordplay without copying Eminem, Drake, or any other artist's lyrics.
- Increased the between-round transition from 5 seconds to 10 seconds and made it configurable in event settings.
- Updated push-to-talk transcription to OpenAI's recommended `gpt-transcribe` model and current `languages[]` request format, while preserving the environment-variable override.
- Added automated smoke coverage for production configuration, the challenge repository, and simultaneous independent sessions on two devices.
- Removed unused legacy name-list, multiplayer client, and superseded stylesheet files so deleted modes cannot drift back into the active build.
- Kept the API key server-side only; it is configured as a private Render environment variable and is never committed to Git.

### 2026-08-04 · Solo-first multi-device rebuild

- Reworked the landing screen into a structured Wispr-branded solo challenge introduction with a clear CTA, two-round explanation, and shared leaderboard.
- Removed WPM Fight and Voice vs Keyboard from config, server mode definitions, client mode metadata, and navigation.
- Removed the attendee-name list, fuzzy matching, browser-native speech recognition, and company field.
- Added free-form typed name entry.
- Added OpenAI-powered push-to-talk name transcription through a private server endpoint using `gpt-4o-mini-transcribe` by default.
- Replaced the single global game session with isolated per-browser runtimes, fixing simultaneous independent play across devices.
- Simplified solo countdown and score UI so opponent elements are hidden.
- Added responsive layouts for tablets, phones, laptops, and short kiosk screens.
- Added Node 20 runtime requirements, Render environment-variable declarations, and `.env` protection.
