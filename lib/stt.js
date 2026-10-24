// Speech-to-text: sox recording, whisper-cpp or API transcription, LLM normalization.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { saveAudioToQueue, cleanStaleAudioQueue, modelSupportsAudio } from "./passthrough.js";
import { getSessionContext } from "./session.js";
import {
  loadGlossary,
  getGlossaryPath,
  formatGlossaryForPrompt,
  parseGeneratedJson,
  mergeGlossary,
  saveGlossary,
} from "./glossary.js";

let sttApiEndpoint = null;
let sttApiModel = null;
let sttApiKeyEnv = null;

const WAV_FILE = `/tmp/opencode-stt-${process.pid}.wav`;
let currentWavFile = null;
const LOGS_DIR = path.join(os.homedir(), ".local", "share", "opencode-voice", "logs");
const LOG_FILE = path.join(LOGS_DIR, "stt.log");

const VERBOSE_LOGS = process.env.STT_VERBOSE_LOGS === "1";

function log(event, data = {}) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {}
    const entry =
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n";
    fs.appendFileSync(LOG_FILE, entry);
  } catch {}
}

function newWavFile() {
  const nonce = Math.random().toString(36).slice(2, 7);
  return `/tmp/opencode-stt-${process.pid}-${Date.now()}-${nonce}.wav`;
}

