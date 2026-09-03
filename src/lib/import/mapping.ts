/**
 * Auto column mapping.
 *
 * The user drops in any spreadsheet — "Contact Name", "Mobile No.", "Organisation",
 * "Sector", "Designation" — and we work out which column is which without asking.
 * Everything we don't recognise is still kept, verbatim, in Lead.custom, so it stays
 * usable as a {{merge_tag}} and as context for the AI writer.
 */

export const CANONICAL = [
  'firstName','lastName','fullName','email','phone','company','title',
  'industry','city','country','website','linkedin','tier',
] as const;
export type Canonical = (typeof CANONICAL)[number];

const PATTERNS: Record<Canonical, RegExp[]> = {
  email:     [/^e[-_ ]?mail/i, /email.*address/i, /^mail$/i, /work.*email/i],
  phone:     [/phone/i, /mobile/i, /^tel/i, /whats?app/i, /contact.*(no|number)/i, /^cell/i],
  firstName: [/^first[-_ ]?name/i, /^fname$/i, /^given[-_ ]?name/i],
  lastName:  [/^last[-_ ]?name/i, /^lname$/i, /surname/i, /family[-_ ]?name/i],
  fullName:  [/^(contact|full|person|lead|customer|client)?[-_ ]?name$/i, /contact.*person/i, /^poc$/i],
  company:   [/company/i, /organi[sz]ation/i, /^org$/i, /business.*name/i, /account.*name/i, /^firm$/i, /employer/i],
  title:     [/^(job[-_ ]?)?title/i, /designation/i, /^role$/i, /position/i, /seniority/i],
  industry:  [/industry/i, /^sector/i, /vertical/i, /category/i, /business.*type/i],
  city:      [/^city/i, /^town/i, /location/i, /^region/i, /emirate/i],
  country:   [/^country/i, /^nation/i],
  website:   [/website/i, /^web$/i, /^url/i, /domain/i, /^site$/i, /^source$/i],
  linkedin:  [/linked[-_ ]?in/i, /^li[-_ ]?(url|profile)/i],
  tier:      [/^tier/i, /^priority/i, /^grade/i, /^segment/i],
};

/** Confidence 0-100 that `header` is `field`. */
function score(header: string, field: Canonical): number {
  const h = header.trim();
  if (!h) return 0;
  for (const [i, re] of PATTERNS[field].entries()) {
    if (re.test(h)) return 100 - i * 5;
  }
  return 0;
}

export type ColumnMap = Partial<Record<Canonical, string>>;

export function autoMap(headers: string[]): { map: ColumnMap; unmapped: string[] } {
  const map: ColumnMap = {};
  const taken = new Set<string>();

  // Highest-confidence pairs win first, so "Contact Name" doesn't steal "Company Name".
  const pairs: { field: Canonical; header: string; s: number }[] = [];
  for (const field of CANONICAL) {
    for (const header of headers) pairs.push({ field, header, s: score(header, field) });
  }
  pairs.sort((a, b) => b.s - a.s);

  for (const p of pairs) {
    if (p.s <= 0) continue;
    if (map[p.field] || taken.has(p.header)) continue;
    map[p.field] = p.header;
    taken.add(p.header);
  }

  return { map, unmapped: headers.filter((h) => h && !taken.has(h)) };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function isValidEmail(v: unknown): boolean {
  return typeof v === 'string' && EMAIL_RE.test(v.trim());
}

/** Normalise a phone to E.164-ish. `defaultCc` like "91" is used when no + prefix. */
export function normalizePhone(raw: unknown, defaultCc = ''): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const plus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  s = s.replace(/^0+/, '');
  if (!plus && defaultCc && !s.startsWith(defaultCc)) s = defaultCc + s;
  if (s.length < 8 || s.length > 15) return null;
  return '+' + s;
}

/**
 * "Mohammed Hamidul Hoque (Shamim)" → first "Mohammed", last "Hamidul Hoque".
 * Honorifics are stripped so nobody gets "Hi Dr.,", and role placeholders in the
 * name column ("CEO", "Managing Director") return empty so the template falls
 * back to a neutral greeting instead of "Hi CEO,".
 */
const HONORIFICS = /^(mr|mrs|ms|miss|dr|prof|eng|engr|er|capt|sh|shk|sheikh|shaikh|haji|sir|madam)\.?$/i;
const ROLE_ONLY = /^(ceo|cto|coo|cfo|md|gm|vp|hr|pro|poc|owner|founder|partner|manager|director|managing director|general manager|branch manager|proprietor|admin|administrator|info|sales|contact|team|office|purchase|accounts|procurement|the owner|to whom it may concern)$/i;

export function splitName(full: string): { firstName: string; lastName: string } {
  const clean = full
    .replace(/\([^)]*\)/g, ' ')      // drop "(Shamim)"
    .replace(/[",]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean || ROLE_ONLY.test(clean)) return { firstName: '', lastName: '' };

  const parts = clean.split(' ').filter((p) => !HONORIFICS.test(p));
  if (!parts.length) return { firstName: '', lastName: '' };
  if (ROLE_ONLY.test(parts.join(' '))) return { firstName: '', lastName: '' };

  const first = parts[0];
  // A single initial ("A. Kumar") is not a usable greeting on its own.
  if (parts.length === 1 && first.replace(/\./g, '').length <= 1) return { firstName: '', lastName: '' };
  return { firstName: first.replace(/\.$/, ''), lastName: parts.slice(1).join(' ') };
}
