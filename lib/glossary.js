import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export function getSessionDirectory(api, sessionID) {
  if (!sessionID) return null;
  try {
    const session = api?.state?.session?.get?.(sessionID);
    const dir = session?.directory;
    if (typeof dir === "string" && dir.trim()) return dir.trim();
  } catch {}
  return null;
}

function getProjectRoot(api, sessionID) {
  const dir = getSessionDirectory(api, sessionID);
  if (dir) return dir;
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (gitRoot && fs.existsSync(gitRoot)) return gitRoot;
  } catch {}
  return process.cwd();
}

export function getGlossaryPath(rootOrApi, maybeSessionID) {
  let base = null;
  if (typeof rootOrApi === "string" && rootOrApi) {
    base = rootOrApi;
  } else if (rootOrApi && typeof rootOrApi === "object") {
    base = getProjectRoot(rootOrApi, maybeSessionID);
  } else {
    base = getProjectRoot();
  }
  return path.join(base, ".opencode", "voice-glossary.json");
}

function normalizeMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const source = raw.terms && typeof raw.terms === "object" ? raw.terms : raw;
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === "updatedAt" || k === "terms") continue;
    if (typeof k !== "string" || !k.trim()) continue;
    const variants = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
    out[k.trim()] = [...new Set(variants)];
  }
  return out;
}

export function loadGlossary(rootOrApi, maybeSessionID) {
  const file = getGlossaryPath(rootOrApi, maybeSessionID);
  let map = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    map = normalizeMap(raw);
  } catch {
    map = {};
  }
  return { map, file };
}

export function saveGlossary(map, rootOrApi, maybeSessionID) {
  const file = getGlossaryPath(rootOrApi, maybeSessionID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { terms: map, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  return file;
}

export function formatGlossaryForPrompt(map, maxTerms = 30) {
  const entries = Object.entries(map);
  if (entries.length === 0) return "";
  const lines = entries.slice(0, maxTerms).map(([canon, variants]) => {
    if (variants.length === 0) return `- ${canon}`;
    return `- ${canon} (variantes: ${variants.join(", ")})`;
  });
  let text = lines.join("\n");
  if (text.length > 800) text = text.slice(0, 800);
  return text;
}

export function mergeGlossary(base, incoming) {
  const out = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    if (!out[k]) out[k] = [...new Set(v)];
    else out[k] = [...new Set([...out[k], ...v])];
  }
  return out;
}

export function parseGeneratedJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const obj = JSON.parse(cleaned);
  return normalizeMap(obj.terms ? obj : { terms: obj });
}
