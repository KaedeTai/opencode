import path from "path"
import { Global } from "@opencode-ai/core/global"

// Whisper runs locally on Metal for voice transcription. Path is
// overridable so the same binary works on Linux (CPU whisper.cpp)
// or with a custom model size.
const WHISPER_BIN = process.env.WHISPER_BIN ?? "/opt/homebrew/bin/whisper-cli"
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? path.join(Global.Path.home, "models", "whisper", "ggml-large-v3-turbo.bin")

// Voice messages go through whisper.cpp to text. We don't ship the
// audio to the model — speech-as-text is just a richer text prompt.
export async function transcribeAudio(buffer: Uint8Array, ext = "ogg"): Promise<string> {
  if (!(await Bun.file(WHISPER_BIN).exists())) {
    throw new Error(`whisper-cli not found at ${WHISPER_BIN} (set WHISPER_BIN env var to override)`)
  }
  if (!(await Bun.file(WHISPER_MODEL).exists())) {
    throw new Error(`whisper model not found at ${WHISPER_MODEL} (set WHISPER_MODEL env var to override)`)
  }
  // whisper.cpp's audio decoder (dr_wav) only handles PCM/WAV and
  // Ogg Vorbis — Telegram voice messages are Ogg Opus, which fails
  // silently with "failed to read audio data as wav". Pipe the raw
  // bytes through ffmpeg to canonical 16kHz mono PCM first, then
  // hand the wav to whisper. 16kHz/mono is whisper's native input
  // so we skip a redundant resample.
  const id = Date.now()
  const src = path.join(Global.Path.data, `voice-${id}.${ext}`)
  const wav = path.join(Global.Path.data, `voice-${id}.wav`)
  try {
    await Bun.write(src, buffer)
    const conv = Bun.spawn(
      [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", src,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        wav,
      ],
      { stderr: "pipe" },
    )
    const convErr = await new Response(conv.stderr).text()
    const convCode = await conv.exited
    if (convCode !== 0) {
      throw new Error(`ffmpeg conversion failed (${convCode}): ${convErr.trim()}`)
    }
    // -np = no progress, -otxt - = plain text to stdout.
    const proc = Bun.spawn(
      [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", wav, "--no-timestamps", "-np", "-otxt", "-"],
      { stderr: "pipe" },
    )
    const [text, werr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      throw new Error(`whisper-cli exited ${code}: ${werr.trim().split("\n").slice(-3).join(" | ")}`)
    }
    return text.trim()
  } finally {
    // Best-effort cleanup. Audio data may be sensitive (e.g.
    // dictation of private notes), so don't leave it lying around.
    await Bun.$`rm -f ${src} ${wav}`.quiet().nothrow()
  }
}

export * as TelegramWhisper from "./whisper"
