'use client';

export default function WorkforceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card text-center py-16 space-y-3">
      <div className="text-lg font-medium">Something went wrong loading the workforce</div>
      <p className="text-sm text-muted max-w-md mx-auto">
        {error.message || 'An unexpected error occurred.'}
      </p>
      <button className="btn inline-flex mt-2" onClick={() => reset()}>Try again</button>
    </div>
  );
}
