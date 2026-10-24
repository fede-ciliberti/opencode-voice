import { test } from "node:test";
import assert from "node:assert/strict";
import { createComplete } from "../v2/normalize.js";
import { createKeybindings } from "../v2/keybinds.js";
import { createAdapter } from "../v2/adapter.js";

// ---------- normalización configurable ----------

test("normalize: disabled -> no llama al LLM y devuelve error 'normalization disabled'", async () => {
  let called = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    called++;
    return new Response("{}", { status: 200 });
  };
  try {
    const { complete, enabled } = createComplete({ normalize: false, endpoint: "http://x/v1", model: "m" });
    assert.equal(enabled, false);
    const res = await complete({ prompt: "hola" });
    assert.equal(res.text, null);
    assert.equal(res.error, "normalization disabled");
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("normalize: normalizeModel override se usa en el request", async () => {
  let body = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    const { complete } = createComplete({ endpoint: "http://x/v1", model: "base", normalizeModel: "norm-model" });
    const res = await complete({ prompt: "hola" });
    assert.equal(res.text, "ok");
    assert.equal(body.model, "norm-model");
  } finally {
    globalThis.fetch = original;
  }
});

test("normalize: default usa model si no hay normalizeModel", async () => {
  let body = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    const { complete } = createComplete({ endpoint: "http://x/v1", model: "base" });
    await complete({ prompt: "hola" });
    assert.equal(body.model, "base");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- keybinds ----------

function fakeKeyContext() {
  const handlers = [];
  return {
    renderer: {
      keyInput: {
        prependListener: (_ev, h) => handlers.push(h),
        off: () => {},
        removeListener: () => {},
      },
    },
    fire: (event) => handlers.forEach((h) => h(event)),
  };
}

test("keybinds: f5 dispara el comando", () => {
  const ctx = fakeKeyContext();
  let hits = 0;
  createKeybindings(ctx, [{ value: "stt.record", keybind: "f5", onSelect: () => hits++ }]);
  ctx.fire({ name: "f5" });
  assert.equal(hits, 1);
});

test("keybinds: secuencia <leader>s dispara el comando", () => {
  const ctx = fakeKeyContext();
  let hits = 0;
  createKeybindings(ctx, [{ value: "tts.speak-last", keybind: "<leader>s", onSelect: () => hits++ }]);
  ctx.fire({ name: "x", ctrl: true });
  ctx.fire({ name: "s" });
  assert.equal(hits, 1);
});

test("keybinds: tecla no mapeada no dispara nada", () => {
  const ctx = fakeKeyContext();
  let hits = 0;
  createKeybindings(ctx, [{ value: "stt.record", keybind: "f5", onSelect: () => hits++ }]);
  ctx.fire({ name: "a" });
  assert.equal(hits, 0);
});

test("keybinds: una sola vez por evento (marca en el evento)", () => {
  const ctx = fakeKeyContext();
  let hits = 0;
  createKeybindings(ctx, [{ value: "stt.record", keybind: "f5", onSelect: () => hits++ }]);
  const ev = { name: "f5" };
  ctx.fire(ev);
  ctx.fire(ev);
  assert.equal(hits, 1);
});

// ---------- adaptador ----------

function fakeAdapterContext(overrides = {}) {
  const stored = {};
  const context = {
    storage: {
      store: () => [stored, async (fn) => fn(stored)],
    },
    renderer: {
      currentFocusedEditor: null,
      on: () => {},
      requestRender: () => {},
    },
    ui: {
      toast: { show: () => {} },
      dialog: {
        select: async () => "chosen",
        prompt: async () => "typed",
        confirm: async () => true,
        clear: () => {},
      },
    },
    uiRouterCurrent: { type: "session", sessionID: "ses_1" },
    data: {
      session: {
        message: {
          list: () => [
            { id: "m1", type: "user" },
            { id: "m2", type: "assistant" },
          ],
        },
        get: (id) => ({ id, location: { directory: "/proj" } }),
      },
    },
    client: {
      session: {
        list: async () => ({ data: [] }),
        message: { get: async () => ({ data: { content: [{ type: "text", text: "hi" }] } }) },
      },
    },
    location: { directory: "/proj" },
    ...overrides,
  };
  context.ui.router = { current: () => context.uiRouterCurrent };
  return context;
}

test("adapter: kv get/set y forzado de stt.mode a whisper-api", () => {
  const ctx = fakeAdapterContext();
  const { kv } = createAdapter(ctx);
  assert.equal(kv.get("nope", "def"), "def");
  kv.set("stt.voice", "ryan");
  assert.equal(kv.get("stt.voice"), "ryan");
  kv.set("stt.mode", "passthrough");
  assert.equal(kv.get("stt.mode"), "whisper-api");
  assert.equal(kv.get("stt.mode", "x"), "whisper-api");
});

test("adapter: route.current mapea sesión a {name,params}", () => {
  const ctx = fakeAdapterContext();
  const { api } = createAdapter(ctx);
  assert.deepEqual(api.route.current, { name: "session", params: { sessionID: "ses_1" } });
});

test("adapter: state.session.messages mapea type->role", () => {
  const ctx = fakeAdapterContext();
  const { api } = createAdapter(ctx);
  assert.deepEqual(api.state.session.messages("ses_1"), [
    { id: "m1", role: "user" },
    { id: "m2", role: "assistant" },
  ]);
});

test("adapter: state.session.get expone directory", () => {
  const ctx = fakeAdapterContext();
  const { api } = createAdapter(ctx);
  assert.equal(api.state.session.get("ses_1").directory, "/proj");
});

test("adapter: client.session.message normaliza content->parts", async () => {
  const ctx = fakeAdapterContext();
  const { api } = createAdapter(ctx);
  const res = await api.client.session.message({ sessionID: "ses_1", messageID: "m2" });
  assert.deepEqual(res.data.parts, [{ type: "text", text: "hi" }]);
});

test("adapter: ui.dialog.replace(select) llama onSelect con el valor elegido", async () => {
  const ctx = fakeAdapterContext();
  ctx.ui.dialog.select = async () => "b";
  const { api } = createAdapter(ctx);
  let picked = null;
  api.ui.dialog.replace(() =>
    api.ui.dialog.DialogSelect({
      title: "t",
      options: [
        { title: "A", value: "a", onSelect: () => (picked = "a") },
        { title: "B", value: "b", onSelect: () => (picked = "b") },
      ],
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(picked, "b");
});

test("adapter: ui.dialog.replace(confirm) llama onConfirm si acepta", async () => {
  const ctx = fakeAdapterContext();
  const { api } = createAdapter(ctx);
  let confirmed = false;
  api.ui.dialog.replace(() =>
    api.ui.dialog.DialogConfirm({ title: "t", message: "m", onConfirm: () => (confirmed = true) }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(confirmed, true);
});
