import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// V2 removed the V1 `client.app.log` sink, so diagnostics only leave the
// process when debugging is explicitly enabled: OPENCODE_VOICE_DEBUG=1
// appends to ~/.local/state/opencode-voice/debug.log. Without the env var
// logging is a no-op; it must never interrupt voice features either way.
const LOG_FILE = path.join(os.homedir(), ".local", "state", "opencode-voice", "debug.log");

export function createLogger() {
  const enabled = Boolean(process.env.OPENCODE_VOICE_DEBUG);

  function log(scope, message, level = "debug") {
    if (!enabled) return;
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level} [${scope}] ${message}\n`);
    } catch {
      // Logging should never interrupt voice features.
    }
  }

  return { log };
}
