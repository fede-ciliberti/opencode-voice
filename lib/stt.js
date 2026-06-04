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

function startRecording(kv, toast) {
  if (soxProc) return;

  forceKillSox();
  try {
    fs.unlinkSync(WAV_FILE);
  } catch {}

  soxStderr = "";
  const mic = kv.get("stt.mic", "") || null;
  let inputArgs;
  if (mic) {
    inputArgs = os.platform() === "darwin"
      ? ["-t", "coreaudio", mic]
      : ["-t", "pulse", mic];
  } else {
    inputArgs = ["-d"];
  }

  soxProc = spawn(
    "sox",
    [
      ...inputArgs, "-r", "16000", "-c", "1", "-b", "16", WAV_FILE,
      "silence", "1", "0.1", "1%", "1", "10.0", "1%"
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    },
  );

  // Safety timeout: force stop after MAX_RECORDING_SECONDS
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
    if (recording) {
      recording = false;
      toast(`Recording failed: ${err.message}`, "error");
    }
  });

  soxProc.on("exit", (code) => {
    soxProc = null;
    clearTimeout(recordingTimer);
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

function transcribe(kv) {
  const mp = getModelPath(kv);
  if (!fs.existsSync(mp)) {
    return Promise.resolve({
      error: `Model not found: ${getModelName(kv)}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!fs.existsSync(WAV_FILE)) {
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }
  if (fs.statSync(WAV_FILE).size <= 44) {
    return Promise.resolve({ error: "Recording is empty - no audio captured" });
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

const STT_SYSTEM_PROMPT = `You are a speech-to-text normalizer for a coding assistant CLI. The user speaks Spanish (Argentine).

CRITICAL: ALWAYS respond in the SAME LANGUAGE as the input transcription. Do NOT translate to English. If the input is in Spanish, output in Spanish. Keep technical/code terms in their original form. Mixed code-switching is fine.

Clean up raw whisper transcription into a clear, well-punctuated prompt. Rules:
- Fix punctuation, capitalization, and grammar
- Remove filler words (um, uh, eh, este, like, you know, etc.)
- Keep technical terms, file names, and code references exact
- If the user is dictating code, format it appropriately
- Use the session context above to resolve ambiguous references
- Output ONLY the cleaned text, nothing else
- Do not add any commentary or explanation
- Keep the user's intent and meaning intact

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync", "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "types creep" / "type script" -> "TypeScript"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

async function normalizeTranscription(complete, rawText, context, systemPrompt) {
  const contextBlock = context ? `\n\nConversation context:\n${context}` : "";
  const system = `${systemPrompt}${contextBlock}`;

  const result = await complete({
    system,
    prompt: `Clean up this speech-to-text transcription:\n\n${rawText}`,
  });
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

async function transcribeApi(kv, context) {
  if (!sttApiEndpoint || !sttApiModel) {
    return { error: "STT API not configured" };
  }
  const model = kv.get("stt.api.model") || sttApiModel;

  if (!fs.existsSync(WAV_FILE)) {
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  if (fs.statSync(WAV_FILE).size <= 44) {
    return { error: "Recording is empty - no audio captured" };
  }

  try {
    const audioBuffer = await fs.promises.readFile(WAV_FILE);
    const blob = new Blob([audioBuffer], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, "audio.wav");
    form.append("model", model);
    form.append("response_format", "json");
    form.append("language", "es");
    if (context) {
      form.append("prompt", context);
    }

    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}audio/transcriptions`
      : `${sttApiEndpoint}/audio/transcriptions`;

    const headers = {};
    if (sttApiKeyEnv) {
      const apiKey = process.env[sttApiKeyEnv];
      if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
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
      return { error: msg };
    }

    const data = await resp.json();
    return { text: data.text?.trim() || "" };
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
  try {
    stopRecording();
    await waitForSoxExit();

    const context = await getSessionContext(client, api);

    toast("Transcribing...");
    const result = sttApiEndpoint ? await transcribeApi(kv, context) : await transcribe(kv);

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
    );

    if (!llmResult.text) {
      toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
      await client.tui.appendPrompt({ text: result.text });
      return;
    }

    await client.tui.appendPrompt({ text: llmResult.text });
    toast("Transcription added to prompt", "success");
  } catch (err) {
    toast(`STT error: ${err.message}`, "error");
  } finally {
    processing = false;
    recording = false;
    clearTimeout(recordingTimer);
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
          startRecording(kv, toast);
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
