import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { db } from './db';
import { authSecret } from './env';

const secret = () => new TextEncoder().encode(authSecret());
const COOKIE = 'op_session';

export type SessionData = { userId: string; workspaceId: string };

export async function createSession(data: SessionData) {
  const token = await new SignJWT(data)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 30,
  });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<SessionData | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, secret());
    return { userId: String(payload.userId), workspaceId: String(payload.workspaceId) };
  } catch { return null; }
}

/** Throws if not signed in. Use at the top of every server action / route. */
export async function requireSession(): Promise<SessionData> {
  const s = await getSession();
  if (!s) throw new Error('UNAUTHORIZED');
  return s;
}

export async function currentWorkspace() {
  const s = await getSession();
  if (!s) return null;
  return db.workspace.findUnique({ where: { id: s.workspaceId } });
}

// ─────────────────────────── Roles ───────────────────────────

export type Role = 'owner' | 'admin' | 'member';

/** Higher wins. A check is "at least this rank", never an equality test. */
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function atLeast(role: string, needed: Role): boolean {
  return (RANK[role as Role] ?? 0) >= RANK[needed];
}

/**
 * The session's role in its current workspace.
 *
 * Read from the database rather than the cookie on purpose: a role kept in a
 * signed cookie survives being demoted until the cookie expires, which is a
 * 30-day window in which a removed admin still has admin.
 */
export async function currentRole(): Promise<Role | null> {
  const s = await getSession();
  if (!s) return null;
  const m = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: s.userId, workspaceId: s.workspaceId } },
    select: { role: true },
  });
  return (m?.role as Role) ?? null;
}

/**
 * Gate a destructive or account-level action.
 *
 * Every action that deletes data, changes who can send, or touches credentials
 * calls this. It throws rather than returning a boolean so a forgotten `if`
 * cannot silently permit the action.
 */
export async function requireRole(needed: Role): Promise<{ session: SessionData; role: Role }> {
  const session = await requireSession();
  const role = await currentRole();
  if (!role) throw new Error('You are not a member of this workspace.');
  if (!atLeast(role, needed)) {
    throw new Error(`This needs the ${needed} role. You are ${role} in this workspace.`);
  }
  return { session, role };
}
