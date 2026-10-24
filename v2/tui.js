// Setup V2 (CLI plugin). Lo consume el default export de index.js como `setup`.
//
// Reutiliza lib/stt.js y lib/tts.js a través de v2/adapter.js. La normalización
// LLM es configurable (normalize on/off + modelo propio).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "./adapter.js";
import { createComplete } from "./normalize.js";
import { createKeybindings } from "./keybinds.js";
import { registerSTT } from "../lib/stt.js";
import { registerTTS } from "../lib/tts.js";

const LOGS_DIR = path.join(os.homedir(), ".local", "share", "opencode-voice", "logs");
const LOG_FILE = path.join(LOGS_DIR, "v2.log");

function log(event, data = {}) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n",
    );
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

// Comandos sin keybind propio (antes solo accesibles por slash): les damos un
// atajo leader hasta cablear slash/palette.
// Ojo: estos atajos pisan el keymap de OpenCode (el handler se engancha con
// prependListener). <leader>m se dejó libre a propósito: es `model.list` del TUI
// y el selector de modelo STT quedó solo accesible por `/stt-model`.
const EXTRA_BINDS = {
  "stt.mic": "<leader>i",
  "stt.glossary": "<leader>g",
  "tts.voice": "<leader>o",
};

export function setupV2(context) {
  // El server también carga este entrypoint (sin renderer). Sólo el CLI/TUI
  // tiene renderer; en el server no hay nada que hacer.
  if (!context?.renderer) {
    log("setup.skip.no_renderer", { keys: Object.keys(context ?? {}) });
    return;
  }
  const options = (context.options ?? {}) || {};
  log("setup", { options: Object.keys(options) });

  const adapter = createAdapter(context, log);
  const { complete } = createComplete(options, log);

  const prompts = {
    stt: loadPromptFile(options.sttPrompt),
    ttsAuto: loadPromptFile(options.ttsAutoPrompt),
    ttsManual: loadPromptFile(options.ttsManualPrompt),
  };

  const sttCommands = registerSTT(adapter.api, adapter.kv, complete, prompts, options);
  const ttsCommands = registerTTS(adapter.api, adapter.kv, complete, prompts);

  const commands = [...sttCommands, ...ttsCommands].map((c) => {
    const extra = EXTRA_BINDS[c.value];
    if (extra && !c.keybind) return { ...c, keybind: extra };
    return c;
  });

  // "escape" se omite: interceptarlo globalmente rompe el TUI.
  // "stt.passthrough" se omite: no soportado en V2 (attachments descartan audio).
  const wired = commands.filter(
    (c) => c.keybind && c.keybind !== "escape" && c.value !== "stt.passthrough",
  );

  const dispose = createKeybindings(context, wired, log);
  log("setup.done", { commands: commands.map((c) => c.value), wired: wired.length });

  return () => {
    log("dispose");
    dispose();
  };
}
