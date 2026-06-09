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
import { registerSTT } from "./lib/stt.js";
import { registerTTS } from "./lib/tts.js";
import { createClient } from "./lib/llm-client.js";
import { interceptAndInjectAudios } from "./lib/passthrough.js";

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
  tui: async (api, options) => {
    const { kv } = api;
    const { complete } = createClient(options);

    const prompts = {
      stt: loadPromptFile(options?.sttPrompt),
      ttsAuto: loadPromptFile(options?.ttsAutoPrompt),
      ttsManual: loadPromptFile(options?.ttsManualPrompt),
    };

    const sttCommands = registerSTT(api, kv, complete, prompts, options);
    const ttsCommands = registerTTS(api, kv, complete, prompts);

    api.command.register(() => [...sttCommands, ...ttsCommands]);
  },

  "chat.message": async ({ sessionID }, { message, parts }) => {
    if (!parts || !Array.isArray(parts)) return;

    for (const part of parts) {
      if (part.type === "text" && part.text) {
        part.text = interceptAndInjectAudios(sessionID, part.text, parts);
      }
    }
  },

  "chat.params": async ({ sessionID, model }, _output) => {
    // Cache the active hot model from the session so F5 recording can use it.
    // client.config.get() returns the default config model, not the session-selected one.
    // This hook fires on every send with the actual model being used.
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");

      const modelId = model?.id || model?.modelID || (typeof model === "string" ? model : null);
      if (!modelId) return;

      const cacheDir = path.join(os.homedir(), ".local", "share", "opencode-voice", "cache");
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "active-model.json"), JSON.stringify({ modelId, sessionID, ts: new Date().toISOString() }));

      const logDir = path.join(os.homedir(), ".local", "share", "opencode-voice", "logs");
      const logFile = path.join(logDir, "stt.log");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "chat_params_model_cached",
        sessionID,
        modelId,
      }) + "\n");
    } catch {}
  },
};
