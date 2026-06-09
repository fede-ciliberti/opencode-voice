// Audio passthrough: send recorded voice directly to models that support audio input.
// Detects audio support from provider config modalities and sends via FilePartInput.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

function stripProviderPrefix(modelId) {
  if (!modelId) return null;
  const parts = modelId.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : modelId;
}

let audioModelsCache = null;
let audioModelsCacheTime = 0;
const CACHE_TTL = 60000;

async function getAudioCapableModels(client) {
  const now = Date.now();
  if (audioModelsCache && now - audioModelsCacheTime < CACHE_TTL) {
    return audioModelsCache;
  }

  const audioModels = new Set();

  try {
    const result = await client.config.providers();
    const providers = result.data?.providers || [];

    log("providers_response", {
      providerCount: providers.length,
      firstProvider: providers[0]?.id || "none",
      hasDefaults: !!result.data?.default,
    });

    for (const provider of providers) {
      if (!provider.models) continue;
      for (const [modelKey, modelConfig] of Object.entries(provider.models)) {
        const inputModalities = modelConfig.modalities?.input || [];
        if (inputModalities.includes("audio")) {
          audioModels.add(modelKey);
          audioModels.add(modelConfig.id || modelKey);
          if (provider.id) {
            audioModels.add(`${provider.id}/${modelKey}`);
            if (modelConfig.id) {
              audioModels.add(`${provider.id}/${modelConfig.id}`);
            }
          }
        }
      }
    }

    log("audio_models_detected", {
      count: audioModels.size,
      models: [...audioModels].slice(0, 20),
    });
  } catch (err) {
    log("audio_models_detection_error", { message: err.message });
  }

  audioModelsCache = audioModels;
  audioModelsCacheTime = now;
  return audioModelsCache;
}

async function getActiveModel(client) {
  try {
    const configResult = await client.config.get();
    const configModel = configResult.data?.model;
    if (configModel) {
      log("active_model_from_config", { model: configModel });
      return configModel;
    }
  } catch (err) {
    log("active_model_config_error", { message: err.message });
  }

  try {
    const providersResult = await client.config.providers();
    const defaults = providersResult.data?.default || {};
    const defaultModel = Object.values(defaults).find((v) => typeof v === "string" && v.includes("/"));
    if (defaultModel) {
      log("active_model_from_defaults", { model: defaultModel, defaults });
      return defaultModel;
    }
  } catch (err) {
    log("active_model_defaults_error", { message: err.message });
  }

  return null;
}

export async function modelSupportsAudio(api) {
  const client = api.client;

  const audioModels = await getAudioCapableModels(client);

  if (audioModels.size === 0) {
    return { supportsAudio: false, modelId: null, reason: "No audio-capable models in config" };
  }

  const currentModelId = await getActiveModel(client);

  if (currentModelId) {
    const stripped = stripProviderPrefix(currentModelId);
    log("model_detection", {
      currentModelId,
      stripped,
      audioModelsHasCurrent: audioModels.has(currentModelId),
      audioModelsHasStripped: audioModels.has(stripped),
    });
    if (audioModels.has(currentModelId) || audioModels.has(stripped)) {
      return { supportsAudio: true, modelId: currentModelId, reason: `Model ${currentModelId} supports audio` };
    }
    return { supportsAudio: false, modelId: currentModelId, reason: `Model ${currentModelId} does not support audio` };
  }

  return { supportsAudio: false, modelId: null, reason: "Cannot determine active model - use /stt-mode passthrough to force" };
}

function validateWavFile(filePath = WAV_FILE) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: "No recording file - sox may have failed to capture audio" };
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= 44) {
    return { valid: false, error: "Recording is empty - no audio captured" };
  }
  return { valid: true, sizeBytes: stat.size };
}

export function encodeWavAsDataUrl(filePath = WAV_FILE) {
  const validation = validateWavFile(filePath);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString("base64");

  if (VERBOSE_LOGS) {
    log("passthrough_encode", { sizeBytes: buffer.length, base64Length: base64.length });
  }

  return {
    success: true,
    dataUrl: `data:audio/wav;base64,${base64}`,
    sizeBytes: validation.sizeBytes,
  };
}

export async function sendAudioPassthrough(api, textPrompt = null) {
  const route = api.route?.current;
  if (route?.name !== "session" || !route.params?.sessionID) {
    return { success: false, error: "No active session - open a session first" };
  }

  const sessionID = route.params.sessionID;

  const encoded = encodeWavAsDataUrl();
  if (!encoded.success) {
    return { success: false, error: encoded.error };
  }

  const defaultPrompt =
    "Escuchá este audio con atención. Respondé en español argentino lo que el usuario está pidiendo o diciendo. Mantené los términos técnicos tal cual (deploy, endpoint, JSON, etc).";
  const prompt = textPrompt || defaultPrompt;

  log("passthrough_send_start", {
    sessionID,
    audioSizeBytes: encoded.sizeBytes,
    hasCustomPrompt: !!textPrompt,
  });

  try {
    await api.client.session.prompt({
      sessionID,
      parts: [
        { type: "text", text: prompt },
        { type: "file", mime: "audio/wav", url: encoded.dataUrl, filename: "recording.wav" },
      ],
    });

    log("passthrough_send_success", { sizeBytes: encoded.sizeBytes });
    return { success: true, sizeBytes: encoded.sizeBytes };
  } catch (err) {
    const errorMsg = err?.message ?? "Unknown error sending audio";
    log("passthrough_send_error", { error: errorMsg });

    const isUnsupportedError =
      errorMsg.toLowerCase().includes("audio") ||
      errorMsg.toLowerCase().includes("unsupported") ||
      errorMsg.toLowerCase().includes("not supported") ||
      errorMsg.toLowerCase().includes("modalit");

    return {
      success: false,
      error: isUnsupportedError
        ? `Model doesn't support audio input: ${errorMsg}`
        : `Audio passthrough error: ${errorMsg}`,
      isUnsupported: isUnsupportedError,
    };
  }
}