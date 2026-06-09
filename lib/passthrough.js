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

function parseConfigForAudioModels(configJson, audioModels) {
  if (!configJson) return;

  const providers = configJson.providers || configJson.provider || {};
  
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (!p.models || typeof p.models !== "object") continue;
      for (const [modelKey, modelConfig] of Object.entries(p.models)) {
        if (!modelConfig || typeof modelConfig !== "object") continue;
        const inputModalities = modelConfig.modalities?.input || [];
        if (inputModalities.includes("audio")) {
          audioModels.add(modelKey);
          audioModels.add(modelConfig.id || modelKey);
          if (p.id) {
            audioModels.add(`${p.id}/${modelKey}`);
            if (modelConfig.id) {
              audioModels.add(`${p.id}/${modelConfig.id}`);
            }
          }
        }
      }
    }
  } else if (typeof providers === "object") {
    for (const [pKey, pVal] of Object.entries(providers)) {
      if (!pVal || typeof pVal !== "object" || !pVal.models || typeof pVal.models !== "object") continue;
      for (const [modelKey, modelConfig] of Object.entries(pVal.models)) {
        if (!modelConfig || typeof modelConfig !== "object") continue;
        const inputModalities = modelConfig.modalities?.input || [];
        if (inputModalities.includes("audio")) {
          audioModels.add(modelKey);
          audioModels.add(modelConfig.id || modelKey);
          audioModels.add(`${pKey}/${modelKey}`);
          if (modelConfig.id) {
            audioModels.add(`${pKey}/${modelConfig.id}`);
          }
        }
      }
    }
  }
}

async function getAudioCapableModels(client, api) {
  const now = Date.now();
  if (audioModelsCache && now - audioModelsCacheTime < CACHE_TTL) {
    return audioModelsCache;
  }

  const audioModels = new Set();

  try {
    const globalConfigPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (fs.existsSync(globalConfigPath)) {
      try {
        const content = fs.readFileSync(globalConfigPath, "utf-8");
        const json = JSON.parse(content);
        parseConfigForAudioModels(json, audioModels);
      } catch (err) {
        log("error_reading_global_opencode_json", { message: err.message });
      }
    }

    const projectDir = api?.project?.worktree || api?.project?.directory || process.cwd();
    const localConfigPath = path.join(projectDir, "opencode.json");
    if (fs.existsSync(localConfigPath)) {
      try {
        const content = fs.readFileSync(localConfigPath, "utf-8");
        const json = JSON.parse(content);
        parseConfigForAudioModels(json, audioModels);
      } catch (err) {
        log("error_reading_local_opencode_json", { message: err.message });
      }
    }
  } catch (err) {
    log("filesystem_config_error", { message: err.message });
  }

  try {
    const result = await client.config.providers();
    const providers = result.data?.providers || [];

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
  } catch (err) {
    log("audio_models_detection_error", { message: err.message });
  }

  log("audio_models_detected", {
    count: audioModels.size,
    models: [...audioModels].slice(0, 20),
  });

  audioModelsCache = audioModels;
  audioModelsCacheTime = now;
  return audioModelsCache;
}

async function getActiveModel(client, api) {
  try {
    const globalConfigPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (fs.existsSync(globalConfigPath)) {
      const content = fs.readFileSync(globalConfigPath, "utf-8");
      const json = JSON.parse(content);
      if (json.model) {
        return json.model;
      }
    }
  } catch {}

  try {
    const projectDir = api?.project?.worktree || api?.project?.directory || process.cwd();
    const localConfigPath = path.join(projectDir, "opencode.json");
    if (fs.existsSync(localConfigPath)) {
      const content = fs.readFileSync(localConfigPath, "utf-8");
      const json = JSON.parse(content);
      if (json.model) {
        return json.model;
      }
    }
  } catch {}

  try {
    const configResult = await client.config.get();
    const configModel = configResult.data?.model;
    if (configModel) {
      return configModel;
    }
  } catch {}

  try {
    const providersResult = await client.config.providers();
    const defaults = providersResult.data?.default || {};
    const defaultModel = Object.values(defaults).find((v) => typeof v === "string" && v.includes("/"));
    if (defaultModel) {
      return defaultModel;
    }
  } catch {}

  return null;
}

