import { cn } from '@/lib/utils';
import { initialsOf } from './insightsSubject';

const AVATAR_TONES = [
  'bg-chart-1/15 text-chart-1',
  'bg-chart-2/15 text-chart-2',
  'bg-chart-3/15 text-chart-3',
  'bg-chart-4/15 text-chart-4',
  'bg-chart-5/15 text-chart-5',
  'bg-status-ready/15 text-status-ready',
];

export function avatarTone(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}

export function MemberAvatar({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
        avatarTone(id),
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
