# Plan de Migración V1 → V2 — `opencode-voice`

> **Documento maestro**. Este archivo es el único entregable del trabajo de planificación. No modifica código.
> **Autoría**: subagente arquitecto. **Fecha**: 2026-09-28. **Estado**: propuesta para revisión de Fede.
>
> Regla de fuentes: toda afirmación sobre el código actual cita `archivo:línea` y fue leída del working tree; toda
> afirmación sobre OpenCode V2 cita una URL de `https://opencode.ai/v2/docs/...` o un tipo publicado del paquete npm
> (`@opencode/plugin@2.0.18`, `@opencode/client@2.0.18`). Lo que no pude confirmar está marcado **⚠️ a verificar**.

---

## Índice

1. [Resumen ejecutivo, alcance y supuestos](#1-resumen-ejecutivo-alcance-y-supuestos)
2. [Inventario de la superficie V1 usada](#2-inventario-de-la-superficie-v1-usada)
3. [Tabla de equivalencias V1→V2 y decisión cut/dual](#3-tabla-de-equivalencias-v1v2-y-decisión-cutdual)
4. [Cambios por archivo](#4-cambios-por-archivo)
5. [Configuración y registro](#5-configuración-y-registro)
6. [Dependencias y packaging](#6-dependencias-y-packaging)
7. [Estrategia de test y verificación](#7-estrategia-de-test-y-verificación)
8. [Riesgos, gotchas y preguntas abiertas](#8-riesgos-gotchas-y-preguntas-abiertas)
9. [Plan por fases con criterios de aceptación](#9-plan-por-fases-con-criterios-de-aceptación)
10. [Fuentes](#10-fuentes)

---

## 1. Resumen ejecutivo, alcance y supuestos

### 1.1 Qué es

`opencode-voice` es un plugin DUAL de OpenCode que agrega STT (grabar → transcribir con whisper → normalizar con un
LLM → insertar en el prompt) y TTS (leer respuestas del asistente con Piper). El paquete expone dos entrypoints en dos
procesos:

- **TUI** (`index.js`): grabación, comandos, diálogos, toasts, persistencia de preferencias.
- **Server** (`server-plugin.js`): hook `chat.message` que reemplaza las etiquetas `[audio-N]` del prompt por
  `FilePart`s de audio antes de que el mensaje llegue al modelo.

### 1.2 Decisión en una línea

**Recomendación: modo DUAL V1+V2** (agregar la implementación V2 sin romper la V1), con un *trigger* de cut definido
en §3.4. La razón de fondo es un bloqueante verificado: **OpenCode V2 2.0.18 no expone ninguna API para que un plugin
inserte texto en el composer del TUI**, y tanto el STT como el passthrough dependen de eso (`lib/stt.js:885,942,953`).

### 1.3 Alcance

Incluido: plan de port a V2 de `index.js`, `server-plugin.js`, `lib/stt.js`, `lib/tts.js`, `lib/passthrough.js`,
`lib/session.js`, `lib/glossary.js`, `package.json` (exports/deps), config global de Fede, y estrategia de tests.

Excluido: implementación (no se toca código en este trabajo); migración de otros plugins de Fede; migración del
`tui.json` global más allá de lo necesario para registrar este plugin.

### 1.4 Supuestos

- **Baseline = el working tree actual** de `/home/fciliberti/Trabajos/Tools/opencode-voice` en la branch
  `feat/audio-passthrough` (con `M README.md`, `M lib/stt.js`, `?? lib/glossary.js`, `?? .opencode/`). **No** asumo
  que el tag `v0.6.0` == working tree; de hecho `package.json:3` dice `"version": "0.1.0"` (stale) mientras hay tags
  hasta `v0.6.0`. El baseline es lo que carga el V1 de Fede.
- V2 = OpenCode 2.x. SDK de plugin = `@opencode/plugin@2.0.18` (npm `latest`), cliente = `@opencode/client@2.0.18`.
- V1 = OpenCode 1.18.x; SDK de plugin = `@opencode-ai/plugin` (instalado `1.18.30` en `.opencode/package.json`, último
  publicado `1.18.33`).
- La forma dual (`{ ...Plugin.define({id, setup}), server() }`) es la documentada para el entrypoint **server**; su
  aplicación al entrypoint **TUI** es una extrapolación razonable pero **⚠️ a verificar** (§8).

### 1.5 La restricción dura

La guía de migración es explícita: *"V1 plugin implementations do not run in V2. Moving a file or renaming its config
entry is not enough."* ([migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)). Por eso el plan es de
**port real**, no de compatibilidad automática.

---

## 2. Inventario de la superficie V1 usada

Todo lo siguiente fue leído del working tree. La columna "evidencia" cita `archivo:línea`.

### 2.1 Entrypoints

| Archivo | Forma V1 | Evidencia |
| --- | --- | --- |
| `index.js` | `export default { id: "opencode-voice", tui: async (api, options) => {...} }` | `index.js:56-58` |
| `index.js` | `const { kv } = api;` y `createClient(options)` | `index.js:59-60` |
| `index.js` | `registerSTT(api, kv, complete, prompts, options)` / `registerTTS(api, kv, complete, prompts)` | `index.js:70-71` |
| `index.js` | `api.command.register(() => [...sttCommands, ...ttsCommands])` | `index.js:73` |
| `server-plugin.js` | `export default { id: "opencode-voice-server", server: async (_input, _options) => {...} }` | `server-plugin.js:31-33` |
| `server-plugin.js` | hook `"chat.message": async ({ sessionID, messageID }, { _message, parts }) => {...}` | `server-plugin.js:38` |
| `server-plugin.js` | mutación in-place de `parts` con `splice` / `push` | `server-plugin.js:187`, `server-plugin.js:193` |

### 2.2 API TUI (`api.*`) por archivo

| Uso V1 | Evidencia |
| --- | --- |
| `api.kv` (get/set) | `index.js:59`; `stt.js:256,259-261,508,723,811,1153,1164,1172,1181,1197,1212,1221,1237,1281`; `tts.js:118,253,275,284,330,332,335,355,364` |
| `api.command.register(() => [...])` | `index.js:73` |
| `api.ui.toast(message, variant, duration)` | `stt.js:988`; `tts.js:114` |
| `api.ui.dialog.replace(() => api.ui.DialogSelect/DialogPrompt/DialogConfirm({...}))` | `stt.js:1156-1188, 1203-1228, 1272-1287, 1301-1470, 1474-1479, 1536-1552`; `tts.js:356-370` |
| `api.route.current` (`route.name`, `route.params.sessionID`) | `stt.js:250-251, 838, 1296-1298`; `tts.js:64-67`; `session.js:61-63` |
| `api.route.navigate("session", { sessionID })` | `stt.js:839` |
| `api.state.session.messages(sessionID)` | `tts.js:68`; `session.js:65` |
| `api.state.session.get(sessionID)` | `glossary.js:8` |
| `api.event.on(type, handler)` | `tts.js:248, 252, 274, 282` |
| `api.client` (SDK client V1) | `stt.js:985`; `tts.js:109`; `passthrough.js:190` |
| `api.project.worktree` / `api.project.directory` | `passthrough.js:129, 175` |

### 2.3 Uso del client V1 (`client.*`)

| Uso V1 | Evidencia |
| --- | --- |
| `client.tui.appendPrompt({ text })` | `stt.js:885, 942, 953, 1022` |
| `client.session.list()` | `session.js:11` |
| `client.session.message({ sessionID, messageID }, { throwOnError: true })` | `session.js:36-38`; `tts.js:83-85` |

### 2.4 Superficie server

| Uso V1 | Evidencia |
| --- | --- |
| `FILE_PATTERN = /^opencode-audio-(.+?)-(\d+)\.wav$/` | `server-plugin.js:10` |
| `MAX_AUDIO_BYTES = 15 * 1024 * 1024` | `server-plugin.js:11` |
| `generatePartId()` → `prt_<uuid>` | `server-plugin.js:13-15` |
| `getTmpDir(options)` → `options.tmpDir \|\| env \|\| "/tmp"` | `server-plugin.js:16-18` |
| Colección de `[audio-N]` desde `part.text` | `server-plugin.js:59-67` |
| Early-return si no hay tags | `server-plugin.js:74-90` |
| `readdirSync(tmpDir)` + match por `sessionID` | `server-plugin.js:96-106` |
| Guards de tamaño (`> MAX` / `<= 44`) + unlink | `server-plugin.js:122-145` |
| `base64` + `makeFilePart` con `type:"file"`, `mime:"audio/wav"`, `url`, `data`, `id`, `messageID`, `sessionID` | `server-plugin.js:146-158` |
| Inyección por `splice` en la parte de texto | `server-plugin.js:162-190` |
| Fallback `push` al final | `server-plugin.js:192-203` |
| Cleanup de no referenciados | `server-plugin.js:212-218` |

### 2.5 Lógica pura (sin API de plugin — reutilizable)

| Módulo | Qué contiene | Evidencia |
| --- | --- | --- |
| `lib/llm-client.js` | Cliente OpenAI-compatible con fallbacks (`fetch`, `AbortController`) | `llm-client.js:73-160` |
| `lib/glossary.js` | Carga/merge/save de glosario + parseo JSON | `glossary.js:28-102` |
| `lib/passthrough.js` | `validateWavFile`, `encodeWavAsDataUrl`, `parseConfigForAudioModels`, cola de audios | `passthrough.js:46-105, 254-337` |
| `lib/stt.js` | Grabación con `sox`/`parec`, transcripción local/API, normalización, WAV repair | `stt.js:103-163, 239-587, 719-807` |
| `lib/tts.js` | Piper + `play`, normalización para habla | `tts.js:123-224` |

### 2.6 Detección de audio hoy

`modelSupportsAudio(api)` no usa el client: lee `~/.config/opencode/opencode.json` y el `opencode.json` del proyecto
desde disco (`passthrough.js:117-140, 164-184`) y decide con `modalities.input.includes("audio")`
(`passthrough.js:66-67, 93-94`), con un Set `knownModels` para no aplicar la heurística Gemini/Mimo a modelos
declarados sin audio (`passthrough.js:213-234`).

---

## 3. Tabla de equivalencias V1→V2 y decisión cut/dual

### 3.1 Equivalencias

| # | Uso V1 (evidencia) | Equivalente V2 (fuente) | Decisión |
| --- | --- | --- | --- |
| 1 | `{id, tui(api, options)}` (`index.js:56-58`) | `Plugin.define({id, setup(ctx)})` de `@opencode/plugin/tui`, exportado en `./tui` ([CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli)) | Reescribir |
| 2 | `{id, server(_input,_options)}` (`server-plugin.js:31-33`) | `Plugin.define({id, setup(ctx)})` de `@opencode/plugin`, export root ([Plugins](https://opencode.ai/v2/docs/build/plugins)) | Reescribir |
| 3 | `"chat.message"(input, output)` mutando `parts` (`server-plugin.js:38`) | `ctx.session.hook("prompt", (event) => …)` mutando un evento único ([migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1), [Plugins › Prompt admission](https://opencode.ai/v2/docs/build/plugins)) | Reescribir |
| 4 | `FilePart` base64 (`server-plugin.js:146-158`) | `event.prompt.files.push({ uri: "file:///…/x.wav" })` ([Plugins › Prompt admission](https://opencode.ai/v2/docs/build/plugins)) | Simplificar ⚠️ |
| 5 | `api.kv` (`index.js:59`) | TUI: `context.storage.store(key, {initial})` / `context.storage.memory` ([CLI plugins › Storage](https://opencode.ai/v2/docs/build/plugins/cli)). Server: `ctx.storage.get/set/scan` ([Plugins › Storage](https://opencode.ai/v2/docs/build/plugins)) | Reescribir |
| 6 | `api.command.register(() => [...])` (`index.js:73`) | `context.keymap.layer(() => ({commands, bindings}))` ([CLI plugins › Commands and keymaps](https://opencode.ai/v2/docs/build/plugins/cli)) | Reescribir |
| 7 | `api.ui.toast(msg, variant)` (`stt.js:988`) | `context.ui.toast.show({message, variant, duration})` ([CLI plugins › Dialogs and toasts](https://opencode.ai/v2/docs/build/plugins/cli)) | Reescribir |
| 8 | `api.event.on(type, handler)` (`tts.js:248-288`) | `context.data.on(type, handler)` ([CLI plugins › Events](https://opencode.ai/v2/docs/build/plugins/cli)) | Reescribir (payload cambia) |
| 9 | `api.client` (`stt.js:985`) | `context.client` (cliente `@opencode/client`) ([CLI plugins › Client](https://opencode.ai/v2/docs/build/plugins/cli)) | Renombrar |
| 10 | `api.route.current` / `api.route.navigate` (`stt.js:250,839`) | `context.ui.router.current()` / `.navigate({type:"session",sessionID})` ([CLI plugins › Routes and tabs](https://opencode.ai/v2/docs/build/plugins/cli)) | Reescribir |
| 11 | `api.state.session.messages(id)` (`tts.js:68`) | `context.data.session.message.list(id)` ([CLI plugins › Sessions](https://opencode.ai/v2/docs/build/plugins/cli)) | Reescribir |
| 12 | `api.state.session.get(id)` (`glossary.js:8`) | `context.data.session.get(id)` → `SessionInfo.location.directory` (tipos `@opencode/client@2.0.18`) | Reescribir ⚠️ |
| 13 | `api.ui.dialog.replace` + `DialogSelect/Prompt/Confirm` (`stt.js:1156+`) | `await context.ui.dialog.select/prompt/confirm/alert(...)` (promise-based) ([CLI plugins › Dialogs and toasts](https://opencode.ai/v2/docs/build/plugins/cli)) | Reescribir |
| 14 | `client.tui.appendPrompt({text})` (`stt.js:885,942,953,1022`) | **Sin equivalente en V2 2.0.18** (ver §3.2) | **Bloqueante** |
| 15 | `client.session.list()` (`session.js:11`) | `context.client.session.list()` o `context.data.session.list()` | Reescribir |
| 16 | `client.session.message(...)` (`session.js:36`, `tts.js:83`) | `context.client.session.message.get({sessionID, messageID})` | Reescribir |
| 17 | Detección de audio leyendo `opencode.json` (`passthrough.js:117-184`) | `context.data.location.model.list()` + `ModelInfo.capabilities.input` ([CLI plugins › Location data](https://opencode.ai/v2/docs/build/plugins/cli); tipo `ModelCapabilities`) | Reescribir |
| 18 | `api.project.worktree/directory` (`passthrough.js:129`) | `context.location.directory` / `ctx.location.project` ([Plugins › Context](https://opencode.ai/v2/docs/build/plugins)) | Renombrar |
| 19 | Log a archivo `~/.local/share/opencode-voice/logs/*.log` (`index.js:35-44`, `stt.js:24-39`) | Sin dominio de logging en V2; se mantiene logging a archivo propio | Mantener |
| 20 | `lib/llm-client.js`, `lib/glossary.js`, WAV repair, cola `/tmp` | Lógica pura Node — no toca API de plugin | Reutilizar |
| 21 | `api.event.on("question.asked")` (`tts.js:282`) | No existe `question.asked` en el union `V2Event` de `@opencode/client@2.0.18` | Eliminar / rediseñar |
| 22 | `api.event.on("session.status")` + flag `wasBusy` (`tts.js:248-250`) | `context.data.on("session.status", …)` con `event.data.status.type` (`busy`/`idle`/`retry`) | Reescribir |

### 3.2 El bloqueante: no hay append al composer en V2 2.0.18

Evidencia recogida (no es opinión):

1. El `Context` del plugin TUI (`@opencode/plugin@2.0.18`, `dist/tui/context.d.ts`) expone `ui.toast`, `ui.dialog`,
   `ui.router`, `ui.tabs`, `ui.model`, `ui.slot`, `ui.panel`, `ui.format`, `keymap`, `storage`, `data`, `client`,
   `attention`, `markdown`, `renderer`, `theme`, `app`, `location`, `options` — **ninguno inserta texto en el composer**.
2. El cliente V2 (`@opencode/client@2.0.18`, `dist/promise/client.d.ts`) **no tiene namespace `tui`**.
3. El OpenAPI de V2 no tiene ningún endpoint de publicación de eventos ni de append: `/api/event` es `GET` (solo
   subscribe), y el único path con `prompt` es `/api/session/{sessionID}/prompt` (submit).
4. El evento `tui.prompt.append` existe como **server→TUI** (`TuiPromptAppend` en los tipos de `@opencode/client`),
   pero no hay API pública para emitirlo desde un plugin.

Consecuencia: el flujo actual de F5 (transcripción) y F6 (passthrough con tag `[audio-N]`) **no puede replicarse
tal cual** en V2. Opciones (ver §8.3) y decisión en §3.4.

### 3.3 Decisión: DUAL, no cut

| Criterio | Cut a V2 | Dual V1+V2 |
| --- | --- | --- |
| Paridad de UX | ❌ requiere cambiar F5/F6 (submit directo, sin editar antes de enviar) | ✅ V1 intacto |
| Esfuerzo | Menor (una implementación) | Mayor (dos implementaciones, lógica pura compartida) |
| Riesgo | Alto en el flujo principal (composer) | Bajo: V1 no se toca |
| Soporte oficial | — | ✅ desde OpenCode `1.18.29` ([migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)) |
| Deuda | — | Duplicación hasta el cut |

**Recomendación: DUAL.** El paquete expone, en un mismo default export, `Plugin.define({id, setup})` (V2) y la función
V1 (`server()` / `tui()`). V2 lee `setup()`, V1 lee `server()`/`tui()`. La lógica pura (`lib/llm-client.js`,
`lib/glossary.js`, validación WAV, reparación de header) se comparte; solo se duplica la capa de adaptación a la API
del plugin.

### 3.4 Trigger de cut

Se elimina la rama V1 cuando se cumpla **una** de estas:

- OpenCode V2 expone una API pública de append al composer (o equivalente funcional), y
- Fede acepta el cambio de UX a submit directo como comportamiento permanente, o
- Fede decide discontinuar el soporte V1.

---

## 4. Cambios por archivo

> Los snippets son pseudodiff ilustrativos; el código final debe respetar el estilo del repo (ESM plano, sin build,
> oxfmt/oxlint). Se recomienda **no mezclar** V1 y V2 en los mismos archivos de lógica: crear un subdirectorio `v2/`
> para la capa de adaptación y dejar `lib/` puro.

### 4.1 `index.js` (entrypoint TUI, dual)

```diff
- export default {
-   id: "opencode-voice",
-   tui: async (api, options) => {
-     const { kv } = api;
-     const { complete } = createClient(options);
-     ...
-     api.command.register(() => [...sttCommands, ...ttsCommands]);
-   },
- };
+ import { Plugin } from "@opencode/plugin/tui";
+ import { setupTuiV2 } from "./v2/tui.js";
+
+ export default {
+   ...Plugin.define({
+     id: "opencode-voice",
+     setup: setupTuiV2,           // V2
+   }),
+   tui: async (api, options) => { // V1 (intacto)
+     const { kv } = api;
+     const { complete } = createClient(options);
+     ...
+     api.command.register(() => [...sttCommands, ...ttsCommands]);
+   },
+ };
```

Nota: `Plugin.define` devuelve `{id, setup}`; el spread + `tui` es la forma dual documentada para el entrypoint
server, extrapolada al TUI (**⚠️ a verificar**, §8.2). Si V2 no tolera la propiedad extra `tui`, la alternativa es
mantener `index.js` V1 y agregar un export `./tui-v2` separado (ver §6.3).

### 4.2 `server-plugin.js` (entrypoint server, dual)

```diff
+ import { Plugin } from "@opencode/plugin";
+ import { setupServerV2 } from "./v2/server.js";
+
- export default {
-   id: "opencode-voice-server",
-   server: async (_input, _options) => {
-     ...
-     return { "chat.message": async (...) => {...} };
-   },
- };
+ export default {
+   ...Plugin.define({
+     id: "opencode-voice-server",
+     setup: setupServerV2,        // V2
+   }),
+   server: async (_input, _options) => { // V1 (intacto)
+     ...
+     return { "chat.message": async (...) => {...} };
+   },
+ };
```

El hook V2 (`v2/server.js`):

```js
// Pseudocódigo V2 — hook "prompt" (reemplaza chat.message)
export async function setupServerV2(ctx) {
  const registration = await ctx.session.hook("prompt", (event) => {
    injectAudioIntoPrompt(event, { storage: ctx.storage, log });
  });
  return () => registration.dispose(); // o dejar que el unload lo limpie
}

// Exportada para test unitario (patrón de testabilidad del repo)
export function injectAudioIntoPrompt(event, deps) {
  const tags = [...event.prompt.text.matchAll(/\[audio-(\d+)\]/g)];
  if (tags.length === 0) return;                       // early-return (paridad server-plugin.js:74-90)
  event.prompt.files ??= [];
  for (const [, n] of tags) {
    const file = resolveStagedAudio(n, deps);          // vía storage/RPC o tmpdir
    if (!file) continue;                               // tag sin audio → dejar el tag
    event.prompt.files.push({ uri: `file://${file.path}`, name: file.name });
    event.prompt.text = event.prompt.text.replaceAll(`[audio-${n}]`, "");
  }
}
```

Puntos de diseño:

- **Ya no se construyen `FilePart`s ni base64 ni `prt_` IDs**: V2 recibe `files[].uri` y resuelve el archivo. Esto
  elimina `generatePartId` (`server-plugin.js:13-15`) y `MAX_AUDIO_BYTES` deja de ser el único guard (igual conviene
  mantener el límite antes de adjuntar).
- `event.prompt.text` es **mutable** y `event.prompt.files` es un array mutable
  ([Plugins › Prompt admission](https://opencode.ai/v2/docs/build/plugins)).
- El hook `prompt` corre **una vez en admisión**, no antes de cada llamada al modelo; si además se quisiera afectar
  cada request habría que registrar `context` ([migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)).
- El evento es "owned draft": si la preparación falla, el prompt no se admite; hay que ser retry-safe (el hook puede
  correr más de una vez en submits concurrentes) ([Plugins › Prompt admission](https://opencode.ai/v2/docs/build/plugins)).

### 4.3 `lib/stt.js`

| Cambio | Detalle |
| --- | --- |
| Firma `registerSTT` | En V2, `setupTuiV2(ctx)` arma `{toast, kv, client, router, data}` y llama a un `registerSTV2` paralelo. La lógica de grabación/transcripción se reutiliza tal cual (no depende de la API del plugin salvo `toast`). |
| `api.route.current` (`stt.js:250-251,838,1296`) | `context.ui.router.current()`; para navegar, `context.ui.router.navigate({type:"session", sessionID})`. |
| `api.ui.toast` (`stt.js:988`) | `context.ui.toast.show({message, variant, duration})`. |
| Diálogos (`stt.js:1156+`) | `await context.ui.dialog.select({title, current, options:[{title,value,description,disabled}]})` devuelve el `value`; se elimina el patrón `onSelect` + `replace` recursivo. `DialogPrompt` → `await dialog.prompt(...)`; `DialogConfirm` → `await dialog.confirm(...)`. |
| `client.tui.appendPrompt` (`stt.js:885,942,953,1022`) | **Bloqueante** (§3.2). Fallback V2 propuesto: `context.client.session.prompt({ sessionID, text, delivery: "queue" })` (submit directo). Ver §8.3. |
| `modelSupportsAudio` (`stt.js:830,1241`) | Reescribir contra `context.data.location.model.list()` + `context.ui.model.current()` (ver §4.5). |
| Persistencia `kv.get/set` (`stt.js:256,508,811,…`) | `context.storage.store("voice.settings", { initial: {...} })` → `[settings, update]`; o stores por dominio (`stt`, `tts`). |

### 4.4 `lib/tts.js`

| Cambio | Detalle |
| --- | --- |
| `api.event.on("session.status"/"session.idle")` (`tts.js:248-272`) | `context.data.on("session.status", e => …)` con `e.data.status.type` (`busy`/`idle`/`retry`) y `context.data.on("session.idle", e => …)` con `e.data.sessionID`. Se puede simplificar el flag `wasBusy` usando `context.data.session.status(sessionID)`. |
| `api.event.on("permission.asked")` (`tts.js:274`) | `context.data.on("permission.asked", e => …)` con `e.data.sessionID`. |
| `api.event.on("question.asked")` (`tts.js:282`) | **No existe** en V2. Eliminar o reemplazar por el evento de formulario correspondiente (**⚠️ a verificar** cuál). |
| `getTurnAssistantText` (`tts.js:63-104`) | `api.route.current` → `context.ui.router.current()`; `api.state.session.messages(id)` → `context.data.session.message.list(id)`; `client.session.message(...)` → `context.client.session.message.get({sessionID, messageID})`. Los mensajes V2 son un union: filtrar `type === "assistant"` y `content.filter(c => c.type === "text")` (`SessionMessageAssistant`). |
| `api.ui.toast` (`tts.js:114`) | `context.ui.toast.show(...)`. |
| Diálogo de voz (`tts.js:356`) | `await context.ui.dialog.select(...)`. |
| Comandos (`tts.js:312-372`) | `context.keymap.layer(() => ({ commands: [...] }))` con `{id, title, description, group, bind, slash, run}`. `bind: "escape"` y `<leader>s`/`<leader>v` deben revalidarse contra la referencia de keybinds V2. |

### 4.5 `lib/passthrough.js`

```diff
- export async function modelSupportsAudio(api) {
-   const audioModels = await getAudioCapableModels(api.client, api); // lee opencode.json
-   const currentModelId = await getActiveModel(api.client, api);
-   ...
- }
+ export function modelSupportsAudioV2({ models, selected }) {
+   // models: ModelInfo[] de context.data.location.model.list()
+   // selected: {providerID, modelID} de context.ui.model.current()
+   if (!selected) return { supportsAudio: false, reason: "No model selected" };
+   const m = models.find(x => x.providerID === selected.providerID && x.modelID === selected.modelID);
+   const supportsAudio = m ? m.capabilities.input.includes("audio") : false;
+   return { supportsAudio, modelId: selected.modelID, reason: ... };
+ }
```

Ventajas: se elimina la lectura de `opencode.json` a disco (`passthrough.js:117-184`), la heurística Gemini/Mimo
(`passthrough.js:224-234`) y el cache TTL de 60s (`passthrough.js:41-44`), porque V2 expone `capabilities.input`
directamente (`ModelCapabilities` en `@opencode/client@2.0.18`) y `context.data.location.model` es reactivo.
**⚠️ a verificar**: que `capabilities.input` venga poblado con `"audio"` para los modelos que Fede usa (Gemini/Mimo).

`saveAudioToQueue` / `cleanStaleAudioQueue` (`passthrough.js:293-337`) se mantienen si el diseño sigue usando
`/tmp` como puente entre procesos; si se adopta RPC (§8.3), se reemplazan por `ctx.storage` + un token.

### 4.6 `lib/session.js` y `lib/glossary.js`

- `session.js:11` `client.session.list()` → `context.client.session.list()` o `context.data.session.list()`.
- `session.js:36-38` `client.session.message(...)` → `context.client.session.message.get({sessionID, messageID})`.
- `session.js:61-65` `api.route.current` + `api.state.session.messages` → router + `context.data.session.message.list`.
- `glossary.js:8` `api.state.session.get(sessionID).directory` → `context.data.session.get(sessionID)?.location?.directory`
  (`SessionInfo.location: LocationPublicRef` en `@opencode/client@2.0.18`). **⚠️ a verificar** que
  `LocationPublicRef` incluya `directory`.
- `glossary.js:19` `execSync("git rev-parse --show-toplevel")`: se puede mantener (Node puro) o reemplazar por
  `context.data.location.vcs.info()`/`ctx.vcs`. Recomendación: mantener para no ampliar el alcance.

### 4.7 `lib/llm-client.js`

**Sin cambios.** Es Node puro (`fetch` a un endpoint OpenAI-compatible) y no toca la API del plugin. Se comparte
entre V1 y V2. Ver `llm-client.js:73-160`.

### 4.8 `package.json`

Ver §6.2 para el diff de `exports`/`dependencies`.

---

## 5. Configuración y registro

### 5.1 Qué cambia

| Superficie | V1 (actual) | V2 |
| --- | --- | --- |
| Registro TUI | `~/.config/opencode/tui.json` → `"plugin": [[pkg, opts]]` | El plugin se registra en `opencode.json(c)` → `"plugins"`, y el CLI lo carga solo si expone `./tui` ([CLI plugins](https://opencode.ai/v2/docs/cli/plugins)) |
| Registro server | `~/.config/opencode/opencode.json` → `"plugin": [...]` | `opencode.json(c)` → `"plugins": [...]` (mismo archivo) ([Config › Plugins](https://opencode.ai/v2/docs/config)) |
| Opciones | tupla `[pkg, options]` | objeto `{ "package": pkg, "options": {...} }` ([migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)) |
| Preferencias CLI | `tui.json` (theme, keybinds, attention) | `cli.json` (global, sin variante por proyecto) ([CLI › Settings](https://opencode.ai/v2/docs/cli/config)) |
| Solo-TUI contra server remoto | — | `cli.json` → `"plugins": [...]` ([CLI plugins](https://opencode.ai/v2/docs/cli/plugins)) |

### 5.2 Config concreta de Fede (dual)

Estado actual verificado:

- `~/.config/opencode/tui.json` incluye `[/home/fciliberti/Trabajos/Tools/opencode-voice, {…opciones…}]`.
- `~/.config/opencode/opencode.json` incluye `"file:///home/fciliberti/Trabajos/Tools/opencode-voice"`.

En modo dual, para que V1 siga andando **y** V2 cargue:

```jsonc
// ~/.config/opencode/opencode.json  (V2 server + V2 TUI; V1 server)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // ...
    {
      "package": "file:///home/fciliberti/Trabajos/Tools/opencode-voice",
      "options": {
        "endpoint": "http://localhost:4000/v1",
        "model": "gpt-oss-120b",
        "apiKeyEnv": "LITELLM_KEY",
        "sttEndpoint": "https://api.groq.com/openai/v1",
        "sttModel": "whisper-large-v3-turbo",
        "sttApiKeyEnv": "GROQ_API_KEY",
        "temperature": 0.05,
        "timeout": 12000,
        "fallbacks": [
          { "endpoint": "http://localhost:4000/v1", "model": "gemini-3.1-flash-lite", "apiKeyEnv": "LITELLM_KEY" }
        ]
      }
    }
  ]
}
```

```jsonc
// ~/.config/opencode/tui.json  (V1: se mantiene durante el dual)
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["/home/fciliberti/Trabajos/Tools/opencode-voice", { /* mismas opciones */ }]
  ]
}
```

En V2, `tui.json` **se ignora**; la parte TUI del plugin se carga porque el paquete expone `./tui` y está registrado
en `opencode.json` ([CLI plugins](https://opencode.ai/v2/docs/cli/plugins)). El resto de `tui.json` (theme `nord`,
`keybinds` con `leader: ctrl+x`, `attention`) es V1-only: su equivalente V2 vive en `cli.json`
([CLI › Settings](https://opencode.ai/v2/docs/cli/config)). Migrar esas preferencias es un trabajo aparte.

**⚠️ a verificar**: si el V2 TUI de Fede corre contra un server remoto, el plugin debe estar además en `cli.json`
`"plugins"` (CLI-only) ([CLI plugins](https://opencode.ai/v2/docs/cli/plugins)).

### 5.3 `.opencode/` del repo

`.opencode/` está untracked y solo contiene `voice-glossary.json`, `package.json` (`@opencode-ai/plugin@1.18.30`),
lockfiles y `node_modules` (con `@opencode-ai/sdk/dist/v2/…`). No hay `.opencode/plugins/` propio. Recomendación:

- No commitear `.opencode/` tal cual (los `.gitignore` internos ya ignoran `package.json`/lockfiles).
- Si en el futuro se agrega un plugin local de desarrollo, usar `.opencode/plugins/` (V2) según
  [migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1).
- Añadir `.opencode/node_modules` al `watcher.ignore` del proyecto si molesta (higiene OpenCode).

---

## 6. Dependencias y packaging

### 6.1 Paquetes

| V1 | V2 |
| --- | --- |
| `@opencode-ai/plugin` (1.18.x) | `@opencode/plugin` (2.0.18 latest; exports `.`, `./tui`, `./rpc`, `./host`, `./effect`) |
| `@opencode-ai/sdk` (client V1) | `@opencode/client` (2.0.18) |
| Sin `dependencies` runtime (`package.json:47-50` solo devDeps) | `@opencode/plugin` como `dependency` (o `peerDependency`); `effect` solo si se usa el entrypoint Effect (no recomendado acá) |

Verificado en npm: `@opencode/plugin@2.0.18` con `dependencies` que incluyen `zod@4.1.8`, `effect@4.0.0-rc.112`,
`@opencode/client@2.0.18`; `peerDependencies`: `solid-js>=1.9.0`, `@opentui/core>=0.5.12`, `@opentui/solid>=0.5.12`,
`@opencode/theme@2.0.18`. Si el plugin **renderiza JSX**, esas peers son obligatorias; si solo usa comandos/toasts
(como este caso), en principio no se renderiza JSX y las peers de OpenTUI no harían falta. **⚠️ a verificar** si el
import de `@opencode/plugin/tui` exige las peers aun sin JSX.

### 6.2 `package.json` propuesto (dual)

```diff
   "type": "module",
-  "main": "index.js",
+  "main": "server-plugin.js",
   "exports": {
-    ".": { "import": "./index.js" },
-    "./tui": { "import": "./index.js" },
-    "./server": { "import": "./server-plugin.js" }
+    ".": { "import": "./server-plugin.js" },      // V2 server entrypoint
+    "./tui": { "import": "./index.js" },           // V1 tui() + V2 setup (TUI)
+    "./server": { "import": "./server-plugin.js" },// V1 server()
+    "./rpc": { "import": "./v2/rpc.js" }           // opcional: contrato RPC
   },
   "files": ["index.js", "server-plugin.js", "lib", "v2"],
+  "dependencies": {
+    "@opencode/plugin": "^2.0.18"
+  }
```

Riesgos de packaging:

- Cambiar `"."` de `./index.js` a `./server-plugin.js` es necesario si V2 resuelve el entrypoint server desde `"."`
  ([Plugins › Publish](https://opencode.ai/v2/docs/build/plugins) usa `"."` para el server). **⚠️ a verificar** si V1
  usaba `"."` para la TUI (hoy `"."` y `"./tui"` apuntan al mismo `index.js`). Si V1 lo usaba, el cambio de `"."`
  rompería la TUI V1; en ese caso usar `"./server"` para V1 y confirmar cómo resuelve V2 (`. ` vs `./server`).
- Publicar `@opencode/plugin` como `dependency` con rango compatible con la release de OpenCode objetivo
  ([migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)).
- Versionado: el campo `version` está stale (`0.1.0`) mientras npm latest es `0.6.0`. **Corregir el `version`** y
  publicar el dual como **minor** (p.ej. `0.7.0`), ya que agrega soporte V2 sin romper V1. Ver `RELEASE_PROCESS.md`.
- `npm pack` debe incluir `v2/`; hoy `files` es `["index.js","lib","server-plugin.js"]` (`package.json:21-25`).

### 6.3 Alternativa si el dual TUI no es viable

Si V2 rechaza un default export con `setup` **y** `tui` en `./tui`, separar:

```jsonc
"exports": {
  ".": { "import": "./server-plugin.js" },
  "./server": { "import": "./server-plugin.js" },
  "./tui": { "import": "./index.js" },       // V1
  "./tui-v2": { "import": "./v2/tui.js" }    // V2 (requiere confirmar si V2 permite entrypoint TUI con otro subpath)
}
```

**⚠️ a verificar**: el `host.resolve()` de `@opencode/plugin` devuelve `{server, tui, rpc}`; no está documentado si
el subpath TUI es configurable. Preferir la forma dual estándar si funciona.

---

## 7. Estrategia de test y verificación

### 7.1 Qué cubren los tests actuales

- `test/llm-client.test.js` (8 tests): fallbacks, headers, `reasoning_effort`, `chat_template_kwargs`, ausencia de
  `Authorization`. Es lógica pura → **sigue valiendo en V2 sin cambios**.
- `test/passthrough.test.js` (11 tests): heurística de audio con `fs` mockeado, `FILE_PATTERN`, unicidad de
  `generatePartId`, split con tag duplicado, `saveAudioToQueue`, `sizeBytes`, y un test end-to-end que llama
  `serverPlugin.server(null,{tmpDir})["chat.message"]` con un WAV real (`test/passthrough.test.js:289-322`).
- Runner: `node --test` (`package.json:43`).

### 7.2 Qué tests se rompen con el port

| Test actual | Impacto |
| --- | --- |
| `passthrough.test.js:184-193` (`generatePartId` `prt_`) | Se elimina si V2 usa `files[].uri` |
| `passthrough.test.js:197-229` (split de `parts`) | Se reescribe contra `event.prompt.text`/`files` |
| `passthrough.test.js:289-322` (hook `chat.message`) | Se reescribe contra `session.hook("prompt", …)` |
| Tests de `modelSupportsAudio` con `opencode.json` mockeado (`:69-161`) | Se reescriben contra `ModelInfo.capabilities.input` |
| `llm-client.test.js` | Sin cambios |

### 7.3 Tests nuevos requeridos (V2)

Se debe exportar el handler del hook como **función pura** (patrón ya usado en `server-plugin.js:10-18`) para poder
testearlo sin levantar OpenCode. Ejemplo: `injectAudioIntoPrompt(event, {resolveAudio, log})`.

Casos:

1. **Mutación del prompt (camino feliz)**: `[audio-1] hola` → `files` con 1 adjunto, `text` sin el tag, texto restante
   intacto.
2. **Caso peligroso — tag sin audio**: `[audio-1]` referenciado pero sin archivo/token → **no** debe agregar adjunto y
   **no** debe romper; definir explícitamente si el tag se preserva (comportamiento actual V1: se preserva) o se borra.
3. **Caso peligroso — audio sin tag**: archivo huérfano → no debe adjuntarse ni quedar basura (cleanup).
4. **Caso peligroso — audio sobredimensionado**: `size > MAX_AUDIO_BYTES` → rechazar, loguear, no adjuntar.
5. **Caso peligroso — audio vacío**: `size <= 44` (header WAV) → rechazar.
6. **Tag duplicado**: `[audio-1] hola [audio-1]` → N adjuntos, texto limpio, sin duplicar el archivo.
7. **Múltiples tags intercalados**: `a [audio-1] b [audio-2] c` → orden y texto preservados.
8. **Sin tags**: early-return, cero I/O (paridad con `server-plugin.js:74-90`).
9. **Hook re-entrante / retry-safe**: invocar el handler dos veces con el mismo evento no debe duplicar adjuntos.
10. **`modelSupportsAudioV2`**: modelo con `capabilities.input:["audio"]` → true; `["text"]` → false; sin selección →
    false.
11. **TTS `getTurnAssistantText` V2**: union de mensajes con assistant text + reasoning + tool → solo concatena text.
12. **`session.idle` con `wasBusy`**: no debe hablar si nunca hubo `busy` (paridad `tts.js:252-255`).

Fixtures realistas: WAV con header RIFF/WAVE válido (ya hay `makeWavBuffer` en
`test/passthrough.test.js:49-65`), y un caso de WAV "corrupto" para `validateAndRepairWav` (`stt.js:103-163`).

### 7.4 Smoke manual end-to-end

**STT (V2)**

1. Abrir OpenCode V2 en un proyecto, abrir una sesión.
2. `F5` → hablar → `F5`. Verificar:
   - Toast de progreso y resultado (`context.ui.toast.show`).
   - El texto transcrito llega al flujo elegido (append si existe; submit directo si es el fallback).
   - `~/.local/share/opencode-voice/logs/stt.log` registra `pipeline_start`…`pipeline_done`.
3. Cambiar de modelo a uno con audio (`/stt-mode` o `context.ui.model`) y probar `F6` (passthrough): verificar que el
   audio llega al modelo como adjunto.
4. Verificar cleanup: no quedan `opencode-audio-*`/`opencode-stt-*` en el tmpdir.

**TTS (V2)**

1. `/tts-mode` (o el bind equivalente) → encender.
2. Enviar un prompt, esperar `session.idle` → debe hablar la respuesta con prefijo de sesión.
3. `/tts-speak` → lee la última respuesta.
4. `/tts-stop` → corta el audio.
5. `/tts-voice` → cambia voz y persiste (`context.storage`).

**Regresión V1**

1. Correr el mismo smoke con el V1 de Fede y el paquete dual → comportamiento idéntico al baseline.
2. `npm run check` y `npm run test` en verde.

---

## 8. Riesgos, gotchas y preguntas abiertas

### 8.1 Riesgos mayores

| # | Riesgo | Impacto | Confianza | Mitigación |
| --- | --- | --- | --- | --- |
| R1 | **No hay append al composer en V2** (§3.2) | Alto: F5/F6 cambian de UX o no son posibles | Alta (verificado en tipos + OpenAPI 2.0.18) | Dual + fallback submit directo + feature request upstream |
| R2 | **Dual TUI no documentado** (`setup`+`tui` en `./tui`) | Medio: V2 podría no cargar el entrypoint TUI | Media | Probar temprano (Fase 0); fallback §6.3 |
| R3 | **Resolución de entrypoints del paquete** (`.` vs `./server`) | Medio: romper la carga V1 o V2 | Media | Probar ambos; mantener `.` y `./server` apuntando al server |
| R4 | **Adjuntos por `uri` para audio** | Medio: el modelo podría no recibir audio si el pipeline no soporta `file://` de audio | Media | Verificar con Gemini/Mimo en runtime; si no, conservar base64 vía `PromptFileAttachment.data` |
| R5 | **`question.asked` no existe en V2** | Bajo | Alta (union `V2Event`) | Eliminar o mapear a formularios |
| R6 | **Storage TUI vs server separados** | Medio: el handoff por `ctx.storage` no cruza procesos | Alta | Usar RPC (`ctx.rpc`) para el puente TUI↔server |
| R7 | **Keybinds** (`<leader>s`, `escape`, `f5/f6`) | Bajo | Media | Revalidar contra la referencia V2 de keybinds |

### 8.2 Gotchas

- El hook `prompt` corre **una vez en admisión**, no antes de cada llamada al modelo
  ([migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)).
- El hook `prompt` **no es exactly-once**: en submits concurrentes puede correr más de una vez; mantenerlo
  retry-safe ([Plugins › Prompt admission](https://opencode.ai/v2/docs/build/plugins)).
- Si se reescribe `event.prompt.text`, hay que ajustar/eliminar los `mention` offsets de los adjuntos que ya no
  coincidan ([Plugins › Prompt admission](https://opencode.ai/v2/docs/build/plugins)).
- `event.prompt.files` usa `{uri}`; el `PromptFileAttachment` de submit usa `{data, mime, source}` — son formas
  distintas (tipos `@opencode/client@2.0.18`). No confundirlas.
- Los transforms (`ctx.tool.transform`, `ctx.provider.transform`, etc.) son **sincrónicos y replayables**: no meter
  I/O ni side-effects one-time adentro ([migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)).
- `setup` puede devolver cleanup; las registraciones de hooks/transforms se limpian solas al unload
  ([Plugins › Lifecycle](https://opencode.ai/v2/docs/build/plugins)).
- El logging a archivo propio se mantiene; V2 no expone `client.app.log` en el contexto del plugin.

### 8.3 Preguntas abiertas (necesitan respuesta de Fede)

1. **UX de F5/F6 en V2**: ¿aceptás *submit directo* (el texto se envía sin pasar por el composer, sin editar antes)
   mientras no exista append? ¿O preferís esperar a que V2 exponga la API y quedar en V1?
2. **Passthrough F6 sin tag**: si se corta el tag `[audio-N]`, ¿el audio debe ir directo al modelo (submit con
   `files`) o se descarta la feature en V2 hasta tener append?
3. **Puente TUI↔server**: ¿RPC (`ctx.rpc` + `./rpc` export, la vía limpia de V2) o mantenemos `/tmp` + storage?
4. **Modelos objetivo**: ¿qué modelos con audio usás realmente en V2 (Gemini/Mimo)? Define el test de aceptación de
   `capabilities.input`.
5. **Soporte V1**: ¿cuánto tiempo más querés soportar V1? Define el trigger de cut (§3.4).
6. **Config**: ¿migramos theme/keybinds/attention de `tui.json` a `cli.json` en el mismo esfuerzo o queda aparte?

### 8.4 Cosas a verificar en runtime (no inventar)

- Que V2 cargue un default export `{...Plugin.define({id,setup}), tui}` desde `./tui`.
- Que V2 resuelva el entrypoint server desde `"."` y/o `"./server"`.
- Que `context.data.location.model.list()` traiga `capabilities.input` con `"audio"`.
- Que `SessionInfo.location` incluya `directory` (para el glosario).
- Que un adjunto `{uri:"file:///…wav"}` en `event.prompt.files` llegue al modelo como audio.
- Qué evento reemplaza a `question.asked` (si existe) para el aviso de TTS.
- Si el import de `@opencode/plugin/tui` exige las peerDependencies de OpenTUI aun sin JSX.

---

## 9. Plan por fases con criterios de aceptación

> Ordenado para implementación incremental. Cada fase es mergeable y verificable por separado.

### Fase 0 — Spike de viabilidad (sin tocar el código de producción)

Objetivo: resolver las incógnitas de §8.4 antes de invertir en el port.

- [ ] Crear un plugin de prueba mínimo que: exporte `{...Plugin.define({id,setup}), tui}` desde `./tui` y
      `{...Plugin.define({id,setup}), server}` desde `.`; se cargue en V2 y muestre un toast.
- [ ] Confirmar `opencode plugin list` muestra el plugin con su ID y source
      ([migrate-v1 › Verify](https://opencode.ai/v2/docs/build/plugins/migrate-v1)).
- [ ] Confirmar `session.hook("prompt", …)` dispara y que `event.prompt.files.push({uri})` adjunta un WAV.
- [ ] Confirmar `context.data.location.model.list()` con `capabilities.input`.
- **Criterio de aceptación**: los 4 puntos verificados y documentados en este archivo; decisión final cut/dual confirmada.

### Fase 1 — Andamiaje V2 + entrypoints duales

- [ ] `v2/tui.js` con `setupTuiV2(ctx)` mínimo: toast de carga + `context.storage` de settings.
- [ ] `v2/server.js` con `setupServerV2(ctx)` mínimo: hook `prompt` que loguea.
- [ ] `index.js` y `server-plugin.js` con el patrón dual (§4.1, §4.2).
- [ ] `package.json`: exports/deps (§6.2), `files` con `v2/`, versión corregida.
- **Criterio**: `npm run check` y `npm run test` verdes; V1 sigue cargando y funcionando (smoke de regresión);
  V2 carga y muestra el toast.

### Fase 2 — Migrar preferencias y comandos (TUI)

- [ ] `context.storage.store` para `stt.mode`, `stt.model`, `stt.mic`, `stt.api.model`, `tts.mode`, `tts.voice`.
- [ ] `context.keymap.layer` con todos los comandos (`stt-record`, `stt-passthrough`, `stt-stop`, `stt-model`,
      `stt-mic`, `stt-mode`, `stt-glossary`, `tts-speak`, `tts-mode`, `tts-stop`, `tts-voice`).
- [ ] `context.ui.toast.show` en todos los avisos.
- [ ] `context.ui.dialog.select/prompt/confirm` reemplazando `replace`+`Dialog*`.
- [ ] `context.ui.router.current/navigate` en lugar de `api.route`.
- **Criterio**: grabar/transcribir con whisper local y API; cambiar modelo/mic/modo/voz; glosario (ver/agregar/
  quitar/generar) — todo desde V2, con persistencia entre reinicios.

### Fase 3 — STT al prompt (decisión de UX)

- [ ] Según §8.3(1): implementar append (si existe) o submit directo (`context.client.session.prompt`).
- [ ] `context.data.location.model.list()` + `context.ui.model.current()` para `modelSupportsAudio`.
- **Criterio**: F5 inserta/envía la transcripción normalizada; modo auto detecta audio correctamente; fallback de
  normalización LLM usa el texto crudo.

### Fase 4 — Passthrough (server hook)

- [ ] `v2/server.js`: `injectAudioIntoPrompt` puro + `ctx.session.hook("prompt", …)`.
- [ ] Puente TUI↔server (RPC recomendado): `v2/rpc.js` (`Rpc.define`), `ctx.rpc.register`, y llamada desde el TUI.
- [ ] Guards de tamaño/vacío y cleanup.
- **Criterio**: F6 adjunta audio al modelo; tests §7.3 (2–9) verdes; sin basura en tmpdir.

### Fase 5 — TTS

- [ ] `context.data.on("session.status"/"session.idle"/"permission.asked")` con payload `event.data.*`.
- [ ] `getTurnAssistantText` contra el union de mensajes V2.
- [ ] Eliminar/reemplazar `question.asked`.
- **Criterio**: auto-TTS habla al terminar el turno; `/tts-speak`, `/tts-stop`, `/tts-voice` funcionan; no habla sin
  `wasBusy`.

### Fase 6 — Tests, documentación y release

- [ ] Tests §7.3 y fixtures realistas.
- [ ] Actualizar `AGENTS.md`, `README.md`, `IMPLEMENTATION_PLAN.md` (marcar estado) y `RELEASE_PROCESS.md`.
- [ ] Publicar el dual como minor.
- **Criterio**: `npm run check` + `npm run test` verdes; smoke V1 y V2 completos; release publicado.

---

## 10. Fuentes

### OpenCode V2 (fuente de verdad)

- Overview de plugins: <https://opencode.ai/v2/docs/build/plugins>
- Plugins CLI (TUI): <https://opencode.ai/v2/docs/build/plugins/cli>
- Migración V1→V2: <https://opencode.ai/v2/docs/build/plugins/migrate-v1>
- RPC: <https://opencode.ai/v2/docs/build/plugins/rpc>
- Cliente JS: <https://opencode.ai/v2/docs/build/client>
- Configuración: <https://opencode.ai/v2/docs/config>
- Carga de plugins CLI: <https://opencode.ai/v2/docs/cli/plugins>
- Settings de CLI (`cli.json`): <https://opencode.ai/v2/docs/cli/config>
- Índice de documentación: <https://opencode.ai/v2/llms.txt>
- OpenAPI V2: <https://opencode.ai/v2/openapi.json>

### OpenCode V1 (insumo de migración)

- Plugins V1: <https://opencode.ai/docs/plugins>

### Paquetes npm (verificados el 2026-09-28)

- `@opencode/plugin@2.0.18` (exports `.`, `./tui`, `./rpc`, `./host`, `./effect`)
- `@opencode/client@2.0.18`
- `@opencode-ai/plugin@1.18.33` (V1)

### Código del repo (baseline = working tree)

- `index.js`, `server-plugin.js`, `package.json`, `lib/stt.js`, `lib/tts.js`, `lib/passthrough.js`, `lib/session.js`,
  `lib/glossary.js`, `lib/llm-client.js`, `test/llm-client.test.js`, `test/passthrough.test.js`, `AGENTS.md`,
  `IMPLEMENTATION_PLAN.md`, `.omo/notepads/audio-passthrough-fixes/learnings.md`.

---

## Apéndice A — Cambios de shape que más sorprenden

| Concepto | V1 | V2 |
| --- | --- | --- |
| Hooks | objeto `{ "chat.message": fn }` | registro por dominio `ctx.session.hook("prompt", fn)` |
| Firma del hook | `(input, output)` | un único evento mutable |
| Adjuntos de prompt | `parts` con `type:"file"`, `base64`, `prt_` id | `event.prompt.files` con `{uri}` |
| Diálogos | `dialog.replace(() => DialogSelect({onSelect}))` | `await dialog.select(...)` → valor |
| Estado | `api.kv.get/set` | `context.storage.store` (reactivo) / `ctx.storage` (server) |
| Comandos | `{value, keybind, slash, onSelect}` | `{id, bind, slash, run}` en `keymap.layer` |
| Eventos | `api.event.on` con `event.properties` | `context.data.on` con `event.data` |
| Proyecto | `api.project.worktree/directory` | `context.location` / `ctx.location` |
| Limpieza | hook `dispose` | función devuelta por `setup` |
