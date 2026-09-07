/**
 * Runs once when the server starts, before it accepts a request.
 *
 * Validating lazily was not enough. `getSession()` returns early when there is
 * no cookie, so an anonymous request never touched a secret and never ran the
 * check — a misconfigured production server would serve the login page happily
 * and only fall over later, when somebody tried to sign in. Boot is the honest
 * place to refuse.
 */
export async function register() {
  // Only the Node runtime has process.env in the way this expects; the edge
  // runtime does not run the worker or touch secrets.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertEnv, envProblems } = await import('./lib/env');

  const problems = envProblems();
  if (problems.length) {
    console.log('\n── OutreachPilot configuration ──');
    for (const p of problems) {
      console.log(`  ${p.fatal ? 'FATAL' : 'warn '}  ${p.key}: ${p.message}`);
    }
    console.log('');
  }

  // Throws in production, warns in development. A production process that
  // cannot sign a session safely, or would send dead unsubscribe links, must
  // not start.
  assertEnv();
}
