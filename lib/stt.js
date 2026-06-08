// Speech-to-text: sox recording, whisper-cpp or API transcription, LLM normalization.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { getSessionContext } from "./session.js";

let sttApiEndpoint = null;
let sttApiModel = null;
let sttApiKeyEnv = null;

const WAV_FILE = "/tmp/opencode-stt.wav";
const LOGS_DIR = path.join(os.homedir(), ".local", "share", "opencode-voice", "logs");
const LOG_FILE = path.join(LOGS_DIR, "stt.log");

const VERBOSE_LOGS = process.env.STT_VERBOSE_LOGS === "1";

function log(event, data = {}) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    fs.appendFileSync(LOG_FILE, entry);
  } catch {}
}

const MODELS_DIRS = [
  path.join(os.homedir(), ".local", "share", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];

const MODELS = {
  "large-v3-turbo-q5_0": {
    label: "Large v3 Turbo Q5 (recommended)",
    file: "ggml-large-v3-turbo-q5_0.bin",
  },
  "large-v3-turbo-q8_0": { label: "Large v3 Turbo Q8", file: "ggml-large-v3-turbo-q8_0.bin" },
  "large-v3-turbo": { label: "Large v3 Turbo (full)", file: "ggml-large-v3-turbo.bin" },
  "small.en": { label: "Small English", file: "ggml-small.en.bin" },
  small: { label: "Small Multilingual", file: "ggml-small.bin" },
  "base.en": { label: "Base English", file: "ggml-base.en.bin" },
  base: { label: "Base Multilingual", file: "ggml-base.bin" },
  "tiny.en": { label: "Tiny English (fastest)", file: "ggml-tiny.en.bin" },
  tiny: { label: "Tiny Multilingual (fastest)", file: "ggml-tiny.bin" },
};
const DEFAULT_MODEL = "large-v3-turbo-q5_0";

async function validateAndRepairWav(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 44) {
      return { valid: false, error: "Recording is empty - no audio captured" };
    }

    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);

    const riff = header.toString("ascii", 0, 4);
    const wave = header.toString("ascii", 8, 12);

    if (riff !== "RIFF" || wave !== "WAVE") {
      const fileSize = stat.size;
      log("wav_corrupt_detected", {
        file: filePath,
        size: fileSize,
        riff,
        wave,
        headerHex: header.subarray(0, 16).toString("hex"),
      });

      const newHeader = Buffer.alloc(44);
      newHeader.write("RIFF", 0);
      newHeader.writeUInt32LE(fileSize - 8, 4);
      newHeader.write("WAVE", 8);
      newHeader.write("fmt ", 12);
      newHeader.writeUInt32LE(16, 16);
      newHeader.writeUInt16LE(1, 20);
      newHeader.writeUInt16LE(1, 22);
      newHeader.writeUInt32LE(16000, 24);
      newHeader.writeUInt32LE(32000, 28);
      newHeader.writeUInt16LE(2, 32);
      newHeader.writeUInt16LE(16, 34);
      newHeader.write("data", 36);
      newHeader.writeUInt32LE(fileSize - 44, 40);

      const data = fs.readFileSync(filePath);
      const audioData = data.subarray(44);
      const repaired = Buffer.concat([newHeader, audioData]);
      fs.writeFileSync(filePath, repaired);

      log("wav_repaired", { originalSize: fileSize, repairedSize: repaired.length });
      return { valid: true, repaired: true };
    }

    const declaredSize = header.readUInt32LE(4);
    const actualSize = stat.size;
    if (declaredSize === 0 || declaredSize > actualSize * 2) {
      log("wav_header_size_mismatch", { declaredSize, actualSize });
      return { valid: false, error: "WAV header corrupted - impossible to repair" };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: `WAV validation failed: ${err.message}` };
  }
}

