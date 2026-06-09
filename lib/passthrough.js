// Audio passthrough: send recorded voice directly to models that support audio input.
// Detects audio support from provider config modalities and sends via FilePartInput.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getSessionContext } from "./session.js";

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

/**
 * Strip provider prefix from model ID.
 * "litellm/gemini-3.5-flash" → "gemini-3.5-flash"
 * "google/gemini-2.0-flash" → "gemini-2.0-flash"
 * "gemini-3.5-flash" → "gemini-3.5-flash" (no prefix, unchanged)
 */
function stripProviderPrefix(modelId) {
  if (!modelId) return null;
  const parts = modelId.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : modelId;
}

/** Cached audio-capable model detection result */
let audioModelsCache = null;
let audioModelsCacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Build a Set of model IDs that support audio input from provider config.
 * Caches results for 1 minute.
 * @returns {Promise<Set<string>>} Set of provider-prefixed model IDs that support audio.
 */
async function getAudioCapableModels(client) {
  const now = Date.now();
  if (audioModelsCache && now - audioModelsCacheTime < CACHE_TTL) {
    return audioModelsCache;
  }

  const audioModels = new Set();

  try {
    const result = await client.config.providers();
    const providers = result.data || [];

    for (const provider of providers) {
      if (!provider.models) continue;
      for (const [modelKey, modelConfig] of Object.entries(provider.models)) {
        const inputModalities = modelConfig.modalities?.input || [];
        if (inputModalities.includes("audio")) {
          // Store both the bare key and prefixed version for flexible matching
          audioModels.add(modelKey);
          audioModels.add(modelConfig.id || modelKey);
          // Also store with provider prefix for matching "provider/model" format
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

/**
 * Detect if the current model supports audio input.
 *
 * Strategy:
 * 1. Try to get the active model from OpenCode state/URL
 * 2. Match against provider config models with audio in modalities.input
 * 3. Fall back to whisper if detection fails or model doesn't support audio
 *
 * @returns {{ supportsAudio: boolean, modelId: string|null, reason: string }}
 */
export async function modelSupportsAudio(api) {
  const client = api.client;

  // Try to get current model from URL params (OpenCode stores it in route)
  const route = api.route?.current;
  let currentModelId = null;

  // Check if route has model info
  if (route?.params?.model) {
    currentModelId = route.params.model;
  }

  // Get all audio-capable models from config
  const audioModels = await getAudioCapableModels(client);

  // If audio-capable models list is empty, no model supports audio
  if (audioModels.size === 0) {
    return { supportsAudio: false, modelId: currentModelId, reason: "No audio-capable models in config" };
  }

  // If we have a specific model ID, check it
  if (currentModelId) {
    const stripped = stripProviderPrefix(currentModelId);
    if (audioModels.has(currentModelId) || audioModels.has(stripped)) {
      return { supportsAudio: true, modelId: currentModelId, reason: `Model ${currentModelId} supports audio` };
    }
    return { supportsAudio: false, modelId: currentModelId, reason: `Model ${currentModelId} does not support audio` };
  }

  // No model detection possible - check if ANY configured default model supports audio
  // This is a best-effort heuristic for when we can't determine the active model
  try {
    const result = await client.config.providers();
    const providers = result.data || [];

    // Look for models marked as "default" or check provider defaults
    for (const provider of providers) {
      if (!provider.models) continue;
      for (const [modelKey, modelConfig] of Object.entries(provider.models)) {
        if (audioModels.has(modelKey)) {
          // Found at least one audio-capable model, but can't confirm it's the active one
          return {
            supportsAudio: false,
            modelId: null,
            reason: "Cannot determine active model - use /stt-mode passthrough to force audio passthrough",
          };
        }
      }
    }
  } catch {}

  return { supportsAudio: false, modelId: null, reason: "Cannot determine active model" };
}

/**
 * Validate WAV file exists and is not empty.
 */
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

/**
 * Encode a WAV file as a base64 data URL.
 * Works with the existing sox recording at /tmp/opencode-stt.wav.
 */
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

/**
 * Send audio directly to the model as a file part via client.session.prompt().
 * This bypasses whisper transcription entirely - the model receives the raw audio
 * and processes it natively (e.g., Gemini 3.5 Flash native audio understanding).
 *
 * @param {object} api - OpenCode plugin API
 * @param {string|null} textPrompt - Optional text prompt to accompany the audio
 * @returns {Promise<{success: boolean, error?: string, sizeBytes?: number}>}
 */
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

    // Check if error suggests model doesn't support audio
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