function cleanStaleWav() {
  try {
    for (const f of fs.readdirSync("/tmp")) {
      if (!/^opencode-stt-\d+/.test(f)) continue;
      // Match both legacy `opencode-stt-PID.wav` and new `opencode-stt-PID-TIMESTAMP-NONCE.wav`
      const match = f.match(/^opencode-stt-(\d+)(?:-\d+-[a-z0-9]+)?\.wav$/);
      if (!match) continue;
      const filePath = path.join("/tmp", f);
      // Never delete the file of the active recording
      if (currentWavFile && filePath === currentWavFile) continue;
      // Age-based cleanup: always remove files older than 24h
      try {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
          log("stale_wav_cleaned", { file: f, reason: "age>24h" });
          continue;
        }
      } catch {}
      const pid = Number(match[1]);
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (e) {
        if (e.code === "EPERM") continue;
      }
      try {
        fs.unlinkSync(filePath);
        log("stale_wav_cleaned", { file: f, reason: "dead pid" });
      } catch {}
    }
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
let parecProc = null;
let soxStderr = "";
let recording = false;
let recordingSource = null;
let processing = false;
let recordingSessionID = null;
let recordingTimer = null;
let recordingInterval = null;
let recordingStartTime = null;
let stopGraceTimer = null;
const MAX_RECORDING_SECONDS = 600;
// Grace period antes de matar parec: deja drenar el buffer server-side de PulseAudio.
// Sin esto, el último tramo de audio (capturado pero no entregado a parec) se pierde al SIGINT.
const STOP_GRACE_MS = 500;
// Latencia de captura de parec: reduce el buffer que PulseAudio retiene server-side.
// Menor = menos audio en vuelo = menos pérdida si parec muere sin grace.
const PAREC_LATENCY_MSEC = 50;

function forceKillSox(reason = "unknown") {
  if (stopGraceTimer) {
    clearTimeout(stopGraceTimer);
    stopGraceTimer = null;
  }
  if (soxProc) {
    log("force_kill", { target: "sox", pid: soxProc.pid, reason });
    try {
      process.kill(soxProc.pid, "SIGKILL");
    } catch {}
    soxProc = null;
  }
  if (parecProc) {
    log("force_kill", { target: "parec", pid: parecProc.pid, reason });
    try {
      process.kill(parecProc.pid, "SIGKILL");
    } catch {}
    parecProc = null;
  }
  try {
    execSync(`pkill -9 -f 'sox.*opencode-stt-${process.pid}'`, { stdio: "ignore" });
  } catch {}
}

function startRecording(kv, toast, complete, client, api, systemPrompt) {
  if (stopGraceTimer) {
    log("start_superseded", { reason: "stop grace timer pending, cancelling" });
    clearTimeout(stopGraceTimer);
    stopGraceTimer = null;
  }
  if (soxProc) {
    log("start_superseded", { reason: "soxProc still alive, force killing before new recording" });
    forceKillSox("start-superseded");
  }

  const route = api.route.current;
  recordingSessionID = route.name === "session" ? route.params.sessionID : null;

  currentWavFile = newWavFile();

  soxStderr = "";
  const mic = kv.get("stt.mic", "") || null;
  const isLinux = os.platform() === "linux";

  const silenceThreshold = kv.get("stt.silence.threshold", ".1%");
  const silenceStartDelay = kv.get("stt.silence.startDelay", "0.05");
  const silenceStopDuration = kv.get("stt.silence.stopDuration", "60:00"); // 60 min - never stops due to silence

  const silenceArgs = [
    "silence",
    "1",
    silenceStartDelay,
    silenceThreshold,
    "1",
    silenceStopDuration,
    silenceThreshold,
  ];

  if (isLinux) {
    // Linux: usar parec + pipe nativo a sox stdin
    // parec captura de PulseAudio/PipeWire, sox lee del pipe (stdin)
    // Al parar: SIGINT a parec → stdout cierra → sox ve EOF → flushea → exit 0
    const parecDevice = mic || "@DEFAULT_SOURCE@";
    log("parec_spawn", {
      device: parecDevice,
      format: "s16le",
      rate: 16000,
      channels: 1,
      latencyMsec: PAREC_LATENCY_MSEC,
    });
    parecProc = spawn(
      "parec",
      [
        "--device",
        parecDevice,
        "--format",
        "s16le",
        "--rate",
        "16000",
        "--channels",
        "1",
        "--latency-msec",
        String(PAREC_LATENCY_MSEC),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    parecProc.on("error", (err) => {
      log("parec_error", { error: err.message });
      parecProc = null;
      if (recording && !processing) {
        clearTimeout(recordingTimer);
        clearInterval(recordingInterval);
        recording = false;
        recordingSource = null;
        forceKillSox("parec-error");
        toast("Microphone lost - recording cancelled", "error");
      }
    });

    parecProc.on("exit", (code, signal) => {
      log("parec_exit", { code, signal: signal || null });
      if (parecProc) parecProc = null;
      if (recording && !processing && code !== 0 && code !== null) {
        clearTimeout(recordingTimer);
        clearInterval(recordingInterval);
        recording = false;
        recordingSource = null;
        forceKillSox("parec-exit");
        toast("Microphone disconnected", "error");
      }
    });

    soxProc = spawn(
      "sox",
      [
        "-t",
        "raw",
        "-r",
        "16000",
        "-c",
        "1",
        "-b",
        "16",
        "-e",
        "signed-integer",
        "-",
        currentWavFile,
        ...silenceArgs,
      ],
      {
        stdio: ["pipe", "ignore", "pipe"],
        detached: false,
      },
    );

    parecProc.stdout.pipe(soxProc.stdin);
    log("pipe_connected", { from: "parec", to: "sox", file: currentWavFile });
  } else {
    const inputArgs = mic ? ["-t", "coreaudio", mic] : ["-d"];
    soxProc = spawn(
      "sox",
      [...inputArgs, "-r", "16000", "-c", "1", "-b", "16", currentWavFile, ...silenceArgs],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    );
  }

  log("recording_start", { mic: mic || "default", silenceThreshold, file: currentWavFile });

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
      recordingSource = null;
      toast(`Recording failed: ${err.message}`, "error");
    }
  });

  soxProc.on("exit", (code, signal) => {
    const durationMs = Date.now() - recordingStartTime;
    let fileSize = null;
    let fileMtime = null;
    if (currentWavFile) {
      try {
        const st = fs.statSync(currentWavFile);
        fileSize = st.size;
        fileMtime = st.mtimeMs;
      } catch {}
    }
    log("sox_exit", { code, signal: signal || null, durationMs, fileSize, fileMtime });
    soxProc = null;
    clearTimeout(recordingTimer);
    clearInterval(recordingInterval);
    if (recording && code !== 0 && code !== null && !processing) {
      recording = false;
      recordingSource = null;
      const errLine = soxStderr.trim().split("\n").pop();
      toast(`Recording error: ${errLine || `sox exited (code=${code})`}`, "error");
    }
  });

  recording = true;
}