export async function modelSupportsAudio(api) {
  const client = api.client;

  const audioModels = await getAudioCapableModels(client, api);
  const currentModelId = await getActiveModel(client, api);

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

    const lowerId = currentModelId.toLowerCase();
    const isGeminiOrMimo = lowerId.includes("gemini") || lowerId.includes("mimo");
    if (isGeminiOrMimo) {
      log("heuristic_match", { model: currentModelId });
      return { supportsAudio: true, modelId: currentModelId, reason: `Model ${currentModelId} matches audio heuristics (Gemini/Mimo)` };
    }

    return { supportsAudio: false, modelId: currentModelId, reason: `Model ${currentModelId} does not support audio` };
  }

  if (audioModels.size > 0) {
    return { supportsAudio: false, modelId: null, reason: "Cannot determine active model - use /stt-mode passthrough to force" };
  }

  return { supportsAudio: false, modelId: null, reason: "No audio-capable models found" };
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

// ---- Queue Management for [audio-N] attachments ----

/**
 * Save the recorded file /tmp/opencode-stt.wav to the queue for a session.
 * @returns {string} The tag to inject in the prompt (e.g., "[audio-1]")
 */
export function saveAudioToQueue(sessionID) {
  const validation = validateWavFile(WAV_FILE);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Find next index for this session
  let index = 1;
  while (fs.existsSync(`/tmp/opencode-audio-${sessionID}-${index}.wav`)) {
    index++;
  }

  const destPath = `/tmp/opencode-audio-${sessionID}-${index}.wav`;
  fs.copyFileSync(WAV_FILE, destPath);

  log("audio_queued", { sessionID, index, destPath, sizeBytes: validation.sizeBytes });

  return `[audio-${index}]`;
}

/**
 * Scans message text for [audio-N] tags, encodes the respective WAV files in the queue
 * as base64 FilePartInputs, removes the tags from the text, and cleans up the temporary files.
 *
 * @param {string} sessionID
 * @param {string} text
 * @param {Array} parts
 * @returns {string} The cleaned text without [audio-N] tags
 */
export function interceptAndInjectAudios(sessionID, text, parts) {
  if (!text) return text;

  // Regex to match [audio-1], [audio-2], etc.
  const audioRegex = /\[audio-(\d+)\]/g;
  let match;
  let cleanedText = text;

  // Track if we processed any audios to log at the end
  const processedIndices = [];

  while ((match = audioRegex.exec(text)) !== null) {
    const indexStr = match[1];
    const index = parseInt(indexStr, 10);
    const audioFilePath = `/tmp/opencode-audio-${sessionID}-${index}.wav`;

    if (fs.existsSync(audioFilePath)) {
      const encoded = encodeWavAsDataUrl(audioFilePath);
      if (encoded.success) {
        // Inject as file part
        parts.push({
          type: "file",
          mime: "audio/wav",
          url: encoded.dataUrl,
          filename: `audio-${index}.wav`,
        });

        processedIndices.push(index);

        // Delete temporary file
        try {
          fs.unlinkSync(audioFilePath);
        } catch {}
      }
    }
  }

  if (processedIndices.length > 0) {
    // Remove the [audio-N] tags from the final text part so they aren't processed literally
    cleanedText = cleanedText.replace(/\[audio-\d+\]/g, "").replace(/\s+/g, " ").trim();
    log("chat_message_audio_intercepted", {
      sessionID,
      indices: processedIndices,
      originalTextLength: text.length,
      cleanedTextLength: cleanedText.length,
    });
  }

  return cleanedText;
}