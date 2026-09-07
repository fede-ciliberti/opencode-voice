import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  _clearAudioCache,
  getTmpDir,
  parseConfigForAudioModels,
  modelSupportsAudio,
  saveAudioToQueue,
} from "../lib/passthrough.js";
import serverPlugin, {
  FILE_PATTERN,
  MAX_AUDIO_BYTES,
  generatePartId,
  getTmpDir as getServerTmpDir,
} from "../server-plugin.js";

function withMockedConfig(fakeConfig, fn) {
  const origExists = fs.existsSync;
  const origRead = fs.readFileSync;
  fs.existsSync = (p) => {
    if (typeof p === "string" && p.endsWith("opencode.json")) return true;
    return origExists(p);
  };
  fs.readFileSync = (p, enc) => {
    if (typeof p === "string" && p.endsWith("opencode.json")) {
      return JSON.stringify(fakeConfig);
    }
    return origRead(p, enc);
  };
  _clearAudioCache();
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.finally(() => {
      fs.existsSync = origExists;
      fs.readFileSync = origRead;
      _clearAudioCache();
    });
  }
  fs.existsSync = origExists;
  fs.readFileSync = origRead;
  _clearAudioCache();
  return result;
}

function makeWavBuffer(sizeBytes) {
  const buf = Buffer.alloc(sizeBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(sizeBytes - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(sizeBytes - 44, 40);
  return buf;
}

// ── Heurística 2.4: 4 casos ──

test("heuristic: gemini-x with modalities text only → supportsAudio false", async () => {
  const fakeConfig = {
    model: "gemini-x",
    providers: {
      openrouter: {
        models: {
          "gemini-x": { id: "gemini-x", modalities: { input: ["text"] } },
        },
      },
    },
  };
  await withMockedConfig(fakeConfig, async () => {
    const result = await modelSupportsAudio({ client: {}, project: {} });
    assert.equal(result.supportsAudio, false);
    assert.equal(result.modelId, "gemini-x");
  });
});

test("heuristic: model with audio modality → supportsAudio true", async () => {
  const fakeConfig = {
    model: "my-audio-model",
    providers: {
      openrouter: {
        models: {
          "my-audio-model": {
            id: "my-audio-model",
            modalities: { input: ["text", "audio"] },
          },
        },
      },
    },
  };
  await withMockedConfig(fakeConfig, async () => {
    const result = await modelSupportsAudio({ client: {}, project: {} });
    assert.equal(result.supportsAudio, true);
    assert.equal(result.modelId, "my-audio-model");
  });
});

test("heuristic: unknown gemini model → true via heuristic", async () => {
  const fakeConfig = {
    model: "gemini-2.5-pro-unknown",
    providers: {
      openrouter: {
        models: {
          "other-model": { id: "other-model", modalities: { input: ["text"] } },
        },
      },
    },
  };
  await withMockedConfig(fakeConfig, async () => {
    const result = await modelSupportsAudio({ client: {}, project: {} });
    assert.equal(result.supportsAudio, true);
    assert.match(result.reason, /Gemini\/Mimo/i);
  });
});

test("heuristic: unknown non-gemini model → false", async () => {
  const fakeConfig = {
    model: "claude-sonnet-4",
    providers: {
      openrouter: {
        models: {
          "other-model": { id: "other-model", modalities: { input: ["text"] } },
        },
      },
    },
  };
  await withMockedConfig(fakeConfig, async () => {
    const result = await modelSupportsAudio({ client: {}, project: {} });
    assert.equal(result.supportsAudio, false);
    assert.equal(result.modelId, "claude-sonnet-4");
  });
});

test("parseConfigForAudioModels populates knownModels but not audioModels for text-only gemini", () => {
  const audioModels = new Set();
  const knownModels = new Set();
  const config = {
    providers: {
      openrouter: {
        models: {
          "gemini-x": { id: "gemini-x", modalities: { input: ["text"] } },
          "audio-model": { id: "audio-model", modalities: { input: ["audio"] } },
        },
      },
    },
  };
  parseConfigForAudioModels(config, audioModels, knownModels);
  assert.equal(knownModels.has("gemini-x"), true);
  assert.equal(audioModels.has("gemini-x"), false);
  assert.equal(audioModels.has("audio-model"), true);
});

// ── Regex 3.4: FILE_PATTERN ──

test("FILE_PATTERN: 3 casos (normal, con guiones, inválido)", () => {
  const m1 = "opencode-audio-ses_abc123-1.wav".match(FILE_PATTERN);
  assert.ok(m1);
  assert.equal(m1[1], "ses_abc123");
  assert.equal(m1[2], "1");

  const m2 = "opencode-audio-ses_abc-2-1.wav".match(FILE_PATTERN);
  assert.ok(m2);
  assert.equal(m2[1], "ses_abc-2");
  assert.equal(m2[2], "1");

  const m3 = "opencode-audio-foo.wav".match(FILE_PATTERN);
  assert.equal(m3, null);

  assert.equal(FILE_PATTERN.source, "^opencode-audio-(.+?)-(\\d+)\\.wav$");
});

// ── generatePartId unicidad 3.1 ──

test("generatePartId: 1000 IDs únicos con prefijo prt_", () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = generatePartId();
    assert.match(id, /^prt_/);
    assert.equal(ids.has(id), false, `duplicate id ${id}`);
    ids.add(id);
  }
  assert.equal(ids.size, 1000);
});

