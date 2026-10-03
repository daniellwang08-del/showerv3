import { cn } from '@/lib/utils';

export function matchTone(score: number): 'strong' | 'good' | 'fair' | 'weak' {
  if (score >= 80) return 'strong';
  if (score >= 65) return 'good';
  if (score >= 50) return 'fair';
  return 'weak';
}

const toneClass = {
  strong: 'text-match-strong bg-match-strong/12',
  good: 'text-match-good bg-match-good/12',
  fair: 'text-match-fair bg-match-fair/15',
  weak: 'text-match-weak bg-match-weak/12',
} as const;

export function MatchScore({ score, className }: { score: number | null | undefined; className?: string }) {
  if (score == null) {
    return <span className={cn('text-xs text-muted-foreground', className)}>—</span>;
  }
  const rounded = Math.round(score);
  return (
    <span
      className={cn(
        'inline-flex h-6 min-w-9 items-center justify-center rounded-full px-2 text-xs font-semibold tabular-nums',
        toneClass[matchTone(rounded)],
        className,
      )}
      title={`Match score ${rounded}`}
    >
      {rounded}
    </span>
  );
}
