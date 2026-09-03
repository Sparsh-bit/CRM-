import { complete } from './provider';

export type LeadContext = {
  firstName?: string | null; fullName?: string | null; company?: string | null;
  title?: string | null; industry?: string | null; city?: string | null;
  country?: string | null; website?: string | null; tier?: string | null;
  custom?: Record<string, unknown>;
};

export type WriterConfig = {
  purpose: string;              // what the user is mailing them about
  senderName: string;
  senderCompany: string;
  companyBlurb?: string | null; // what we actually sell
  tone?: string;
  language?: string;
  maxWords?: number;
  cta?: string | null;
  channel: 'email' | 'whatsapp';
  model?: string | null;
};

export const EMAIL_SYSTEM_PROMPT = `You are a senior B2B outbound copywriter. You write ONE cold email to ONE named person at ONE named company, using only the facts supplied about that lead.

NON-NEGOTIABLE RULES
1. Use only supplied facts. Never invent revenue, headcount, funding, tooling, recent news, mutual connections, or a prior conversation. If a fact is missing, write around it — do not guess.
2. The first line must be about THEM, not about you. Anchor it in a real supplied detail (their industry, city, role, or a research note). Never open with "I hope this email finds you well" or "I came across your profile".
3. One idea, one ask. Exactly one call to action.
4. Plain sentences. No em dashes, no "leverage", "synergy", "revolutionise", "game-changer", "in today's fast-paced world", "I wanted to reach out".
5. Never claim to have used, tested, visited or read something you were not told about.
6. If the contact name is a generic placeholder (CEO, MD, Manager, Owner, info, admin) or missing, address the company or use a neutral greeting — never write "Hi CEO".
7. Respect the word limit. Short beats clever.
8. Write in the requested language. If it is not English, write natively — do not translate an English draft.

OUTPUT FORMAT
Return strict JSON and nothing else:
{"subject": "...", "body": "...", "personalization_note": "...", "confidence": 0-100}

- subject: under 60 characters, lowercase-ish and human, no clickbait, no "Re:" or "Fwd:" fakery, no exclamation marks.
- body: plain text with \\n line breaks. Include a greeting and a sign-off using the sender's name and company. No HTML.
- personalization_note: one short sentence naming the specific lead fact you anchored on. If you had nothing lead-specific to work with, say so plainly.
- confidence: how well-grounded this email is in real supplied detail. Below 60 means the lead data was too thin and a human should review before sending.`;

export const WHATSAPP_SYSTEM_PROMPT = `You are writing ONE first-contact WhatsApp business message to ONE named person at ONE named company, using only the facts supplied.

NON-NEGOTIABLE RULES
1. Use only supplied facts. Never invent anything about them.
2. Maximum 55 words, ideally under 40. WhatsApp is not email.
3. Line 1: who you are and the company, in under 12 words. Line 2: why you are messaging THEM specifically. Line 3: a soft, low-friction ask (a yes/no question or a request for the right person).
4. No links unless one is supplied. No attachments. No emoji unless the tone explicitly asks for them. No ALL CAPS.
5. Never open with "Hope you are doing well" or a sales pitch paragraph.
6. If the contact name is generic (CEO, MD, Manager) or missing, use a neutral greeting and ask for the right person by role.
7. This is a cold business contact. Be respectful and easy to ignore — no urgency, no false scarcity, no follow-up threats.
8. Write in the requested language, natively.

OUTPUT FORMAT
Return strict JSON and nothing else:
{"subject": "", "body": "...", "personalization_note": "...", "confidence": 0-100}
- body uses \\n between the lines.`;

export type WrittenMessage = {
  subject: string;
  body: string;
  personalizationNote: string;
  confidence: number;
  model: string;
};

function leadFacts(lead: LeadContext): string {
  const lines: string[] = [];
  const push = (k: string, v?: unknown) => {
    if (v === null || v === undefined || String(v).trim() === '') return;
    lines.push(`- ${k}: ${String(v).trim()}`);
  };
  push('Contact name', lead.fullName || lead.firstName);
  push('Role / title', lead.title);
  push('Company', lead.company);
  push('Industry', lead.industry);
  push('City', lead.city);
  push('Country', lead.country);
  push('Website', lead.website);
  push('Lead tier', lead.tier);
  for (const [k, v] of Object.entries(lead.custom ?? {})) {
    if (String(v).trim().length > 800) continue; // keep prompts lean
    push(k, v);
  }
  return lines.length ? lines.join('\n') : '- (no lead-specific facts were supplied)';
}

export function buildUserPrompt(lead: LeadContext, cfg: WriterConfig): string {
  return [
    `SENDER: ${cfg.senderName} at ${cfg.senderCompany}`,
    cfg.companyBlurb ? `WHAT THE SENDER SELLS:\n${cfg.companyBlurb}` : '',
    `PURPOSE OF THIS MESSAGE:\n${cfg.purpose}`,
    cfg.cta ? `PREFERRED CALL TO ACTION: ${cfg.cta}` : '',
    `TONE: ${cfg.tone || 'direct, warm, no fluff'}`,
    `LANGUAGE: ${cfg.language || 'English'}`,
    `MAX WORDS: ${cfg.maxWords ?? (cfg.channel === 'whatsapp' ? 55 : 120)}`,
    '',
    'FACTS ABOUT THIS SPECIFIC LEAD (the only facts you may use):',
    leadFacts(lead),
  ].filter(Boolean).join('\n\n');
}

function parseJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI did not return JSON: ' + text.slice(0, 200));
  return JSON.parse(raw.slice(start, end + 1));
}

export async function writeMessage(lead: LeadContext, cfg: WriterConfig): Promise<WrittenMessage> {
  const system = cfg.channel === 'whatsapp' ? WHATSAPP_SYSTEM_PROMPT : EMAIL_SYSTEM_PROMPT;
  const { text, model } = await complete({
    system,
    messages: [{ role: 'user', content: buildUserPrompt(lead, cfg) }],
    temperature: 0.7,
    maxTokens: 900,
    model: cfg.model ?? undefined,
  });
  const j = parseJson(text);
  return {
    subject: String(j.subject ?? '').trim(),
    body: String(j.body ?? '').trim(),
    personalizationNote: String(j.personalization_note ?? '').trim(),
    confidence: Number(j.confidence ?? 0),
    model,
  };
}
