'use client';

import { useActionState, useState } from 'react';
import { Eye, EyeSlash } from '@phosphor-icons/react';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';

export type LoginState = { error: string | null };

/**
 * A real client form island (the rest of the page stays server-rendered) —
 * this is the ONE piece that needs to be a Client Component, since inline
 * error/pending state requires React 19's useActionState. The server action
 * itself (submit, in page.tsx) is unchanged auth logic: same rate limiter,
 * same bcrypt calls, same session creation — this only changes how a
 * failure gets COMMUNICATED (a returned state the form renders inline)
 * instead of an uncaught throw hitting Next's generic error boundary with
 * a raw exception message.
 */
export function LoginForm({ action }: { action: (prevState: LoginState, formData: FormData) => Promise<LoginState> }) {
  const [state, formAction, isPending] = useActionState(action, { error: null });
  const [showPassword, setShowPassword] = useState(false);

  return (
    <Card className="space-y-5">
      <div className="space-y-1 text-center">
        <h1 className="card-heading text-lg">Sign in</h1>
        <p className="text-secondary">Or enter a new email to create a workspace.</p>
      </div>

      {state.error && (
        <div id="login-error" role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email" className="input" name="email" type="email" autoComplete="email" required disabled={isPending}
            aria-invalid={!!state.error} aria-describedby={state.error ? 'login-error' : undefined}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <div className="relative">
            <input
              id="password" className="input pr-10" name="password" type={showPassword ? 'text' : 'password'}
              autoComplete="current-password" required minLength={8} disabled={isPending}
              aria-invalid={!!state.error} aria-describedby={state.error ? 'login-error' : undefined}
            />
            <button
              type="button" onClick={() => setShowPassword((v) => !v)} disabled={isPending}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-slate-200 transition-colors p-1 disabled:opacity-40"
            >
              {showPassword ? <EyeSlash size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-secondary mt-1.5">At least 8 characters. New here? This creates your workspace.</p>
        </div>
        <Button type="submit" className="w-full justify-center" disabled={isPending}>
          {isPending ? 'Signing in…' : 'Continue'}
        </Button>
      </form>
    </Card>
  );
}