function stopRecording() {
  clearTimeout(recordingTimer);
  clearInterval(recordingInterval);
  const durationMs = recordingStartTime ? Date.now() - recordingStartTime : null;
  log("stop_requested", { durationMs, hadSox: !!soxProc, hadParec: !!parecProc });

  if (parecProc) {
    // Grace period: dejar que PulseAudio entregue a parec el audio capturado
    // pero todavía no escrito al pipe. Matar parec ahora descarta ese buffer.
    log("stop_grace_started", { graceMs: STOP_GRACE_MS });

    stopGraceTimer = setTimeout(() => {
      stopGraceTimer = null;
      const p = parecProc;
      if (!p) return;
      parecProc = null;
      log("stop_signal_sent", {
        target: "parec",
        signal: "SIGINT",
        pid: p.pid,
        durationMs,
        graceMs: STOP_GRACE_MS,
      });
      try {
        p.kill("SIGINT");
      } catch {}
      setTimeout(() => {
        try {
          log("stop_signal_sent", {
            target: "parec",
            signal: "SIGKILL",
            pid: p.pid,
            reason: "fallback",
          });
          p.kill("SIGKILL");
        } catch {}
      }, 3000);
    }, STOP_GRACE_MS);

    // El monitoreo de sox lo hace waitForSoxExit en el pipeline; aquí solo
    // garantizamos el kill de refuerzo si sox no cierra tras el SIGINT de parec.
    if (soxProc) {
      const s = soxProc;
      let closed = false;
      const onClose = () => {
        closed = true;
        log("sox_pipe_closed", { durationMs, elapsedMs: Date.now() - recordingStartTime });
      };
      s.once("close", onClose);
      const soxWatchdogMs = STOP_GRACE_MS + 3500;
      setTimeout(() => {
        s.removeListener("close", onClose);
        if (!closed) {
          log("sox_pipe_still_open", {
            durationMs,
            reason: `sox close not observed within ${soxWatchdogMs}ms`,
          });
        }
        if (!closed && soxProc === s) forceKillSox("stop-pipe-timeout");
      }, soxWatchdogMs);
    }
  } else if (soxProc) {
    log("stop_signal_sent", { target: "sox", signal: "SIGINT", pid: soxProc.pid, durationMs });
    try {
      soxProc.kill("SIGINT");
    } catch {}
    setTimeout(() => {
      if (soxProc) forceKillSox("stop-sigkill-fallback");
    }, 3000);
  }
}

