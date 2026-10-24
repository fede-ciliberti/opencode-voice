// Wiring de los comandos V1 ({title, value, keybind, slash, onSelect}) al
// keyInput del renderer V2. No usa Keymap.Provider (no disponible fuera de un
// componente montado).

function normalizeBind(bind, leader) {
  return String(bind)
    .replace(/<leader>/gi, leader + " ")
    .replace(/[<>]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function keyOf(event) {
  const parts = [];
  if (event?.ctrl) parts.push("ctrl");
  if (event?.shift) parts.push("shift");
  if (event?.alt) parts.push("alt");
  if (event?.super || event?.meta) parts.push("super");
  parts.push(String(event?.name ?? "").toLowerCase());
  return parts.join("+");
}

export function createKeybindings(context, commands, log = () => {}, leader = "ctrl+x") {
  const byKey = new Map();
  for (const c of commands) {
    if (!c?.keybind) continue;
    const k = normalizeBind(c.keybind, leader);
    if (!byKey.has(k)) byKey.set(k, c);
  }
  log("keybinds.registered", { keys: [...byKey.keys()] });

  let pendingLeader = false;
  let leaderTimer = null;

  function run(cmd, event) {
    try {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const r = cmd.onSelect?.();
      if (r && typeof r.catch === "function") r.catch((e) => log("keybind.error", { value: cmd.value, error: String(e) }));
    } catch (e) {
      log("keybind.error", { value: cmd.value, error: String(e) });
    }
  }

  function handler(event) {
    if (event?.__voiceHandled) return;
    const key = keyOf(event);

    if (pendingLeader) {
      pendingLeader = false;
      clearTimeout(leaderTimer);
      const cmd = byKey.get(`${leader} ${key}`);
      if (cmd) {
        event.__voiceHandled = true;
        run(cmd, event);
        return;
      }
    }

    if (key === leader) {
      pendingLeader = true;
      clearTimeout(leaderTimer);
      leaderTimer = setTimeout(() => (pendingLeader = false), 1500);
      event.__voiceHandled = true;
      event?.preventDefault?.();
      return;
    }

    const cmd = byKey.get(key);
    if (cmd) {
      event.__voiceHandled = true;
      run(cmd, event);
    }
  }

  const keyInput = context.renderer?.keyInput;
  if (!keyInput?.prependListener) {
    log("keybinds.no_keyinput");
    return () => {};
  }
  const g = globalThis;
  if (g.__voiceOnKey) {
    try {
      keyInput.off?.("keypress", g.__voiceOnKey);
      keyInput.removeListener?.("keypress", g.__voiceOnKey);
    } catch {}
  }
  g.__voiceOnKey = handler;
  keyInput.prependListener("keypress", handler);

  return () => {
    try {
      keyInput.off?.("keypress", handler);
      keyInput.removeListener?.("keypress", handler);
    } catch {}
    if (g.__voiceOnKey === handler) delete g.__voiceOnKey;
  };
}
