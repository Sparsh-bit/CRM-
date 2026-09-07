/**
 * Audio transcription — extends the existing AI provider credentials
 * (GROQ_API_KEY / OPENAI_API_KEY, the same keys src/lib/ai/provider.ts
 * already reads), not a second AI integration. Both Groq and OpenAI expose
 * a Whisper-compatible `/audio/transcriptions` endpoint; Anthropic has no
 * audio API, so it is never part of this chain. Honestly reports
 * not-configured rather than fabricating a transcript when neither key is set.
 */
import { promises as fs } from 'node:fs';

export type TranscribeResult =
  | { status: 'ok'; text: string; provider: string }
  | { status: 'not_configured'; reason: string }
  | { status: 'error'; reason: string };

const timeoutMs = () => Number(process.env.AI_TIMEOUT_MS ?? 30_000); // read at call time (see webFetch.ts)

async function callWhisperEndpoint(url: string, key: string, filePath: string, model: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(url, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${key}` }, body: form });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 400)}`);
    const j = (await res.json()) as { text?: string };
    return j.text ?? '';
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeAudio(filePath: string): Promise<TranscribeResult> {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!groqKey && !openaiKey) {
    return { status: 'not_configured', reason: 'No transcription provider configured — set GROQ_API_KEY or OPENAI_API_KEY.' };
  }
  try {
    if (groqKey) {
      const text = await callWhisperEndpoint('https://api.groq.com/openai/v1/audio/transcriptions', groqKey, filePath, process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo');
      return { status: 'ok', text, provider: 'groq' };
    }
    const text = await callWhisperEndpoint('https://api.openai.com/v1/audio/transcriptions', openaiKey!, filePath, process.env.OPENAI_WHISPER_MODEL || 'whisper-1');
    return { status: 'ok', text, provider: 'openai' };
  } catch (e) {
    return { status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
