import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Configuración de logging
const LOGS_DIR = path.join(os.homedir(), ".local", "share", "opencode-voice", "logs");
const LOG_FILE = path.join(LOGS_DIR, "server.log");

export const FILE_PATTERN = /^opencode-audio-(.+?)-(\d+)\.wav$/;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export function generatePartId() {
  return `prt_${crypto.randomUUID().replace(/-/g, "")}`;
}
export function getTmpDir(options) {
  return options?.tmpDir || process.env.OPENCODE_VOICE_TMPDIR || "/tmp";
}

function log(event, data = {}) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {}
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    fs.appendFileSync(LOG_FILE, entry);
  } catch {}
}

export default {
  id: "opencode-voice-server",
  server: async (_input, _options) => {
    log("server_plugin_initialized");
    const serverOptions = _options;

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

        if (referencedIndices.size === 0) {
          log("hook_completed", {
            sessionID,
            messageID,
            finalPartsCount: parts.length,
            finalPartsStructure: parts.map((p, i) => ({
              index: i,
              type: p.type,
              hasId: !!p.id,
              textLength: p.text?.length || 0,
              mime: p.mime || null,
              filename: p.filename || null,
            })),
            earlyExit: true,
          });
          return;
        }

        // === FASE 2: Listar archivos de audio de esta sesión en tmpDir ===
        const tmpDir = getTmpDir(serverOptions);
        const sessionFiles = [];
        try {
          const files = fs.readdirSync(tmpDir);
          for (const file of files) {
            const match = file.match(FILE_PATTERN);
            if (match && match[1] === sessionID) {
              sessionFiles.push({
                file,
                index: parseInt(match[2], 10),
                filePath: path.join(tmpDir, file),
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
              const { size: sizeBytes } = fs.statSync(filePath);
              if (sizeBytes > MAX_AUDIO_BYTES) {
                log("audio_rejected_too_large", {
                  sessionID,
                  index,
                  sizeBytes,
                  maxBytes: MAX_AUDIO_BYTES,
                });
                try {
                  fs.unlinkSync(filePath);
                } catch (err) {
                  log("audio_cleanup_error", { sessionID, index, message: err.message });
                }
                continue;
              }
              if (sizeBytes <= 44) {
                log("audio_rejected_empty", { sessionID, index, sizeBytes });
                try {
                  fs.unlinkSync(filePath);
                } catch (err) {
                  log("audio_cleanup_error", { sessionID, index, message: err.message });
                }
                continue;
              }
              const base64 = fs.readFileSync(filePath).toString("base64");
              // Extraer solo el base64 puro (sin el prefix "data:audio/wav;base64,")
              const rawBase64 = base64.includes(",") ? base64.split(",")[1] : base64;
              const makeFilePart = (msgID) => ({
                id: generatePartId(),
                type: "file",
                mime: "audio/wav",
                data: rawBase64,
                filename: file,
                messageID: msgID,
                sessionID,
              });
              let injectedCount = 0;

              // Buscar la parte de texto que contiene la etiqueta
              for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (part.type === "text" && part.text && part.text.includes(`[audio-${index}]`)) {
                  // Dividir el texto usando la etiqueta como separador
                  const segments = part.text.split(new RegExp(`\\[audio-${index}\\]`, "g"));

                  // Reconstruir: insertar un FilePart por CADA ocurrencia del tag
                  const replacement = [];
                  for (let j = 0; j < segments.length; j++) {
                    if (segments[j]) {
                      replacement.push({
                        id: generatePartId(),
                        type: "text",
                        text: segments[j],
                        messageID: messageID || part.messageID,
                        sessionID,
                      });
                    }
                    if (j < segments.length - 1) {
                      replacement.push(makeFilePart(messageID || part.messageID));
                      injectedCount++;
                    }
                  }

                  // Reemplazar la parte original con segmentos + audios
                  parts.splice(i, 1, ...replacement);
                  break; // Solo primera parte que contiene el tag
                }
              }

              if (injectedCount === 0) {
                parts.push(makeFilePart(messageID || parts[0]?.messageID));
                log("audio_injected_at_end_fallback", { sessionID, index });
              } else {
                log("audio_file_injected", {
                  sessionID,
                  index,
                  sizeBytes,
                  base64Length: base64.length,
                  occurrences: injectedCount,
                });
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
