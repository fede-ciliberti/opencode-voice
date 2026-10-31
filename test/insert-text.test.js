import { test } from "node:test";
import assert from "node:assert/strict";

import { findInsertable, insertAtCursor } from "../index.js";

function leaf(extra = {}) {
  return { getChildren: () => [], ...extra };
}

test("findInsertable devuelve el nodo si acepta texto", () => {
  const editor = leaf({ insertText: () => {} });
  assert.equal(findInsertable(editor), editor);
});

test("findInsertable busca en profundidad dentro de los hijos", () => {
  const editor = leaf({ insertText: () => {} });
  const wrapper = { getChildren: () => [{ getChildren: () => [] }, editor] };
  assert.equal(findInsertable(wrapper), editor);
});

test("findInsertable devuelve null cuando nada acepta texto", () => {
  assert.equal(findInsertable(null), null);
  assert.equal(findInsertable({ getChildren: () => [] }), null);
  assert.equal(findInsertable({ getChildren: () => [leaf()] }), null);
});

test("insertAtCursor escribe en el renderable enfocado", () => {
  let inserted = null;
  const editor = leaf({ insertText: (text) => (inserted = text) });
  const renderer = { currentFocusedRenderable: { getChildren: () => [editor] } };
  assert.equal(insertAtCursor(renderer, "hola 1, 2, 3"), true);
  assert.equal(inserted, "hola 1, 2, 3");
});

test("insertAtCursor devuelve false si el foco no es editable", () => {
  const renderer = { currentFocusedRenderable: { getChildren: () => [leaf()] } };
  assert.equal(insertAtCursor(renderer, "hola"), false);
});

test("insertAtCursor devuelve false sin foco o sin renderer", () => {
  assert.equal(insertAtCursor({ currentFocusedRenderable: null }, "hola"), false);
  assert.equal(insertAtCursor(undefined, "hola"), false);
});
