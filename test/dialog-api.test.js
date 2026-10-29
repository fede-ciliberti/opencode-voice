import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../index.js";

// The V1-era api the command modules call: `api.ui.DialogSelect` (the
// descriptor factory) sits NEXT TO `api.ui.dialog.replace/clear`. A earlier
// V2 port nested DialogSelect inside `api.ui.dialog`, so every command threw
// `api.ui.DialogSelect is not a function` and no dialog ever opened.
function fakeContext({ selectResult } = {}) {
  const dialogSelects = [];
  const clears = [];
  return {
    dialogSelects,
    clears,
    client: {},
    ui: {
      toast: { show() {} },
      dialog: {
        async select(options) {
          dialogSelects.push({
            title: options.title,
            current: options.current,
            values: options.options.map((option) => option.value),
            titles: options.options.map((option) => option.title),
          });
          return selectResult;
        },
        clear() {
          clears.push(true);
        },
      },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("api.ui exposes the V1 dialog surface at both paths", () => {
  const api = createApi(fakeContext(), { get: (_k, d) => d, set() {} });

  assert.equal(typeof api.ui.DialogSelect, "function");
  assert.equal(typeof api.ui.dialog.replace, "function");
  assert.equal(typeof api.ui.dialog.clear, "function");
  // The nested path keeps working for code that reaches it directly.
  assert.equal(typeof api.ui.dialog.DialogSelect, "function");
});

test("replace opens the V2 select dialog and routes the choice to the option's onSelect", async () => {
  const context = fakeContext({ selectResult: "bryce" });
  const api = createApi(context, null);
  const applied = [];

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Select voice",
      current: "ryan",
      options: [
        { title: "Ryan (high)", value: "ryan", onSelect: () => applied.push("ryan") },
        { title: "Bryce (medium)", value: "bryce", onSelect: () => applied.push("bryce") },
      ],
    }),
  );
  await flush();

  assert.deepEqual(context.dialogSelects, [
    {
      title: "Select voice",
      current: "ryan",
      values: ["ryan", "bryce"],
      titles: ["Ryan (high)", "Bryce (medium)"],
    },
  ]);
  assert.deepEqual(applied, ["bryce"]);
});

test("dismissing the dialog never calls an onSelect", async () => {
  const context = fakeContext({ selectResult: undefined });
  const api = createApi(context, null);
  const applied = [];

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Select microphone",
      current: "",
      options: [{ title: "System default", value: "", onSelect: () => applied.push("default") }],
    }),
  );
  await flush();

  assert.deepEqual(applied, []);
  assert.equal(context.dialogSelects.length, 1);
});

test("clear passes through to the V2 dialog", () => {
  const context = fakeContext();
  const api = createApi(context, null);

  api.ui.dialog.clear();

  assert.equal(context.clears.length, 1);
});
