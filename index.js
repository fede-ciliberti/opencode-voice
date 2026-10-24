// opencode-voice: Speech-to-text and text-to-speech for OpenCode.
//
// STT: Record voice via sox, transcribe with whisper-cpp, normalize with
//      an OpenAI-compatible LLM, append to the TUI prompt.
//
// TTS: Auto-speak assistant responses (or read on demand) via Piper,
//      with LLM normalization for natural speech.
//
// Prerequisites:
//   STT: brew install whisper-cpp sox
//   TTS: Piper binary at ~/.local/bin/piper, voice models at ~/.local/share/piper-voices/
//
// Configuration via tui.json plugin options:
//   ["opencode-voice", { "endpoint": "...", "model": "...", "apiKeyEnv": "..." }]
//
// Runtime state (model, mic, voice, tts mode) persisted via api.kv.
//
// Commands:
//   /stt-record (f5) - start/stop recording + transcribe
//   /stt-stop            - cancel recording
//   /stt-model           - select whisper model
//   /stt-mic             - select microphone
//   /tts-speak (leader+s)- read last response aloud
//   /tts-mode (leader+v) - toggle auto TTS on/off
//   /tts-stop (escape)   - stop playback
//   /tts-voice           - select TTS voice

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSTT } from "./lib/stt.js";
import { registerTTS } from "./lib/tts.js";
import { createClient } from "./lib/llm-client.js";

const LOGS_DIR = path.join(os.homedir(), ".local", "share", "opencode-voice", "logs");
const LOG_FILE = path.join(LOGS_DIR, "stt.log");

function hookLog(event, data = {}) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    fs.appendFileSync(LOG_FILE, entry);
  } catch {}
}

function loadPromptFile(filePath) {
  if (!filePath) return null;
  const resolved = filePath.replace(/^~(?=\/|$)/, os.homedir());
  try {
    return fs.readFileSync(resolved, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export default {
  id: "opencode-voice",
  // V1: OpenCode llama `tui(api, options)`. El entrypoint V2 vive en ./tui (v2/cli.js).
  tui: async (api, options) => {
    const { kv } = api;
    const { complete } = createClient(options);

    hookLog("plugin_tui_initialized", { hasKv: !!kv, hasComplete: !!complete });

    const prompts = {
      stt: loadPromptFile(options?.sttPrompt),
      ttsAuto: loadPromptFile(options?.ttsAutoPrompt),
      ttsManual: loadPromptFile(options?.ttsManualPrompt),
    };

    const sttCommands = registerSTT(api, kv, complete, prompts, options);
    const ttsCommands = registerTTS(api, kv, complete, prompts);

    api.command.register(() => [...sttCommands, ...ttsCommands]);

    hookLog("plugin_commands_registered", {
      commandCount: sttCommands.length + ttsCommands.length,
    });
  },
};