function getModelsDir() {
  for (const dir of MODELS_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return MODELS_DIRS[0];
}

function listInputDevices() {
  try {
    const out = execSync(
      "pactl list short sources 2>/dev/null | grep -v 'monitor' | awk '{print $2}'",
      { encoding: "utf-8", timeout: 5000 },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch {}
  try {
    const json = execSync("system_profiler SPAudioDataType -json 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const data = JSON.parse(json);
    return (data.SPAudioDataType?.[0]?._items || [])
      .filter((d) => d.coreaudio_input_source != null)
      .map((d) => d.coreaudio_device_name || d._name);
  } catch {
    return [];
  }
}

// ---- Recording state and control ----

let soxProc = null;
let soxStderr = "";
let recording = false;
let processing = false;
let recordingTimer = null;
let recordingInterval = null;
let recordingStartTime = null;
const MAX_RECORDING_SECONDS = 60;

function forceKillSox() {
  if (soxProc) {
    try {
      process.kill(soxProc.pid, "SIGKILL");
    } catch {}
    soxProc = null;
  }
  try {
    execSync("pkill -9 -f 'sox.*opencode-stt'", { stdio: "ignore" });
  } catch {}
}

function startRecording(kv, toast, complete, client, api, systemPrompt) {
  if (soxProc) return;

  forceKillSox();
  try {
    fs.unlinkSync(WAV_FILE);
  } catch {}

  soxStderr = "";
  const mic = kv.get("stt.mic", "") || null;
  let inputArgs;
  if (mic) {
    inputArgs = os.platform() === "darwin" ? ["-t", "coreaudio", mic] : ["-t", "pulse", mic];
  } else {
    inputArgs = ["-d"];
  }

  const silenceThreshold = kv.get("stt.silence.threshold", ".1%");
  const silenceStartDelay = kv.get("stt.silence.startDelay", "0.05");
  const silenceStopDuration = kv.get("stt.silence.stopDuration", "60:00"); // 60 min - never stops due to silence

  soxProc = spawn(
    "sox",
    [
      ...inputArgs,
      "-r",
      "16000",
      "-c",
      "1",
      "-b",
      "16",
      WAV_FILE,
      "silence",
      "1",
      silenceStartDelay,
      silenceThreshold,
      "1",
      silenceStopDuration,
      silenceThreshold,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    },
  );

  log("recording_start", { mic: mic || "default", silenceThreshold });

  recordingStartTime = Date.now();
  let blink = true;
  recordingInterval = setInterval(() => {
    const seconds = Math.floor((Date.now() - recordingStartTime) / 1000);
    const dot = blink ? "🔴" : "⚫";
    toast(`${dot} Recording... ${seconds}s`, "info", 10000);
    blink = !blink;
  }, 1000);

  recordingTimer = setTimeout(() => {
    if (recording && !processing) {
      toast(`Max duration (${MAX_RECORDING_SECONDS}s), transcribing...`);
      doTranscribePipeline(kv, complete, client, api, toast, systemPrompt);
    }
  }, MAX_RECORDING_SECONDS * 1000);

  soxProc.stderr.on("data", (chunk) => {
    soxStderr += chunk.toString();
  });

  soxProc.on("error", (err) => {
    soxProc = null;
    clearTimeout(recordingTimer);
    clearInterval(recordingInterval);
    if (recording) {
      recording = false;
      toast(`Recording failed: ${err.message}`, "error");
    }
  });

  soxProc.on("exit", (code) => {
    soxProc = null;
    clearTimeout(recordingTimer);
    clearInterval(recordingInterval);
    if (recording && code !== 0 && code !== null && !processing) {
      recording = false;
      const errLine = soxStderr.trim().split("\n").pop();
      toast(`Recording error: ${errLine || `sox exited (code=${code})`}`, "error");
    }
  });

  recording = true;
}

function stopRecording() {
  clearTimeout(recordingTimer);
  clearInterval(recordingInterval);
  if (soxProc) soxProc.kill("SIGINT");
}

async function waitForSoxExit(timeoutMs = 2000) {
  const start = Date.now();
  while (soxProc && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (soxProc) forceKillSox();
}

function getModelName(kv) {
  const model = kv.get("stt.model", DEFAULT_MODEL);
  return MODELS[model] ? model : DEFAULT_MODEL;
}

function getModelPath(kv) {
  return path.join(getModelsDir(), MODELS[getModelName(kv)].file);
}

async function transcribe(kv) {
  const mp = getModelPath(kv);
  if (!fs.existsSync(mp)) {
    return Promise.resolve({
      error: `Model not found: ${getModelName(kv)}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!fs.existsSync(WAV_FILE)) {
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }

  const validation = await validateAndRepairWav(WAV_FILE);
  if (!validation.valid) {
    return Promise.resolve({ error: validation.error });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("whisper-cli", ["-m", mp, "-f", WAV_FILE, "-np", "-nt"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ error: "Transcription timed out (60s)" });
    }, 60000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ error: stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})` });
        return;
      }
      resolve({
        text: stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    });
  });
}

const STT_SYSTEM_PROMPT = `# IDIOMA OBLIGATORIO: ESPAÑOL ARGENTINO

El usuario habla español rioplatense (argentino). SIEMPRE devolvés texto en español. Esto NO es negociable.

Si ves palabras sueltas en inglés en la transcripción cruda, ASUMÍ que son términos técnicos dentro de una frase en español. Ejemplos:
- ❌ MAL: "I need to deploy the endpoint" → ✅ BIEN: "necesito hacer el deploy del endpoint"
- ❌ MAL: "check the logs" → ✅ BIEN: "revisá los logs"
- ❌ MAL: "the JSON response" → ✅ BIEN: "la respuesta JSON"

Code-switching natural está OK (mezclar inglés técnico en frases españolas), pero la BASE siempre es español. Si la transcripción entera sale en inglés, algo salió mal — corrigelo al español.

---

# TU TAREA

Limpiar la transcripción cruda de speech-to-text en texto plano bien puntuado. Nada más.

NO imites el estilo o formato del contexto de conversación.
NO generes markdown (##, -, *, listas).
NO agregues contenido que no estaba en el audio.
NO continúes la conversación ni respondas preguntas del contexto.
SOLO devolvé la transcripción limpia.

---

# REGLAS DE LIMPIEZA

- Arreglá puntuación, mayúsculas y gramática
- Sacá muletillas (este, um, eh, como que, etc.)
- Mantené términos técnicos, nombres de archivos y referencias de código tal cual

---

# CORRECCIONES DE HOMÓFONOS TÉCNICOS

Arreglá estos errores comunes del STT:
- "locks" → "logs" (salvo que hable de mutexes/concurrencia)
- "note" / "no" → "node"
- "app and" → "append"
- "sink" → "sync", "a sink" → "async"
- "doc" / "talker" → "docker"
- "cash" → "cache"
- "rap" → "wrap"
- "Jason" → "JSON"
- "get" → "Git"
- "types creep" / "type script" → "TypeScript"
- "bullion" → "boolean"`;

async function normalizeTranscription(
  complete,
  rawText,
  contextObj,
  systemPrompt,
  maxContextChars = 40000,
) {
  const system = systemPrompt;
  const contextText = contextObj?.text
    ? `\n\nCONTEXTO DE LA CONVERSACIÓN (solo para desambiguar, NO para responder):\n${contextObj.text}`
    : "";
  const prompt = `TRANSCRIPCIÓN CRUDA A LIMPIAR:\n\n${rawText}${contextText}\n\nRESPONDER ÚNICAMENTE CON EL TEXTO LIMPIO. SIN EXPLICACIONES. SIN MARKDOWN.`;

  if (VERBOSE_LOGS) {
    log("normalize_request", {
      inputChars: rawText.length,
      input: rawText,
      contextChars: contextObj?.text?.length || 0,
      contextMessagesCount: contextObj?.messages?.length || 0,
      contextMaxChars: maxContextChars,
      contextPreview: contextObj?.text?.substring(0, 200) || "",
      system,
    });
  } else {
    log("normalize_request", {
      inputChars: rawText.length,
      contextChars: contextObj?.text?.length || 0,
      contextMessagesCount: contextObj?.messages?.length || 0,
    });
  }

  const result = await complete({
    system,
    prompt,
    contextMessages: [],
  });

  if (VERBOSE_LOGS) {
    log("normalize_response", { chars: result.length, output: result });
  } else {
    log("normalize_response", { chars: result.length });
  }
  return result;
}

async function getApiModels() {
  if (!sttApiEndpoint) return [];
  try {
    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}models`
      : `${sttApiEndpoint}/models`;
    const headers = {};
    if (sttApiKeyEnv && process.env[sttApiKeyEnv]) {
      headers["Authorization"] = "Bearer " + process.env[sttApiKeyEnv];
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data || [])
      .filter((m) => m.id && /whisper/i.test(m.id))
      .map((m) => ({ value: m.id, label: m.id }));
  } catch {
    return [];
  }
}

async function transcribeApi(kv, _context) {
  if (!sttApiEndpoint || !sttApiModel) {
    return { error: "STT API not configured" };
  }
  const model = kv.get("stt.api.model") || sttApiModel;

  if (!fs.existsSync(WAV_FILE)) {
    return { error: "No recording file - sox may have failed to capture audio" };
  }

  const validation = await validateAndRepairWav(WAV_FILE);
  if (!validation.valid) {
    return { error: validation.error };
  }

  try {
    const audioBuffer = await fs.promises.readFile(WAV_FILE);
    const blob = new Blob([audioBuffer], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, "audio.wav");
    form.append("model", model);
    form.append("response_format", "json");
    form.append("language", "es");
    form.append(
      "prompt",
      "Transcribir en español rioplatense. Mantener términos técnicos de programación tal cual (deploy, endpoint, test, JSON, API). Si el hablante mezcla inglés técnico dentro de frases en español, respetar esa mezcla pero la base siempre es español.",
    );

    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}audio/transcriptions`
      : `${sttApiEndpoint}/audio/transcriptions`;

    const headers = {};
    if (sttApiKeyEnv) {
      const apiKey = process.env[sttApiKeyEnv];
      if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    }

    if (VERBOSE_LOGS) {
      log("stt_request", {
        model,
        audioBytes: audioBuffer.length,
        hasDomainPrompt: true,
        sttApiKeyEnv,
        hasAuthHeader: !!headers["Authorization"],
        authHeaderPreview: headers["Authorization"]
          ? `${headers["Authorization"].substring(0, 15)}...`
          : null,
      });
    } else {
      log("stt_request", { model, audioBytes: audioBuffer.length });
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      let msg = `STT API error ${resp.status}`;
      try {
        const err = JSON.parse(body);
        msg = err?.error?.message || msg;
      } catch {}
      log("stt_error", { status: resp.status, message: msg });
      return { error: msg };
    }

    const data = await resp.json();
    const text = data.text?.trim() || "";
    if (VERBOSE_LOGS) {
      log("stt_response", { chars: text.length, text });
    } else {
      log("stt_response", { chars: text.length });
    }
    return { text };
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { error: "STT API request timed out (60s)" };
    }
    return { error: `STT API request failed: ${err.message}` };
  }
}

async function doTranscribePipeline(kv, complete, client, api, toast, systemPrompt) {
  processing = true;
  clearTimeout(recordingTimer);
  clearInterval(recordingInterval);
  try {
    stopRecording();
    await waitForSoxExit();

    const maxContextChars = parseInt(kv.get("stt.context.maxChars", "40000"), 10) || 40000;
    const context = await getSessionContext(client, api, maxContextChars);

    toast("Transcribing...");
    const whisperPrompt = context.text.length > 750 ? context.text.substring(0, 750) : context.text;
    const result = sttApiEndpoint ? await transcribeApi(kv, whisperPrompt) : await transcribe(kv);

    if (result.error) {
      toast(result.error, "error");
      return;
    }
    if (!result.text) {
      toast("No speech detected", "warning");
      return;
    }

    toast("Normalizing...");
    const llmResult = await normalizeTranscription(
      complete,
      result.text,
      context,
      systemPrompt,
      maxContextChars,
    );

    if (!llmResult.text) {
      toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
      if (VERBOSE_LOGS) {
        log("prompt_appended", { source: "raw", text: result.text });
      } else {
        log("prompt_appended", { source: "raw", chars: result.text.length });
      }
      await client.tui.appendPrompt({ text: result.text });
      return;
    }

    if (VERBOSE_LOGS) {
      log("prompt_appended", { source: "normalized", text: llmResult.text });
    } else {
      log("prompt_appended", { source: "normalized", chars: llmResult.text.length });
    }
    await client.tui.appendPrompt({ text: llmResult.text });
    toast("Transcription added to prompt", "success");
  } catch (err) {
    log("pipeline_error", { message: err.message });
    toast(`STT error: ${err.message}`, "error");
  } finally {
    processing = false;
    recording = false;
    clearTimeout(recordingTimer);
    clearInterval(recordingInterval);
  }
}

// ---- Public API for TUI plugin ----

export function registerSTT(api, kv, complete, prompts, opts) {
  const client = api.client;
  const systemPrompt = prompts?.stt || STT_SYSTEM_PROMPT;
  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  if (opts?.sttEndpoint) {
    sttApiEndpoint = opts.sttEndpoint;
    sttApiModel = opts.sttModel || "whisper-large-v3-turbo";
    sttApiKeyEnv = opts.sttApiKeyEnv || null;
    log("init", { sttApiKeyEnv, hasKey: !!process.env[sttApiKeyEnv] });
  }

  return [
    {
      title: sttApiEndpoint ? "STT: record/transcribe (API)" : "STT: record/transcribe",
      value: "stt.record",
      description: sttApiEndpoint
        ? "Toggle recording; press again to stop and transcribe via API"
        : "Toggle recording; press again to stop and transcribe",
      keybind: "f5",
      slash: { name: "stt-record" },
      onSelect() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (recording) {
          toast("Stopping, transcribing...");
          doTranscribePipeline(kv, complete, client, api, toast, systemPrompt);
        } else {
          startRecording(kv, toast, complete, client, api, systemPrompt);
          if (recording) toast("Recording... press again to transcribe");
        }
      },
    },
    {
      title: "STT: cancel recording",
      value: "stt.stop",
      description: "Cancel current recording",
      slash: { name: "stt-stop" },
      onSelect() {
        if (recording) {
          recording = false;
          clearTimeout(recordingTimer);
          clearInterval(recordingInterval);
          forceKillSox();
          toast("Recording cancelled");
        }
      },
    },
    {
      title: sttApiEndpoint ? "STT: select model (API)" : "STT: select model",
      value: "stt.model",
      description: sttApiEndpoint ? "Choose whisper model via API" : "Choose whisper model",
      slash: { name: "stt-model" },
      async onSelect() {
        if (sttApiEndpoint) {
          const current = kv.get("stt.api.model") || sttApiModel;
          const apiModels = await getApiModels();
          const options = apiModels.length > 0 ? apiModels : [{ value: current, label: current }];
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select whisper model (API)",
              current,
              options: options.map((m) => ({
                title: m.label,
                value: m.value,
                onSelect() {
                  kv.set("stt.api.model", m.value);
                  toast(`Whisper API model: ${m.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        } else {
          const current = getModelName(kv);
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select whisper model",
              current,
              options: Object.entries(MODELS).map(([key, v]) => ({
                title: v.label,
                value: key,
                onSelect() {
                  kv.set("stt.model", key);
                  toast(`Whisper model: ${v.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        }
      },
    },
    {
      title: "STT: select microphone",
      value: "stt.mic",
      description: "Choose audio input device",
      slash: { name: "stt-mic" },
      onSelect() {
        const current = kv.get("stt.mic", "");
        const devices = listInputDevices();
        if (devices.length === 0) {
          toast("No input devices found");
          return;
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select microphone",
            current,
            options: [
              {
                title: "System default",
                value: "",
                onSelect() {
                  kv.set("stt.mic", "");
                  toast("Mic: system default");
                  api.ui.dialog.clear();
                },
              },
              ...devices.map((name) => ({
                title: name,
                value: name,
                onSelect() {
                  kv.set("stt.mic", name);
                  toast(`Mic: ${name}`);
                  api.ui.dialog.clear();
                },
              })),
            ],
          }),
        );
      },
    },
  ];
}
