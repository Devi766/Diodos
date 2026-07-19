'use client';

export default function RouteContentFallback() {
  const blockClass =
    'rounded-lg bg-gradient-to-r from-white/20 via-white/30 to-white/20 shadow-none animate-pulse dark:from-white/5 dark:via-white/10 dark:to-white/5';

  return (
    <div className="space-y-3" aria-hidden="true">
      <div className={`h-20 ${blockClass}`} />
      <div className="grid gap-3 md:grid-cols-2">
        <div className={`h-28 ${blockClass}`} />
        <div className={`h-28 ${blockClass}`} />
      </div>
    </div>
  );
}
