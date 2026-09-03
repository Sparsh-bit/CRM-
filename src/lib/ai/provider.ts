export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type CompleteArgs = {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  model?: string;
};

export type CompleteResult = { text: string; model: string };

/** Provider-agnostic completion. Add a provider here; nothing else changes. */
export async function complete(args: CompleteArgs): Promise<CompleteResult> {
  const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  if (provider === 'openai') return openai(args);
  return anthropic(args);
}

async function anthropic(a: CompleteArgs): Promise<CompleteResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const model = a.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: a.maxTokens ?? 1200,
      temperature: a.temperature ?? 0.7,
      system: a.system,
      messages: a.messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { content: { type: string; text?: string }[] };
  return { text: j.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''), model };
}

async function openai(a: CompleteArgs): Promise<CompleteResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const model = a.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: a.maxTokens ?? 1200,
      temperature: a.temperature ?? 0.7,
      messages: [{ role: 'system', content: a.system }, ...a.messages],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { choices: { message: { content: string } }[] };
  return { text: j.choices[0]?.message?.content ?? '', model };
}