async function waitForSoxExit(timeoutMs = 10000) {
  const start = Date.now();
  while (soxProc && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (soxProc) {
    log("sox_wait_timeout", { waitedMs: Date.now() - start, timeoutMs });
    forceKillSox("wait-for-exit-timeout");
    return false;
  }
  log("sox_wait_exited", { waitedMs: Date.now() - start });
  return true;
}

function getModelName(kv) {
  const model = kv.get("stt.model", DEFAULT_MODEL);
  return MODELS[model] ? model : DEFAULT_MODEL;
}

function getModelPath(kv) {
  return path.join(getModelsDir(), MODELS[getModelName(kv)].file);
}

async function transcribe(kv, wavPath) {
  const filePath = wavPath || currentWavFile || WAV_FILE;
  const mp = getModelPath(kv);
  if (!fs.existsSync(mp)) {
    return Promise.resolve({
      error: `Model not found: ${getModelName(kv)}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < recordingStartTime - 2000) {
      log("stale_file_rejected", { file: filePath, mtimeMs: stat.mtimeMs, recordingStartTime });
      return Promise.resolve({ error: "Recording file is stale - please try again" });
    }
  } catch {}

  const validation = await validateAndRepairWav(filePath);
  if (!validation.valid) {
    return Promise.resolve({ error: validation.error });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const start = Date.now();
    log("stt_request", { engine: "local", model: getModelName(kv), file: filePath });
    const proc = spawn("whisper-cli", ["-m", mp, "-f", filePath, "-np", "-nt"], {
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
      log("stt_error", { engine: "local", message: "timeout", ms: Date.now() - start });
      resolve({ error: "Transcription timed out (360s)" });
    }, 360000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      log("stt_error", { engine: "local", message: err.message, ms: Date.now() - start });
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - start;
      if (code !== 0) {
        const msg = stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})`;
        log("stt_error", { engine: "local", message: msg, code, ms });
        resolve({ error: msg });
        return;
      }
      const text = stdout
        .replace(/\[.*?\]/g, "")
        .replace(/\(.*?\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
      log("stt_response", { engine: "local", chars: text.length, ms });
      resolve({ text });
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
- "bullion" → "boolean"

---

# GLOSARIO CANÓNICO

Si se provee un glosario con entradas del tipo canónico y sus variantes
fonéticas, reemplazá variantes por el canónico correspondiente solo cuando
aparezcan en la transcripción cruda. No inventes términos del glosario si
no hay variante presente. Si no hay glosario, no apliques esta regla.`;

async function normalizeTranscription(complete, rawText, _contextObj, systemPrompt, glossaryMap) {
  const glossaryText = formatGlossaryForPrompt(glossaryMap || {});
  let system = systemPrompt;
  if (glossaryText) {
    system =
      system +
      "\n\n# GLOSARIO CANONICO\n" +
      glossaryText +
      "\n\nRegla: si en la transcripcion cruda aparece una variante listada, reemplazala por su forma canonica. Si no aparece ninguna variante, no inventes terminos del glosario.";
  }
  const start = Date.now();
  const prompt = `TRANSCRIPCIÓN CRUDA A LIMPIAR:\n\n${rawText}\n\nRESPONDER ÚNICAMENTE CON EL TEXTO LIMPIO. SIN EXPLICACIONES. SIN MARKDOWN.`;

  if (VERBOSE_LOGS) {
    log("normalize_request", {
      inputChars: rawText.length,
      input: rawText,
      promptFull: prompt,
      system,
      glossaryTerms: glossaryMap ? Object.keys(glossaryMap).length : 0,
    });
  } else {
    log("normalize_request", {
      inputChars: rawText.length,
      glossaryTerms: glossaryMap ? Object.keys(glossaryMap).length : 0,
    });
  }

  const result = await complete({
    system,
    prompt,
    contextMessages: [],
  });

  const ms = Date.now() - start;
  const normalizedText = result.text || "";
  if (VERBOSE_LOGS) {
    log("normalize_response", {
      chars: normalizedText.length,
      output: result,
      outputText: normalizedText,
      error: result.error || null,
      rawInput: rawText,
      rawChars: rawText.length,
      ms,
    });
  } else {
    log("normalize_response", { chars: normalizedText.length, ms });
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

async function transcribeApi(kv, wavPath) {
  if (!sttApiEndpoint || !sttApiModel) {
    return { error: "STT API not configured" };
  }
  const model = kv.get("stt.api.model") || sttApiModel;
  const filePath = wavPath || currentWavFile || WAV_FILE;

  if (!filePath || !fs.existsSync(filePath)) {
    return { error: "No recording file - sox may have failed to capture audio" };
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < recordingStartTime - 2000) {
      log("stale_file_rejected", { file: filePath, mtimeMs: stat.mtimeMs, recordingStartTime });
      return { error: "Recording file is stale - please try again" };
    }
  } catch {}

  const validation = await validateAndRepairWav(filePath);
  if (!validation.valid) {
    return { error: validation.error };
  }

  const start = Date.now();
  try {
    const audioBuffer = await fs.promises.readFile(filePath);
    const blob = new Blob([audioBuffer], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, "audio.wav");
    form.append("model", model);
    form.append("response_format", "json");
    form.append("language", "es");

    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}audio/transcriptions`
      : `${sttApiEndpoint}/audio/transcriptions`;

    const headers = {};
    if (sttApiKeyEnv) {
      const apiKey = process.env[sttApiKeyEnv];
      if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    }

    const doFetch = () =>
      fetch(url, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(180000),
      });

    log("stt_request", {
      engine: "api",
      model,
      audioBytes: audioBuffer.length,
    });
    let resp = await doFetch();
    let networkMs = Date.now() - start;

    if (!resp.ok) {
      const body = await resp.text();
      let msg = `STT API error ${resp.status}`;
      try {
        const err = JSON.parse(body);
        msg = err?.error?.message || msg;
      } catch {}
      log("stt_error", { engine: "api", status: resp.status, message: msg, ms: networkMs });
      return { error: msg };
    }

    const data = await resp.json();
    const text = data.text?.trim() || "";
    if (VERBOSE_LOGS) {
      log("stt_response", { engine: "api", chars: text.length, text, ms: networkMs });
    } else {
      log("stt_response", { engine: "api", chars: text.length, ms: networkMs });
    }
    return { text };
  } catch (err) {
    const ms = Date.now() - start;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      log("stt_error", { engine: "api", message: "timeout", ms });
      return { error: "STT API request timed out (180s)" };
    }
    log("stt_error", { engine: "api", message: err.message, ms });
    return { error: `STT API request failed: ${err.message}` };
  }
}

// Modes: "auto" (detect from model), "whisper-local", "whisper-api", "passthrough" (force audio to model)
async function resolveSttMode(kv, api) {
  const mode = kv.get("stt.mode", "auto");

  if (mode === "whisper-local") {
    return { usePassthrough: false, mode, reason: "Mode forced to whisper-local" };
  }
  if (mode === "whisper-api") {
    if (!sttApiEndpoint) {
      return {
        usePassthrough: false,
        mode: "whisper-api-fallback",
        reason: "No STT API configured, falling back to local whisper",
      };
    }
    return { usePassthrough: false, mode, reason: "Mode forced to whisper-api" };
  }
  if (mode === "passthrough") {
    return { usePassthrough: true, mode, reason: "Mode forced to passthrough" };
  }

  const detection = await modelSupportsAudio(api);
  if (detection.supportsAudio) {
    return { usePassthrough: true, mode: "auto", reason: detection.reason };
  }
  return { usePassthrough: false, mode: "auto", reason: detection.reason };
}

function navigateToRecordingSession(api) {
  if (recordingSessionID && api.route.current.params?.sessionID !== recordingSessionID) {
    api.route.navigate("session", { sessionID: recordingSessionID });
  }
}

async function doTranscribePipeline(kv, complete, client, api, toast, systemPrompt) {
  if (processing) return;
  processing = true;
  const pipelineStart = Date.now();
  clearTimeout(recordingTimer);
  clearInterval(recordingInterval);
  const wavPath = currentWavFile;
  const startedAt = recordingStartTime;
  log("pipeline_start", {
    wavPath,
    recordingDurationMs: startedAt ? Date.now() - startedAt : null,
  });
  if (!wavPath || !fs.existsSync(wavPath)) {
    log("pipeline_no_file", { wavPath, recordingStartTime: startedAt });
    toast("No recording file - please try again", "error");
    processing = false;
    recording = false;
    recordingSource = null;
    recordingSessionID = null;
    currentWavFile = null;
    return;
  }
  log("pipeline_wav_ready", { wavPath, size: fs.statSync(wavPath).size });
  try {
    stopRecording();
    await waitForSoxExit();

    const {
      usePassthrough,
      mode: resolvedMode,
      reason: modeReason,
    } = await resolveSttMode(kv, api);
    log("stt_mode_resolved", { mode: resolvedMode, usePassthrough, reason: modeReason });

    if (usePassthrough) {
      if (!recordingSessionID) {
        toast("F6 requiere una sesión activa. Abrí un chat primero.", "error");
        return;
      }
      const sessionID = recordingSessionID;
      try {
        const tag = saveAudioToQueue(sessionID, wavPath);
        await client.tui.appendPrompt({ text: tag + " " });
        toast(`Audio added as ${tag}`, "success");
        return;
      } catch (err) {
        toast(`Queue error: ${err.message}`, "error");
      }
    }

    toast("Transcribing...");
    const result = sttApiEndpoint
      ? await transcribeApi(kv, wavPath)
      : await transcribe(kv, wavPath);
    log("pipeline_transcribed", { ms: Date.now() - pipelineStart, hasError: !!result.error });
    if (VERBOSE_LOGS) {
      log("stt_raw_text", {
        chars: result.text?.length || 0,
        text: result.text || "",
        error: result.error || null,
      });
    }

    if (result.error) {
      toast(result.error, "error");
      return;
    }
    if (!result.text) {
      toast("No speech detected", "warning");
      return;
    }

    toast("Normalizing...");
    const { map: glossaryMap, file: glossaryFile } = loadGlossary(api, recordingSessionID);
    log("glossary_loaded", { file: glossaryFile, terms: Object.keys(glossaryMap).length });
    const llmResult = await normalizeTranscription(
      complete,
      result.text,
      null,
      systemPrompt,
      glossaryMap,
    );
    log("pipeline_normalized", { ms: Date.now() - pipelineStart });
    log("normalize_diff", {
      rawChars: result.text?.length || 0,
      rawText: result.text || "",
      normalizedChars: llmResult.text?.length || 0,
      normalizedText: llmResult.text || "",
      hadError: !llmResult.text,
    });

    if (!llmResult.text) {
      if (llmResult.error !== "normalization disabled") {
        toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
      }
      if (VERBOSE_LOGS) {
        log("prompt_appended", { source: "raw", text: result.text });
      } else {
        log("prompt_appended", { source: "raw", chars: result.text.length });
      }
      navigateToRecordingSession(api);
      await client.tui.appendPrompt({ text: result.text });
      log("pipeline_done", { source: "raw", ms: Date.now() - pipelineStart });
      return;
    }

    if (VERBOSE_LOGS) {
      log("prompt_appended", { source: "normalized", text: llmResult.text });
    } else {
      log("prompt_appended", { source: "normalized", chars: llmResult.text.length });
    }
    navigateToRecordingSession(api);
    await client.tui.appendPrompt({ text: llmResult.text });
    toast("Transcription added to prompt", "success");
    log("pipeline_done", { source: "normalized", ms: Date.now() - pipelineStart });
  } catch (err) {
    log("pipeline_error", { message: err.message, ms: Date.now() - pipelineStart });
    toast(`STT error: ${err.message}`, "error");
  } finally {
    processing = false;
    recording = false;
    recordingSource = null;
    recordingSessionID = null;
    clearTimeout(recordingTimer);
    clearInterval(recordingInterval);
    if (stopGraceTimer) {
      clearTimeout(stopGraceTimer);
      stopGraceTimer = null;
    }
    if (wavPath) {
      try {
        fs.unlinkSync(wavPath);
        log("wav_cleaned", { file: wavPath });
      } catch {}
      if (currentWavFile === wavPath) currentWavFile = null;
    }
  }
}

// ---- Public API for TUI plugin ----

export function registerSTT(api, kv, complete, prompts, opts) {
  cleanStaleWav();
  cleanStaleAudioQueue();
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

  async function doPassthroughPipeline(kv, client, api, toast) {
    processing = true;
    clearTimeout(recordingTimer);
    clearInterval(recordingInterval);
    const wavPath = currentWavFile;
    if (!wavPath || !fs.existsSync(wavPath)) {
      log("passthrough_no_file", { wavPath });
      toast("No recording file - please try again", "error");
      processing = false;
      recording = false;
      recordingSource = null;
      return;
    }
    try {
      stopRecording();
      await waitForSoxExit();

      if (!recordingSessionID) {
        toast("F6 requiere una sesión activa. Abrí un chat primero.", "error");
        return;
      }

      const sessionID = recordingSessionID;
      const tag = saveAudioToQueue(sessionID, wavPath);
      await client.tui.appendPrompt({ text: tag + " " });
      toast(`🎤 ${tag} — audio listo, presioná Enter para enviar`, "success");
    } catch (err) {
      log("passthrough_pipeline_error", { message: err.message });
      toast(`Audio error: ${err.message}`, "error");
    } finally {
      processing = false;
      recording = false;
      recordingSource = null;
      recordingSessionID = null;
      clearTimeout(recordingTimer);
      clearInterval(recordingInterval);
      if (stopGraceTimer) {
        clearTimeout(stopGraceTimer);
        stopGraceTimer = null;
      }
      if (wavPath) {
        try {
          fs.unlinkSync(wavPath);
          log("wav_cleaned", { file: wavPath, source: "passthrough" });
        } catch {}
        if (currentWavFile === wavPath) currentWavFile = null;
      }
    }
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
          log("record_toggle", { action: "busy", processing });
          toast("STT busy, please wait...");
          return;
        }
        if (recording) {
          if (recordingSource !== "f5") {
            log("recording_source_mismatch", { expected: "f5", actual: recordingSource });
            toast("Grabación iniciada con F6, cerrala con F6", "error");
            return;
          }
          log("record_toggle", {
            action: "stop_and_transcribe",
            durationMs: recordingStartTime ? Date.now() - recordingStartTime : null,
          });
          toast("Stopping, transcribing...");
          doTranscribePipeline(kv, complete, client, api, toast, systemPrompt);
        } else {
          log("record_toggle", { action: "start" });
          startRecording(kv, toast, complete, client, api, systemPrompt);
          if (recording) {
            recordingSource = "f5";
            toast("Recording... press again to transcribe");
          }
        }
      },
    },
    {
      title: "STT: record/send audio directly",
      value: "stt.passthrough",
      description:
        "Toggle recording; press again to stop and send audio directly to model (no transcription)",
      keybind: "f6",
      slash: { name: "stt-passthrough" },
      onSelect() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (recording) {
          if (recordingSource !== "f6") {
            log("recording_source_mismatch", { expected: "f6", actual: recordingSource });
            toast("Grabación iniciada con F5, cerrala con F5", "error");
            return;
          }
          toast("Stopping, sending audio...");
          doPassthroughPipeline(kv, client, api, toast);
        } else {
          startRecording(kv, toast, complete, client, api, systemPrompt);
          if (recording) {
            recordingSource = "f6";
            toast(" Recording audio... press F6 again to send");
          }
        }
      },
    },
    {
      title: "STT: cancel recording",
      value: "stt.stop",
      description: "Cancel current recording",
      keybind: "escape",
      slash: { name: "stt-stop" },
      onSelect() {
        if (recording) {
          const durationMs = recordingStartTime ? Date.now() - recordingStartTime : null;
          log("record_cancel", { durationMs });
          if (stopGraceTimer) {
            clearTimeout(stopGraceTimer);
            stopGraceTimer = null;
            log("record_cancel", { note: "cancelled pending stop grace" });
          }
          recording = false;
          recordingSource = null;
          recordingSessionID = null;
          clearTimeout(recordingTimer);
          clearInterval(recordingInterval);
          const toClean = currentWavFile;
          currentWavFile = null;
          forceKillSox("record-cancel");
          if (toClean) {
            try {
              fs.unlinkSync(toClean);
            } catch {}
          }
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
    {
      title: "STT: mode",
      value: "stt.mode",
      description: "Switch STT mode: auto, whisper-local, whisper-api, or passthrough",
      slash: { name: "stt-mode" },
      async onSelect() {
        const currentMode = kv.get("stt.mode", "auto");

        let detectionInfo = "";
        try {
          const detection = await modelSupportsAudio(api);
          detectionInfo = detection.supportsAudio
            ? `Current model supports audio input`
            : `Current model does NOT support audio input`;
        } catch {
          detectionInfo = "Could not detect model capabilities";
        }

        const STT_MODES = [
          {
            value: "auto",
            label: "Auto (detect from model)",
            description: "Use audio passthrough when model supports it, whisper otherwise",
          },
          {
            value: "passthrough",
            label: "Passthrough (audio to model)",
            description: "Always send audio directly to the model without transcription",
          },
          {
            value: "whisper-local",
            label: "Whisper Local",
            description: "Always use local whisper-cpp for transcription",
          },
          {
            value: "whisper-api",
            label: "Whisper API",
            description: "Always use whisper API endpoint for transcription",
          },
        ];

        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: `STT Mode — ${detectionInfo} (según opencode.json en disco; si cambiaste con <leader>m, reiniciá o forzá modo)`,
            current: currentMode,
            options: STT_MODES.map((m) => ({
              title: `${m.label}${m.value === currentMode ? " ✓" : ""}`,
              value: m.value,
              description: m.description,
              onSelect() {
                kv.set("stt.mode", m.value);
                toast(`STT mode: ${m.label}`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "STT: glossary",
      value: "stt.glossary",
      description: "Manage voice glossary (.opencode/voice-glossary.json)",
      slash: { name: "stt-glossary" },
      async onSelect() {
        const route = api.route.current;
        const scopeSessionID =
          route.name === "session" ? route.params.sessionID : recordingSessionID;
        const { file: glossaryFile } = loadGlossary(api, scopeSessionID);
        const refresh = () =>
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: `STT Glossary — ${glossaryFile}`,
              options: [
                {
                  title: "Show glossary",
                  value: "show",
                  onSelect() {
                    const { map } = loadGlossary(api, scopeSessionID);
                    const entries = Object.entries(map);
                    if (entries.length === 0) {
                      toast("Glossary is empty");
                      api.ui.dialog.clear();
                      return;
                    }
                    api.ui.dialog.replace(() =>
                      api.ui.DialogSelect({
                        title: "Glossary entries (ESC to go back)",
                        current: "",
                        options: [
                          {
                            title: "← Back",
                            value: "__back",
                            onSelect() {
                              refresh();
                            },
                          },
                          ...entries.map(([canon, variants]) => ({
                            title: `${canon}${variants.length ? ` → ${variants.join(", ")}` : ""}`,
                            value: canon,
                            onSelect() {},
                          })),
                        ],
                      }),
                    );
                  },
                },
                {
                  title: "Generate from session conversation",
                  value: "generate",
                  onSelect() {
                    const sessionID = scopeSessionID;
                    if (!sessionID) {
                      toast("No active session - cannot generate from conversation", "error");
                      return;
                    }
                    api.ui.dialog.replace(() =>
                      api.ui.DialogSelect({
                        title: "Generate glossary — pick max terms",
                        current: "20",
                        options: [
                          {
                            title: "20 terms",
                            value: "20",
                            onSelect: () => doGenerate(20, sessionID),
                          },
                          {
                            title: "30 terms",
                            value: "30",
                            onSelect: () => doGenerate(30, sessionID),
                          },
                          {
                            title: "50 terms",
                            value: "50",
                            onSelect: () => doGenerate(50, sessionID),
                          },
                        ],
                      }),
                    );
                  },
                },
                {
                  title: "Add term",
                  value: "add",
                  onSelect() {
                    api.ui.dialog.replace(() =>
                      api.ui.DialogPrompt({
                        title: "Add canonical term",
                        placeholder: "Ej: BrAIny",
                        onConfirm(value) {
                          const canon = value.trim();
                          if (!canon) {
                            toast("Canonical term is required", "error");
                            return;
                          }
                          api.ui.dialog.replace(() =>
                            api.ui.DialogPrompt({
                              title: `Variants for "${canon}" (comma separated, optional)`,
                              placeholder: "brainy, breini",
                              value: "",
                              onConfirm(variantsStr) {
                                const variants = variantsStr
                                  .split(",")
                                  .map((s) => s.trim())
                                  .filter(Boolean);
                                const { map } = loadGlossary(api, scopeSessionID);
                                map[canon] = [...new Set([...(map[canon] || []), ...variants])];
                                saveGlossary(map, api, scopeSessionID);
                                toast(`Added ${canon}`);
                                api.ui.dialog.clear();
                              },
                              onCancel() {
                                const { map } = loadGlossary(api, scopeSessionID);
                                if (!map[canon]) {
                                  map[canon] = [];
                                  saveGlossary(map, api, scopeSessionID);
                                }
                                toast(`Added ${canon}`);
                                api.ui.dialog.clear();
                              },
                            }),
                          );
                        },
                        onCancel() {
                          refresh();
                        },
                      }),
                    );
                  },
                },
                {
                  title: "Remove term",
                  value: "remove",
                  onSelect() {
                    const { map } = loadGlossary(api, scopeSessionID);
                    const entries = Object.entries(map);
                    if (entries.length === 0) {
                      toast("Glossary is empty");
                      return;
                    }
                    api.ui.dialog.replace(() =>
                      api.ui.DialogSelect({
                        title: "Remove term",
                        current: "",
                        options: entries.map(([canon]) => ({
                          title: canon,
                          value: canon,
                          onSelect() {
                            delete map[canon];
                            saveGlossary(map, api, scopeSessionID);
                            toast(`Removed ${canon}`);
                            refresh();
                          },
                        })),
                      }),
                    );
                  },
                },
                {
                  title: "Clear glossary",
                  value: "clear",
                  onSelect() {
                    api.ui.dialog.replace(() =>
                      api.ui.DialogConfirm({
                        title: "Clear entire glossary?",
                        message: glossaryFile,
                        onConfirm() {
                          saveGlossary({}, api, scopeSessionID);
                          toast("Glossary cleared");
                          api.ui.dialog.clear();
                        },
                        onCancel() {
                          refresh();
                        },
                      }),
                    );
                  },
                },
              ],
            }),
          );

        async function doGenerate(maxTerms, sessionID) {
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Generating glossary...",
              options: [{ title: "Working, please wait...", value: "__busy", disabled: true }],
            }),
          );
          try {
            log("glossary_generate_start", { sessionID, maxTerms });
            const ctx = await getSessionContext(client, api, 20000, sessionID);
            log("glossary_generate_context", {
              sessionID,
              chars: ctx.text?.length || 0,
              messages: ctx.messages?.length || 0,
              preview: (ctx.text || "").slice(0, 400),
            });
            if (!ctx.text) {
              log("glossary_generate_empty_context", { sessionID });
              toast("No conversation context to generate from", "error");
              refresh();
              return;
            }
            const prompt = `Analizá la siguiente conversación y extraé términos canónicos: nombres propios, productos, marcas, servicios, términos técnicos, nombres de proyecto y variantes de pronunciación probables.\n\nDevolvé exclusivamente un JSON con la forma {"terms": {"Canonico": ["variante1", "variante2"]}}. Máximo ${maxTerms} entradas. Si un término no tiene variantes deja []. No agregues markdown ni explicaciones.\n\nCONVERSACIÓN:\n${ctx.text.slice(0, 12000)}`;
            const res = await complete({
              system: "Sos un extractor de glosario. Respondé solo con JSON válido.",
              prompt,
            });
            if (!res.text) {
              log("glossary_generate_failed", { error: res.error || "empty response", sessionID });
              toast(`Generate failed: ${res.error || "empty response"}`, "error");
              refresh();
              return;
            }
            log("glossary_generate_response", {
              chars: res.text.length,
              preview: res.text.slice(0, 500),
            });
            let incoming;
            try {
              incoming = parseGeneratedJson(res.text);
            } catch (err) {
              log("glossary_generate_parse_error", {
                error: err.message,
                preview: res.text.slice(0, 500),
              });
              toast(`Generate parse error: ${err.message}`, "error");
              refresh();
              return;
            }
            const incomingCount = Object.keys(incoming).length;
            log("glossary_generate_parsed", { incomingCount, keys: Object.keys(incoming) });
            if (incomingCount === 0) {
              toast("No terms extracted", "warning");
              refresh();
              return;
            }
            const { map: current, file: currentFile } = loadGlossary(api, sessionID);
            const merged = mergeGlossary(current, incoming);
            log("glossary_generated", {
              file: currentFile,
              incomingTerms: incomingCount,
              existingTerms: Object.keys(current).length,
            });
            api.ui.dialog.replace(() =>
              api.ui.DialogConfirm({
                title: `Merge ${incomingCount} term(s)?`,
                message: Object.entries(incoming)
                  .map(([k, v]) => `${k}${v.length ? ` (${v.join(", ")})` : ""}`)
                  .join("\n"),
                onConfirm() {
                  const savedFile = saveGlossary(merged, api, sessionID);
                  log("glossary_saved", { file: savedFile, terms: Object.keys(merged).length });
                  toast(`Glossary updated: ${incomingCount} term(s) merged`);
                  api.ui.dialog.clear();
                },
                onCancel() {
                  refresh();
                },
              }),
            );
          } catch (err) {
            log("glossary_generate_exception", { error: err.message, sessionID });
            toast(`Generate error: ${err.message}`, "error");
            refresh();
          }
        }

        refresh();
      },
    },
  ];
}
