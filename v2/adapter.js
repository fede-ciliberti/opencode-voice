// Adaptador V1 -> V2 para reutilizar lib/stt.js y lib/tts.js sin reescribirlos.
//
// Expone la superficie que esos módulos consumen de la API del plugin V1
// (api.kv, api.ui.toast, api.ui.dialog.*, api.route, api.state.session,
// api.event, api.client) respaldada por el contexto V2.

function roleOf(m) {
  if (!m) return undefined;
  if (m.role) return m.role;
  if (m.type === "assistant") return "assistant";
  if (m.type === "user") return "user";
  return m.type;
}

function partsOf(data) {
  if (!data) return [];
  if (Array.isArray(data.parts)) return data.parts;
  if (Array.isArray(data.content)) {
    return data.content.map((c) =>
      c && c.type === "text" ? { type: "text", text: c.text } : c,
    );
  }
  return [];
}

export function createAdapter(context, log = () => {}) {
  // ---- kv sobre context.storage.store (persistente) ----
  let settings = {};
  let update = async () => {};
  try {
    const store = context.storage?.store?.("voice.settings", { initial: {} });
    if (Array.isArray(store)) {
      const value = store[0];
      settings = { ...(typeof value === "function" ? value() : value) };
      if (typeof store[1] === "function") update = store[1];
    }
  } catch (e) {
    log("adapter.storage.error", { error: String(e) });
  }
  // Passthrough no soportado en V2: forzar whisper-api.
  function readMode() {
    const m = settings["stt.mode"];
    if (!m || m === "auto" || m === "passthrough") return "whisper-api";
    return m;
  }
  const kv = {
    get(key, def) {
      if (key === "stt.mode") return readMode();
      return key in settings ? settings[key] : def;
    },
    set(key, value) {
      if (key === "stt.mode" && (value === "auto" || value === "passthrough")) value = "whisper-api";
      settings[key] = value;
      try {
        void update((draft) => {
          draft[key] = value;
        });
      } catch (e) {
        log("adapter.kv.persist.error", { key, error: String(e) });
      }
    },
  };

  // ---- editor enfocado (insertar en el composer) ----
  let lastEditor = null;
  try {
    context.renderer?.on?.("focused_editor", (ed) => {
      if (ed) lastEditor = ed;
    });
  } catch {}
  function focusedEditor() {
    const ed = context.renderer?.currentFocusedEditor;
    if (ed && !ed.isDestroyed) return ed;
    if (lastEditor && !lastEditor.isDestroyed) return lastEditor;
    return null;
  }
  function insertAtCursor(text) {
    const ed = focusedEditor();
    if (!ed) {
      log("adapter.insert.no_editor", { text });
      throw new Error("no hay editor enfocado");
    }
    ed.insertText(text);
    context.renderer?.requestRender?.();
  }

  // ---- diálogos ----
  const dialog = {
    DialogSelect: (opts) => ({ kind: "select", opts }),
    DialogPrompt: (opts) => ({ kind: "prompt", opts }),
    DialogConfirm: (opts) => ({ kind: "confirm", opts }),
    clear: () => {
      try {
        context.ui?.dialog?.clear?.();
      } catch {}
    },
    replace: (factory) => {
      void (async () => {
        let desc;
        try {
          desc = typeof factory === "function" ? factory() : factory;
        } catch (e) {
          log("adapter.dialog.factory.error", { error: String(e) });
          return;
        }
        try {
          if (desc.kind === "select") {
            const o = desc.opts || {};
            const value = await context.ui.dialog.select({
              title: o.title,
              current: o.current,
              options: (o.options || []).map((x) => ({
                title: x.title,
                value: x.value,
                description: x.description,
                disabled: x.disabled,
              })),
            });
            const chosen = (o.options || []).find((x) => x.value === value);
            chosen?.onSelect?.();
          } else if (desc.kind === "prompt") {
            const o = desc.opts || {};
            const value = await context.ui.dialog.prompt({
              title: o.title,
              placeholder: o.placeholder,
              value: o.value,
            });
            o.onConfirm?.(value ?? "");
          } else if (desc.kind === "confirm") {
            const o = desc.opts || {};
            const ok = await context.ui.dialog.confirm({ title: o.title, message: o.message });
            if (ok) o.onConfirm?.();
            else o.onCancel?.();
          }
        } catch (e) {
          log("adapter.dialog.error", { error: String(e) });
          desc?.opts?.onCancel?.();
        }
      })();
    },
  };

  // ---- route ----
  const route = {
    get current() {
      let r = { type: "home" };
      try {
        r = context.ui.router.current() || r;
      } catch {}
      if (r.type === "session") return { name: "session", params: { sessionID: r.sessionID } };
      return { name: r.type || "home", params: {} };
    },
    navigate(name, params = {}) {
      try {
        if (name === "session") context.ui.router.navigate({ type: "session", sessionID: params.sessionID });
        else context.ui.router.navigate({ type: name });
      } catch (e) {
        log("adapter.route.error", { error: String(e) });
      }
    },
  };

  // ---- state.session ----
  const state = {
    session: {
      messages(sessionID) {
        try {
          const list = context.data?.session?.message?.list?.(sessionID) ?? [];
          return list.map((m) => ({ id: m.id, role: roleOf(m) }));
        } catch {
          return [];
        }
      },
      get(sessionID) {
        try {
          const s = context.data?.session?.get?.(sessionID);
          if (!s) return undefined;
          return { ...s, directory: s.location?.directory ?? s.directory };
        } catch {
          return undefined;
        }
      },
    },
  };

  // ---- client (SDK-like) ----
  const client = {
    session: {
      async list() {
        try {
          const r = await context.client.session.list();
          return { data: r?.data ?? r ?? [] };
        } catch {
          return { data: [] };
        }
      },
      async message(input) {
        const { sessionID, messageID } = input || {};
        try {
          const s = context.client?.session;
          let raw;
          if (s?.message?.get) raw = await s.message.get({ sessionID, messageID });
          else if (typeof s?.message === "function") raw = await s.message({ sessionID, messageID });
          const data = raw?.data ?? raw;
          return { data: { ...data, parts: partsOf(data) } };
        } catch {
          return { data: { parts: [] } };
        }
      },
    },
    tui: {
      async appendPrompt({ text }) {
        insertAtCursor(text);
      },
    },
  };

  // ---- events ----
  const event = {
    on(type, handler) {
      try {
        return context.data.on(type, (e) => handler({ type: e.type, properties: e.data ?? {} }));
      } catch (e) {
        log("adapter.event.error", { type, error: String(e) });
        return () => {};
      }
    },
  };

  const api = {
    kv,
    route,
    state,
    event,
    client,
    ui: {
      toast: ({ message, variant = "info", duration = 3000 } = {}) => {
        try {
          context.ui.toast.show({ message, variant, duration });
        } catch (e) {
          log("adapter.toast.error", { error: String(e) });
        }
      },
      dialog,
    },
    // stubs para que passthrough (no usado en V2) no explote si se toca
    project: { worktree: context.location?.project?.canonical, directory: context.location?.directory },
  };

  return { api, kv, insertAtCursor, focusedEditor };
}
