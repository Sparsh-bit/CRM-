export default function RootLoading() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="h-7 w-40 bg-line rounded" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card">
            <div className="h-3 w-16 bg-line rounded" />
            <div className="h-6 w-10 bg-line rounded mt-2" />
          </div>
        ))}
      </div>
      <div className="card space-y-3">
        <div className="h-4 w-32 bg-line rounded" />
        <div className="h-3 w-full bg-line rounded" />
        <div className="h-3 w-2/3 bg-line rounded" />
      </div>
    </div>
  );
}
