import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getGlossaryPath } from "../lib/glossary.js";

const GLOSSARY_URL = new URL("../lib/glossary.js", import.meta.url).href;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "voice-glossary-test-"));
}

// Regresión: el plugin corre dentro del TUI. Si `git rev-parse` hereda stderr,
// su error ("fatal: not a git repository" / "Stopping at filesystem boundary")
// se escribe encima del prompt. Fuera de un repo, stderr debe quedar vacío.
test("getGlossaryPath no escribe en stderr cuando git falla", () => {
  const dir = tempDir();
  try {
    const script = `
      import { getGlossaryPath } from ${JSON.stringify(GLOSSARY_URL)};
      process.stdout.write(getGlossaryPath());
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
    assert.match(res.stdout, /\.opencode\/voice-glossary\.json$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("usa api.project.directory sin invocar a git", () => {
  const dir = tempDir();
  try {
    const file = getGlossaryPath({ project: { directory: dir } });
    assert.equal(file, path.join(dir, ".opencode", "voice-glossary.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("la sesión tiene prioridad sobre api.project", () => {
  const sessionDir = tempDir();
  const projectDir = tempDir();
  try {
    const api = {
      state: { session: { get: () => ({ directory: sessionDir }) } },
      project: { directory: projectDir },
    };
    const file = getGlossaryPath(api, "ses_test");
    assert.equal(file, path.join(sessionDir, ".opencode", "voice-glossary.json"));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
