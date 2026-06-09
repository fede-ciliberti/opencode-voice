# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single TUI plugin exported from `index.js` with logic split into `lib/`.

### Module layout

| File | Purpose |
|---|---|
| `index.js` | Entry point, wires STT + TTS commands |
| `lib/stt.js` | Recording, whisper transcription, LLM normalization, pipeline orchestration |
| `lib/passthrough.js` | Audio passthrough: model detection + send WAV as FilePartInput |
| `lib/tts.js` | Piper TTS playback |
| `lib/llm-client.js` | OpenAI-compatible client for text normalization |
| `lib/session.js` | Session context helpers |

## Key invariants

- Single default export: `{ id, tui }`. No server-side plugin.
- LLM calls use the OpenAI chat completions API, not the Anthropic messages API.
- Configuration uses `options` (static) and `api.kv` (runtime). No dotfile I/O.
- No build step. Plain ESM JavaScript, shipped as-is.
- **STT modes** persisted via `api.kv` key `stt.mode`: `auto` (default, detect from model), `whisper-local`, `whisper-api`, `passthrough`.
- **Audio passthrough** uses `audio/wav` MIME type via `FilePartInput` — NOT `video/mp4`.
- **Model detection** reads `modalities.input` from `client.config.providers()` — never hardcodes model names.

## Scripts

```bash
npm run test         # node --test
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, test, build). See
RELEASE_PROCESS.md for release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
