# Plan de Implementación: Audio Passthrough para OpenCode Voice

> **Nota para el agente implementador**: Este documento es autocontenido. Contiene todo el contexto técnico necesario para implementar la funcionalidad sin haber participado en las discusiones previas. Si algo no está claro, revisá las secciones de "Contexto Técnico" antes de asumir.

---

## 1. Contexto del Problema

### Qué es OpenCode Voice

Plugin para [OpenCode](https://github.com/opencode-ai/opencode) (v1.16.2) que agrega capacidades de voz:

- **STT (Speech-to-Text)**: Grabar audio con el micrófono y transcribirlo a texto usando Whisper
- **TTS (Text-to-Speech)**: Leer respuestas del LLM en voz alta usando Piper

### El problema a resolver

Actualmente, cuando un usuario graba audio con F6, el plugin intenta enviar el audio directamente al LLM como archivo nativo. Pero el LLM recibe la etiqueta `[audio-1]` como **texto plano** porque no hay ningún mecanismo que intercepte el mensaje y reemplace esa etiqueta con el archivo de audio real.

### Por qué ocurre esto

OpenCode tiene dos tipos de plugins:

- **Plugins TUI**: Se ejecutan en el proceso de la interfaz de terminal. Tienen acceso a `api.ui.toast`, `api.kv`, `api.command`, pero **NO pueden registrar hooks de chat**.
- **Plugins Server**: Se ejecutan en el proceso del backend. Pueden registrar hooks como `chat.message`, `chat.params`, etc., pero **no tienen acceso a la UI** (sin toasts, sin diálogos).

El hook `chat.message` es el único punto de intercepción disponible para modificar mensajes antes de que se envíen al LLM. Como nuestro plugin es TUI, ese hook nunca se dispara.

### Solución elegida

Crear **dos plugins separados** que trabajan juntos:

1. **Plugin TUI** (existente, modificado): Maneja la UI, grabación, y deja etiquetas `[audio-N]` visibles en el prompt
2. **Plugin Server** (nuevo): Intercepta mensajes vía `chat.message`, reemplaza etiquetas con archivos de audio reales

---

## 2. Arquitectura de OpenCode (relevante para esta implementación)

### Estructura de un mensaje

Los mensajes en OpenCode no son strings simples. Son arrays de **partes heterogéneas**:

```typescript
// Ejemplo de mensaje con texto + imagen + texto
parts = [
  { type: "text", text: "Analizá esta captura:" },
  {
    type: "file",
    mime: "image/png",
    url: "data:image/png;base64,iVBOR...",
    filename: "screenshot.png",
  },
  { type: "text", text: "¿Qué ves ahí?" },
];
```

Cada parte tiene su propio tipo. El LLM recibe esto estructurado, no todo mezclado en un string.

### Hook `chat.message`

Se dispara **después** de que el usuario presiona Enter pero **antes** de que el mensaje se envíe al LLM.

**Firma completa:**

```typescript
"chat.message"?: (
  input: {
    sessionID: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    messageID?: string;
    variant?: string;
  },
  output: {
    message: UserMessage;
    parts: Part[];  // ← ESTE ARRAY ES MUTABLE
  }
) => Promise<void>
```

**Reglas críticas:**

- El array `output.parts` **se muta in-place** (no se retorna un nuevo array)
- Las modificaciones deben hacerse **antes** de que termine la función async
- El hook se ejecuta en el proceso del servidor, no en el TUI
- Si el hook tira una excepción, el mensaje se envía igual (sin las modificaciones)

### API del cliente TUI

El plugin TUI usa `client.tui.appendPrompt()` para agregar texto al box de entrada:

```javascript
await client.tui.appendPrompt({ text: "[audio-1] " });
```

Esto solo acepta texto plano. No hay método `appendAttachment()` disponible en la API TUI actual.

---

## 3. Estado Actual del Código

### Estructura de archivos

```
/home/fciliberti/Trabajos/Tools/opencode-voice/
├── index.js                  # Plugin TUI principal
├── lib/
│   ├── stt.js                # Lógica de grabación y transcripción
│   ├── passthrough.js        # Utilidades: saveAudioToQueue, encodeWavAsDataUrl
│   ├── tts.js                # Text-to-speech (no tocar)
│   ├── llm-client.js         # Cliente LLM para normalización (no tocar)
│   └── session.js            # Helper de sesión (no tocar)
├── IMPLEMENTATION_PLAN.md    # Este archivo
└── package.json
```

### Archivo `lib/stt.js` — Función a modificar

La función `doPassthroughPipeline()` actualmente:

1. Detiene la grabación
2. Verifica si hay sesión activa
3. Guarda el audio en `/tmp/opencode-audio-{sessionID}-{index}.wav`
4. Inyecta `[audio-{index}]` en el prompt
5. Muestra toast de éxito

**Problema actual**: El paso 4 funciona, pero nadie intercepta la etiqueta para reemplazarla con el archivo real.

### Archivo `lib/passthrough.js` — Funciones existentes

- `saveAudioToQueue(sessionID)`: Copia `/tmp/opencode-stt.wav` a `/tmp/opencode-audio-{sessionID}-{index}.wav` y retorna `[audio-{index}]`
- `encodeWavAsDataUrl(filePath)`: Lee un WAV y retorna `{ success: true, dataUrl: "data:audio/wav;base64,..." }`
- `interceptAndInjectAudios(sessionID, text, parts)`: **Ya existe pero no se usa** (fue intentada en la arquitectura anterior). Puede eliminarse o ignorarse.

---

## 4. Implementación Paso a Paso

### Fase 1: Modificar Plugin TUI (F6)

**Archivo a modificar**: `lib/stt.js`

**Función a modificar**: `doPassthroughPipeline()` (aproximadamente línea 660)

**Cambios requeridos**:

1. Asegurar que la función requiera sesión activa (ya lo hace, verificar)
2. Guardar audio con sessionID en el nombre (ya lo hace via `saveAudioToQueue`)
3. Inyectar etiqueta `[audio-{index}]` en el prompt (ya lo hace)
4. Mostrar toast apropiado (ya lo hace)

**Verificación**: La función ya está casi correcta. Solo confirmar que:

- Usa `route.params.sessionID` (no hardcoded)
- Llama a `saveAudioToQueue(sessionID)` que retorna el tag
- Hace `client.tui.appendPrompt({ text: tag + " " })`

**Si la función ya hace todo esto**, no hay cambios necesarios en Fase 1. Pasar directo a Fase 2.

---

### Fase 2: Crear Plugin Server

**Nuevo archivo**: `server-plugin.js` (en la raíz del proyecto, junto a `index.js`)

**Contenido completo** (copiar y pegar, luego ajustar según necesidad):

```javascript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Configuración de logging
const LOGS_DIR = path.join(os.homedir(), ".local", "share", "opencode-voice", "logs");
const LOG_FILE = path.join(LOGS_DIR, "server.log");
const TMP_DIR = "/tmp";
const FILE_PATTERN = /^opencode-audio-(.+)-(\d+)\.wav$/;

function log(event, data = {}) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    fs.appendFileSync(LOG_FILE, entry);
  } catch {}
}

export default {
  id: "opencode-voice-server",
  server: async (input, options) => {
    log("server_plugin_initialized");

    return {
      "chat.message": async ({ sessionID }, { message, parts }) => {
        log("hook_chat_message_called", {
          sessionID,
          partsCount: parts?.length || 0,
        });

        if (!parts || !Array.isArray(parts)) {
          log("hook_early_exit_no_parts");
          return;
        }

        // === FASE 1: Colectar índices referenciados en el texto ===
        const referencedIndices = new Set();
        for (const part of parts) {
          if (part.type === "text" && part.text) {
            const matches = part.text.matchAll(/\[audio-(\d+)\]/g);
            for (const match of matches) {
              referencedIndices.add(parseInt(match[1], 10));
            }
          }
        }

        log("referenced_indices_collected", {
          sessionID,
          indices: [...referencedIndices],
        });

        // === FASE 2: Listar archivos de audio de esta sesión en /tmp ===
        let sessionFiles = [];
        try {
          const files = fs.readdirSync(TMP_DIR);
          for (const file of files) {
            const match = file.match(FILE_PATTERN);
            if (match && match[1] === sessionID) {
              sessionFiles.push({
                file,
                index: parseInt(match[2], 10),
                filePath: path.join(TMP_DIR, file),
              });
            }
          }
        } catch (err) {
          log("readdir_error", { message: err.message });
        }

        log("session_audio_files_found", {
          sessionID,
          count: sessionFiles.length,
          files: sessionFiles.map((f) => f.file),
        });

        // === FASE 3: Procesar cada archivo ===
        for (const { file, index, filePath } of sessionFiles) {
          if (referencedIndices.has(index)) {
            // El usuario referenció este audio → inyectarlo como FilePart
            try {
              const base64 = fs.readFileSync(filePath).toString("base64");
              let injected = false;

              // Buscar la parte de texto que contiene la etiqueta
              for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (part.type === "text" && part.text && part.text.includes(`[audio-${index}]`)) {
                  // Dividir el texto usando la etiqueta como separador
                  const segments = part.text.split(new RegExp(`\\[audio-${index}\\]`, "g"));

                  // Reconstruir: insertar FilePart entre segmentos
                  const replacement = [];
                  for (let j = 0; j < segments.length; j++) {
                    if (segments[j]) {
                      replacement.push({ type: "text", text: segments[j] });
                    }
                    if (j < segments.length - 1 && !injected) {
                      replacement.push({
                        type: "file",
                        mime: "audio/wav",
                        url: `data:audio/wav;base64,${base64}`,
                        filename: file,
                      });
                      injected = true;
                    }
                  }

                  // Reemplazar la parte original con segmentos + audio
                  parts.splice(i, 1, ...replacement);
                  break; // Solo primera ocurrencia en esta parte
                }
              }

              if (!injected) {
                // Etiqueta no encontrada en texto → insertar al final
                parts.push({
                  type: "file",
                  mime: "audio/wav",
                  url: `data:audio/wav;base64,${base64}`,
                  filename: file,
                });
                log("audio_injected_at_end_fallback", { sessionID, index });
              } else {
                log("audio_file_injected", { sessionID, index, sizeBytes: base64.length });
              }

              // Limpiar archivo temporal siempre
              try {
                fs.unlinkSync(filePath);
              } catch {}
            } catch (err) {
              log("audio_inject_error", { sessionID, index, message: err.message });
            }
          } else {
            // Usuario NO referenció este audio (borró etiqueta) → eliminar
            try {
              fs.unlinkSync(filePath);
              log("cleanup_unreferenced_audio", { sessionID, index, file });
            } catch {}
          }
        }

        log("hook_completed", { finalPartsCount: parts.length });
      },
    };
  },
};
```

**Puntos críticos a verificar**:

1. El ID del plugin debe ser único: `"opencode-voice-server"` (no `"opencode-voice"`)
2. Export default con propiedad `server` (no `tui`)
3. El hook muta `parts` in-place (usa `splice`, no reasigna)
4. Logging separado en `server.log` (no mezcla con `stt.log`)

---

### Fase 3: Configuración de OpenCode

**Archivo a modificar**: `~/.config/opencode/opencode.json` (o `tui.json` si usás ese)

**Configuración actual** (probablemente):

```json
{
  "plugin": ["./path/to/opencode-voice/index.js"]
}
```

**Configuración después del cambio**:

```json
{
  "plugin": ["./path/to/opencode-voice/index.js", "./path/to/opencode-voice/server-plugin.js"]
}
```

**Importante**: Los paths deben ser absolutos o relativos al directorio de trabajo. Usar rutas absolutas es más seguro:

```json
{
  "plugin": [
    "/home/fciliberti/Trabajos/Tools/opencode-voice/index.js",
    "/home/fciliberti/Trabajos/Tools/opencode-voice/server-plugin.js"
  ]
}
```

---

### Fase 4: Testing

#### Caso 1: Audio simple

1. Abrir OpenCode, iniciar sesión nueva
2. Presionar F6, hablar 2-3 segundos, presionar F6 de nuevo
3. Debería aparecer `[audio-1]` en el prompt con toast "🎤 [audio-1] — audio listo"
4. Escribir "escuchá esto" antes o después de la etiqueta
5. Presionar Enter
6. **Verificación**: El LLM debería responder como si hubiera recibido un archivo de audio (ej: "Escuché tu mensaje sobre...")
7. **Logs a revisar**: `~/.local/share/opencode-voice/logs/server.log` debe mostrar `hook_chat_message_called` y `audio_file_injected`

#### Caso 2: Múltiples audios con texto intercalado

1. F6 → grabar → F6 → aparece `[audio-1]`
2. Escribir "primero escuchá esto"
3. F6 → grabar → F6 → aparece `[audio-2]`
4. Escribir "y después esto otro"
5. Prompt final debería verse: `"primero escuchá esto [audio-1] y después esto otro [audio-2]"`
6. Enter
7. **Verificación**: El LLM recibe las partes en orden: text → file(audio-1) → text → file(audio-2)

#### Caso 3: Usuario borra etiqueta intermedia

1. Grabar audio 1 y audio 2
2. Prompt: `"[audio-1] hola [audio-2]"`
3. Borrar manualmente `[audio-1]` del prompt
4. Prompt final: `"hola [audio-2]"`
5. Enter
6. **Verificación**:
   - Solo audio-2 se inyecta como FilePart
   - En `server.log` aparece `cleanup_unreferenced_audio` para índice 1
   - Archivo `/tmp/opencode-audio-{sessionID}-1.wav` ya no existe

#### Caso 4: Audio + imágenes mezcladas

1. Pegar imagen con Ctrl+V (aparece como attachment de imagen)
2. F6 → grabar → F6 → `[audio-1]`
3. Escribir texto mezclando referencias
4. Enter
5. **Verificación**: Todo llega en orden preservado (imagen y audio como FileParts separados)

#### Caso 5: Sin sesión activa

1. Desde la landing page de OpenCode (sin sesión abierta)
2. Presionar F6
3. **Verificación**: Toast de error "No hay sesión activa para enviar audio"

#### Caso 6: Etiqueta duplicada manualmente

1. Escribir `"[audio-1] escuchar [audio-1] de nuevo"`
2. Enter
3. **Verificación**: El audio se inyecta una sola vez, la segunda etiqueta desaparece del texto

---

## 5. Troubleshooting

### El hook no se dispara

**Síntoma**: No aparece `hook_chat_message_called` en `server.log`

**Causas posibles**:

1. El plugin server no está cargado
   - Verificar `opencode.json` tiene ambos paths
   - Reiniciar OpenCode después de cambiar la config
2. Error de sintaxis en `server-plugin.js`
   - Correr `node --check server-plugin.js` para validar
3. El ID del plugin colisiona con el TUI
   - Verificar que `id: "opencode-voice-server"` es distinto de `id: "opencode-voice"`

### La etiqueta `[audio-1]` llega como texto al LLM

**Síntoma**: El LLM responde algo como "No entiendo qué es [audio-1]"

**Causas posibles**:

1. El hook se dispara pero no encuentra el archivo
   - Verificar en `server.log` si aparece `audio_file_not_found`
   - Confirmar que el archivo existe en `/tmp` con el sessionID correcto
2. El hook tira excepción silenciosa
   - Revisar `server.log` buscando `audio_inject_error`

### Archivos se acumulan en /tmp

**Síntoma**: Muchos archivos `opencode-audio-*.wav` en `/tmp`

**Causa**: El hook no se está disparando o falla antes de la limpieza

**Solución temporal**:

```bash
rm /tmp/opencode-audio-*.wav
```

**Solución permanente**: Debuggear por qué el hook no limpia (ver sección anterior)

### El LLM ignora el audio

**Síntoma**: El hook inyecta el FilePart correctamente (ver logs), pero el LLM no lo menciona

**Causa**: El modelo seleccionado no soporta audio nativo

**Verificación**:

- Gemini 3.5 Flash: soporta audio ✅
- Qwen 3.7 Plus: NO soporta audio
- Cambiar a Gemini y reintentar

---

## 6. Decisiones de Diseño Documentadas

### ¿Por qué `[audio-N]` como formato de etiqueta?

- Consistente con el estilo de OpenCode (similar a menciones `@archivo`)
- Fácil de detectar con regex: `/\[audio-(\d+)\]/g`
- No colisiona con texto normal (corchetes + prefijo específico)
- Numérico para permitir múltiples audios sin ambigüedad

### ¿Por qué remover la etiqueta del texto?

- El LLM no necesita ver la etiqueta — el FilePart ya lleva la información
- Mantenerla consumiría tokens innecesarios (~5 tokens por etiqueta)
- Podría confundir al modelo si interpreta `[audio-1]` como instrucción
- El orden posicional del FilePart ya indica la ubicación relativa

### ¿Por qué limpieza contextual en lugar de TTL?

- TTL puede borrar audios válidos de sesiones largas (>1 hora)
- La limpieza contextual es precisa: solo borra lo no referenciado
- Ocurre en el momento correcto (al enviar), no arbitrariamente

### ¿Por qué dos plugins separados en lugar de migrar todo a Server?

- El plugin TUI tiene UI valiosa (toasts, diálogos, persistencia kv) que se perdería
- Migrar todo requeriría reescribir comandos, selección de micrófono, etc.
- Dos plugins permiten evolución independiente
- El plugin Server tiene responsabilidad única (interceptar mensajes)

---

## 7. Referencias Técnicas

### Archivos clave de OpenCode para entender el flujo

- `/home/fciliberti/Trabajos/Tools/Opencode/packages/plugin/src/index.ts` — Definición de tipos de plugins y hooks
- `/home/fciliberti/Trabajos/Tools/Opencode/packages/app/src/components/prompt-input/build-request-parts.ts` — Cómo se construyen las parts antes de enviar
- `/home/fciliberti/Trabajos/Tools/Opencode/packages/app/src/components/prompt-input/submit.ts` — Flujo de envío de mensajes

### Logs relevantes

- TUI: `~/.local/share/opencode-voice/logs/stt.log`
- Server: `~/.local/share/opencode-voice/logs/server.log`

### Comandos útiles para debugging

```bash
# Ver archivos de audio en /tmp
ls -lh /tmp/opencode-audio-*.wav

# Ver logs del servidor en tiempo real
tail -f ~/.local/share/opencode-voice/logs/server.log

# Validar sintaxis del plugin server
node --check /home/fciliberti/Trabajos/Tools/opencode-voice/server-plugin.js

# Ver configuración de plugins cargados
cat ~/.config/opencode/opencode.json | grep plugin
```

---

## 8. Checklist de Implementación

- [ ] Fase 1: Verificar que `doPassthroughPipeline()` en `lib/stt.js` funcione correctamente (guarda audio con sessionID, inyecta etiqueta, muestra toast)
- [ ] Fase 2: Crear `server-plugin.js` con el hook `chat.message` completo
- [ ] Fase 2: Validar sintaxis con `node --check server-plugin.js`
- [ ] Fase 3: Agregar `server-plugin.js` a la configuración de plugins en `opencode.json`
- [ ] Fase 3: Reiniciar OpenCode para cargar el nuevo plugin
- [ ] Fase 4: Ejecutar Caso 1 (audio simple) y verificar logs
- [ ] Fase 4: Ejecutar Caso 3 (borrar etiqueta) y verificar cleanup
- [ ] Fase 4: Ejecutar Caso 6 (etiqueta duplicada) y verificar comportamiento
- [ ] Documentar cualquier issue encontrado en este archivo bajo sección "Issues Encontrados"

---

## 9. Issues Encontrados (para documentar durante implementación)

_(Dejar vacío inicialmente, llenar durante testing)_

| Issue | Descripción | Solución aplicada | Fecha |
| ----- | ----------- | ----------------- | ----- |
|       |             |                   |       |
