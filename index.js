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
import { interceptAndInjectAudios } from "./lib/passthrough.js";

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
    hookLog("hook_chat_message_called", {
      sessionID,
      hasMessage: !!message,
      partsCount: parts?.length || 0,
      partsTypes: parts?.map(p => p.type) || [],
    });

    if (!parts || !Array.isArray(parts)) {
      hookLog("hook_chat_message_no_parts");
      return;
    }

    for (const part of parts) {
      if (part.type === "text" && part.text) {
        hookLog("hook_processing_text_part", { textLength: part.text.length, textPreview: part.text.substring(0, 100) });
        const originalText = part.text;
        part.text = interceptAndInjectAudios(sessionID, part.text, parts);
        if (originalText !== part.text) {
          hookLog("hook_text_modified", { originalLength: originalText.length, newLength: part.text.length });
        }
      }
    }
  },
};
