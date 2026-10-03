import { NaoMark } from '@/components/brand/NaoLogo';

export type BrandMood = 'idle' | 'thinking' | 'celebrate';

type Size = 'sm' | 'md' | 'lg';

const SIZE: Record<Size, { wrap: string; logo: string; ring: string; check: string }> = {
  sm: { wrap: 'h-10 w-10', logo: 'size-7', ring: 'border-[1.5px]', check: 'h-4 w-4 text-[9px]' },
  md: { wrap: 'h-12 w-12', logo: 'size-8', ring: 'border-2', check: 'h-5 w-5 text-[10px]' },
  lg: { wrap: 'h-16 w-16', logo: 'size-11', ring: 'border-2', check: 'h-5 w-5 text-[10px]' },
};

/** NAO AI avatar for AI surfaces (OneClick, job assistant): the app-icon tile with the mark. */
export function BrandMark({
  mood = 'idle',
  size = 'md',
  className = '',
}: {
  mood?: BrandMood;
  size?: Size;
  className?: string;
}) {
  const s = SIZE[size];
  const thinking = mood === 'thinking';
  const celebrate = mood === 'celebrate';

  return (
    <div
      className={`relative shrink-0 ${s.wrap} ${className}`}
      role="img"
      aria-label="NAO AI"
    >
      {thinking && (
        <span
          aria-hidden
          className={`brand-ring absolute -inset-1.5 rounded-full ${s.ring} border-transparent border-t-brand border-r-brand/40`}
        />
      )}
      {celebrate && (
        <span
          aria-hidden
          className={`absolute -right-1 -top-1 z-10 flex ${s.check} items-center justify-center rounded-full bg-status-ready font-bold text-background shadow-sm ring-2 ring-background`}
        >
          ✓
        </span>
      )}
      <div
        className={`relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-[#111A3F] to-[#04060F] shadow-sm ring-1 ring-white/10 ${
          thinking ? 'brand-breathe' : celebrate ? 'brand-pop' : ''
        }`}
      >
        <NaoMark className={s.logo} />
      </div>
    </div>
  );
}
