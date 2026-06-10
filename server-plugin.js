import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Configuración de logging
const LOGS_DIR = path.join(os.homedir(), ".local", "share", "opencode-voice", "logs");
const LOG_FILE = path.join(LOGS_DIR, "server.log");
const TMP_DIR = "/tmp";
const FILE_PATTERN = /^opencode-audio-(.+)-(\d+)\.wav$/;

let partIdCounter = 0;
function generatePartId() {
  return `part_audio_${Date.now()}_${++partIdCounter}`;
}

function log(event, data = {}) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    fs.appendFileSync(LOG_FILE, entry);
  } catch {}
}

export default {
  id: "opencode-voice-server",
  server: async (_input, _options) => {
    log("server_plugin_initialized");

    return {
      "chat.message": async ({ sessionID, messageID }, { _message, parts }) => {
        log("hook_chat_message_called", {
          sessionID,
          messageID,
          partsCount: parts?.length || 0,
          partsStructure: parts?.map((p, i) => ({
            index: i,
            type: p.type,
            hasId: !!p.id,
            textLength: p.text?.length || 0,
            mime: p.mime || null,
            filename: p.filename || null,
          })),
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
        const sessionFiles = [];
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
                      replacement.push({
                        id: generatePartId(),
                        type: "text",
                        text: segments[j],
                        messageID: messageID || part.messageID,
                      });
                    }
                    if (j < segments.length - 1 && !injected) {
                      replacement.push({
                        id: generatePartId(),
                        type: "file",
                        mime: "audio/wav",
                        url: `data:audio/wav;base64,${base64}`,
                        filename: file,
                        messageID: messageID || part.messageID,
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
                parts.push({
                  id: generatePartId(),
                  type: "file",
                  mime: "audio/wav",
                  url: `data:audio/wav;base64,${base64}`,
                  filename: file,
                  messageID: messageID || parts[0]?.messageID,
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

        log("hook_completed", { 
          finalPartsCount: parts.length,
          finalPartsStructure: parts.map((p, i) => ({
            index: i,
            type: p.type,
            hasId: !!p.id,
            textLength: p.text?.length || 0,
            mime: p.mime || null,
            filename: p.filename || null,
          })),
        });
      },
    };
  },
};