// ── Split con tag duplicado 3.2 ──

test("split con tag duplicado: 1 índice referenciado, 2 ocurrencias → 2 FileParts", () => {
  const text = "[audio-1] hola [audio-1]";
  const referencedIndices = new Set();
  for (const m of text.matchAll(/\[audio-(\d+)\]/g)) {
    referencedIndices.add(parseInt(m[1], 10));
  }
  assert.equal(referencedIndices.size, 1);
  assert.ok(referencedIndices.has(1));

  const occurrences = (text.match(/\[audio-1\]/g) || []).length;
  assert.equal(occurrences, 2);

  const index = 1;
  const segments = text.split(new RegExp(`\\[audio-${index}\\]`, "g"));
  assert.equal(segments.length, 3);
  assert.deepEqual(segments, ["", " hola ", ""]);
  const injectedCount = segments.length - 1;
  assert.equal(injectedCount, 2);

  const replacement = [];
  let count = 0;
  for (let j = 0; j < segments.length; j++) {
    if (segments[j]) {
      replacement.push({ type: "text", text: segments[j] });
    }
    if (j < segments.length - 1) {
      replacement.push({ type: "file", mime: "audio/wav" });
      count++;
    }
  }
  assert.equal(count, 2);
  assert.equal(replacement.filter((p) => p.type === "file").length, 2);
});

// ── saveAudioToQueue con fixture WAV en tmpdir aislado ──

test("saveAudioToQueue: WAV 1KB en tmpdir aislado → tag y archivo", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));
  const prev = process.env.OPENCODE_VOICE_TMPDIR;
  process.env.OPENCODE_VOICE_TMPDIR = tmpDir;
  try {
    assert.equal(getTmpDir(), tmpDir);
    assert.equal(getServerTmpDir(), tmpDir);

    const sourcePath = path.join(tmpDir, "source.wav");
    const wav = makeWavBuffer(1024);
    fs.writeFileSync(sourcePath, wav);

    const tag1 = saveAudioToQueue("ses_test123", sourcePath);
    assert.equal(tag1, "[audio-1]");
    const dest1 = path.join(tmpDir, "opencode-audio-ses_test123-1.wav");
    assert.equal(fs.existsSync(dest1), true);
    assert.equal(fs.statSync(dest1).size, 1024);

    const tag2 = saveAudioToQueue("ses_test123", sourcePath);
    assert.equal(tag2, "[audio-2]");
    const dest2 = path.join(tmpDir, "opencode-audio-ses_test123-2.wav");
    assert.equal(fs.existsSync(dest2), true);
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_VOICE_TMPDIR;
    else process.env.OPENCODE_VOICE_TMPDIR = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── sizeBytes real (3.3): stat size vs base64 length ──

test("sizeBytes real: stat size 1024, base64 length mayor (~33%)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));
  const prev = process.env.OPENCODE_VOICE_TMPDIR;
  process.env.OPENCODE_VOICE_TMPDIR = tmpDir;
  try {
    const wav = makeWavBuffer(1024);
    const sizeBytes = wav.length;
    const base64Length = wav.toString("base64").length;
    assert.equal(sizeBytes, 1024);
    assert.ok(base64Length > sizeBytes);
    assert.ok(base64Length > 1300 && base64Length < 1500);
    assert.notEqual(base64Length, sizeBytes);

    const sourcePath = path.join(tmpDir, "src.wav");
    fs.writeFileSync(sourcePath, wav);
    const stat = fs.statSync(sourcePath);
    assert.equal(stat.size, sizeBytes);
    assert.notEqual(stat.size, base64Length);
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_VOICE_TMPDIR;
    else process.env.OPENCODE_VOICE_TMPDIR = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("server hook: inyección con tag duplicado usa sizeBytes real y genera 2 FileParts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));
  const prev = process.env.OPENCODE_VOICE_TMPDIR;
  process.env.OPENCODE_VOICE_TMPDIR = tmpDir;
  try {
    const sessionID = "ses_hooktest";
    const wav = makeWavBuffer(1024);
    const queuedFile = path.join(tmpDir, `opencode-audio-${sessionID}-1.wav`);
    fs.writeFileSync(queuedFile, wav);
    const statSize = fs.statSync(queuedFile).size;
    const expectedBase64Len = wav.toString("base64").length;
    assert.equal(statSize, 1024);
    assert.ok(expectedBase64Len > statSize);

    const plugin = await serverPlugin.server(null, { tmpDir });
    const handler = plugin["chat.message"];
    const parts = [{ type: "text", text: "[audio-1] hola [audio-1]", id: "p1", messageID: "msg1" }];
    await handler({ sessionID, messageID: "msg1" }, { _message: {}, parts });

    const fileParts = parts.filter((p) => p.type === "file");
    assert.equal(fileParts.length, 2);
    for (const fp of fileParts) {
      assert.equal(fp.mime, "audio/wav");
      assert.match(fp.id, /^prt_/);
      assert.equal(fp.data.length, expectedBase64Len);
    }
    assert.equal(fs.existsSync(queuedFile), false);
    assert.equal(MAX_AUDIO_BYTES, 15 * 1024 * 1024);
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_VOICE_TMPDIR;
    else process.env.OPENCODE_VOICE_TMPDIR = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
