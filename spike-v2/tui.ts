import { Plugin } from "@opencode/plugin/tui"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const LOG = "/tmp/voice-spike.log"

function log(event: string, data: Record<string, unknown> = {}) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n")
  } catch {}
}

function focusedEditor(context: any): any {
  try {
    return context.renderer?.currentFocusedEditor ?? null
  } catch (e) {
    log("focusedEditor.error", { error: String(e) })
    return null
  }
}

function insertAtCursor(context: any, text: string, source: string) {
  const editor = focusedEditor(context)
  if (!editor || editor.isDestroyed) {
    context.ui.toast.show({ message: "Voice: no hay editor enfocado", variant: "error" })
    log("insert.attempt", { source, hasEditor: !!editor, text })
    return
  }
  const before = editor.plainText ?? ""
  const cursor = editor.cursorOffset ?? null
  try {
    editor.insertText(text)
    context.renderer.requestRender()
    log("insert.ok", { source, before, cursor, inserted: text, after: editor.plainText })
  } catch (e) {
    log("insert.error", { source, error: String(e) })
    context.ui.toast.show({ message: `Voice error: ${String(e)}`, variant: "error" })
  }
}

// ---- grabación (parec -> sox), mismo esquema que lib/stt.js ----
type Recorder = {
  parec: any
  sox: any
  file: string
  startedAt: number
}
let current: Recorder | null = null
let maxTimer: any = null

function startRecording(context: any, options: any) {
  const file = path.join(os.tmpdir(), `voice-spike-${process.pid}-${Date.now()}.wav`)
  const device = options.mic || "@DEFAULT_SOURCE@"
  const parec = spawn(
    "parec",
    ["--device", device, "--format", "s16le", "--rate", "16000", "--channels", "1", "--latency-msec", "50"],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  const sox = spawn(
    "sox",
    ["-t", "raw", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-", file],
    { stdio: ["pipe", "ignore", "pipe"] },
  )
  parec.stdout.pipe(sox.stdin)
  parec.on("error", (e: any) => log("parec.error", { error: e.message }))
  sox.on("error", (e: any) => log("sox.error", { error: e.message }))
  current = { parec, sox, file, startedAt: Date.now() }
  log("record.start", { device, file })
  context.ui.toast.show({ message: "🔴 Grabando… (F5 para parar)", variant: "info", duration: 60000 })

  maxTimer = setTimeout(() => {
    if (current) void stopAndTranscribe(context, options)
  }, 120000)
}

function stopRecording(): Promise<string | null> {
  return new Promise((resolve) => {
    const rec = current
    if (!rec) return resolve(null)
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(maxTimer)
      current = null
      let size = 0
      try {
        size = fs.statSync(rec.file).size
      } catch {}
      log("record.stop", { file: rec.file, ms: Date.now() - rec.startedAt, size })
      resolve(size > 44 ? rec.file : null)
    }
    rec.sox.once("exit", finish)
    try {
      rec.parec.kill("SIGINT")
    } catch {}
    setTimeout(() => {
      try {
        rec.sox.kill("SIGKILL")
      } catch {}
      finish()
    }, 3000)
  })
}

async function transcribe(file: string, options: any) {
  const endpoint = options.sttEndpoint || "https://api.groq.com/openai/v1"
  const model = options.sttModel || "whisper-large-v3-turbo"
  const keyEnv = options.sttApiKeyEnv || "GROQ_API_KEY"
  const key = process.env[keyEnv]
  if (!key) return { error: `Falta ${keyEnv} en el entorno` }
  const buf = await fs.promises.readFile(file)
  const form = new FormData()
  form.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav")
  form.append("model", model)
  form.append("response_format", "json")
  form.append("language", options.language || "es")
  const base = endpoint.endsWith("/") ? endpoint : endpoint + "/"
  const t0 = Date.now()
  const resp = await fetch(base + "audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key },
    body: form,
    signal: AbortSignal.timeout(180000),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    log("stt.error", { status: resp.status, body: body.slice(0, 300) })
    return { error: `STT ${resp.status}: ${body.slice(0, 160)}` }
  }
  const data: any = await resp.json()
  const text = (data.text ?? "").trim()
  log("stt.ok", { ms: Date.now() - t0, chars: text.length, text })
  return { text }
}

async function stopAndTranscribe(context: any, options: any) {
  context.ui.toast.show({ message: "⏳ Transcribiendo…", variant: "info", duration: 20000 })
  const file = await stopRecording()
  if (!file) {
    context.ui.toast.show({ message: "Voice: no se grabó audio", variant: "error" })
    return
  }
  try {
    const res = await transcribe(file, options)
    if (res.error) {
      context.ui.toast.show({ message: `Voice: ${res.error}`, variant: "error", duration: 8000 })
      return
    }
    const text = (res.text || "").trim()
    if (!text) {
      context.ui.toast.show({ message: "Voice: transcripción vacía", variant: "warning" })
      return
    }
    insertAtCursor(context, text + " ", "stt")
    context.ui.toast.show({ message: "✅ Insertado", variant: "success", duration: 2500 })
  } catch (e) {
    log("pipeline.error", { error: String(e) })
    context.ui.toast.show({ message: `Voice error: ${String(e)}`, variant: "error", duration: 8000 })
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {}
  }
}

export default Plugin.define({
  id: "voice-spike",
  setup(context: any) {
    const options = (context.options ?? {}) as any
    const renderer = context.renderer
    log("setup", {
      hasRenderer: !!renderer,
      hasKeyInput: !!renderer?.keyInput,
      options,
      groqKey: !!process.env[options.sttApiKeyEnv || "GROQ_API_KEY"],
    })

    let onKey: ((event: any) => void) | undefined
    try {
      const keyInput = renderer?.keyInput
      if (keyInput?.prependListener) {
        onKey = (event: any) => {
          if (event.__voiceSpikeHandled) return
          if (String(event?.name ?? "").toLowerCase() !== "f5") return
          event.__voiceSpikeHandled = true
          event.preventDefault?.()
          event.stopPropagation?.()
          if (current) {
            log("key.f5.stop")
            void stopAndTranscribe(context, options)
          } else {
            log("key.f5.start")
            startRecording(context, options)
          }
        }
        const g = globalThis as any
        if (g.__voiceSpikeOnKey) {
          try {
            keyInput.off?.("keypress", g.__voiceSpikeOnKey)
            keyInput.removeListener?.("keypress", g.__voiceSpikeOnKey)
          } catch {}
        }
        g.__voiceSpikeOnKey = onKey
        keyInput.prependListener("keypress", onKey)
        log("keyinput.registered", { ok: true })
      }
    } catch (e) {
      log("keyinput.error", { error: String(e) })
    }

    return () => {
      log("dispose")
      try {
        if (onKey) {
          renderer?.keyInput?.off?.("keypress", onKey)
          renderer?.keyInput?.removeListener?.("keypress", onKey)
        }
        const g = globalThis as any
        if (g.__voiceSpikeOnKey === onKey) delete g.__voiceSpikeOnKey
      } catch {}
    }
  },
})
