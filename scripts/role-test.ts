/**
 * Role ranking (`src/lib/session.ts`) — the comparison every `requireRole`
 * call rests on. `currentRole`/`requireRole` themselves need a live session
 * cookie and a real database row (Next's `cookies()` only works inside a
 * request), so those are exercised by hand against the running app: sign in,
 * hit /settings, /mailboxes and /whatsapp as the seeded owner, confirm each
 * gated action still succeeds. What's unit-testable here, and where an
 * off-by-one would actually let the wrong role through, is the rank table.
 */
import { atLeast, type Role } from '../src/lib/session';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

const roles: Role[] = ['member', 'admin', 'owner'];

// Every role satisfies its own requirement.
for (const r of roles) check(`${r} atLeast ${r}`, atLeast(r, r), true);

// Higher wins; lower never does.
check('owner atLeast admin', atLeast('owner', 'admin'), true);
check('owner atLeast member', atLeast('owner', 'member'), true);
check('admin atLeast owner', atLeast('admin', 'owner'), false);
check('admin atLeast member', atLeast('admin', 'member'), true);
check('member atLeast admin', atLeast('member', 'admin'), false);
check('member atLeast owner', atLeast('member', 'owner'), false);

// A role that is not a recognised rank (corrupt data, a future typo) must
// never pass a check by falling through to `undefined >= anything`.
check('unknown role never satisfies member', atLeast('bogus', 'member'), false);
check('empty role never satisfies member', atLeast('', 'member'), false);

console.log(fails ? `\n${fails} FAILED` : '\nall role tests passed');
process.exit(fails ? 1 : 0);
