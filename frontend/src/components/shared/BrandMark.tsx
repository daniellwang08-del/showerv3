export type BrandMood = 'idle' | 'thinking' | 'celebrate';

type Size = 'sm' | 'md' | 'lg';

const SIZE: Record<Size, { wrap: string; logo: string; ring: string }> = {
  sm: { wrap: 'h-10 w-10', logo: 'h-5 w-5', ring: 'border-2' },
  md: { wrap: 'h-12 w-12', logo: 'h-6 w-6', ring: 'border-[2.5px]' },
  lg: { wrap: 'h-16 w-16', logo: 'h-8 w-8', ring: 'border-[3px]' },
};

const LOGO_SRC = '/nao-logo.png';

/** NAO logo mark for AI surfaces (OneClick, job assistant). */
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
        <>
          <span className="brand-aura absolute -inset-1 rounded-full bg-indigo-400/35" />
          <span
            className={`brand-ring absolute -inset-0.5 rounded-full ${s.ring} border-fuchsia-400/30 border-t-cyan-300 border-r-violet-400`}
          />
        </>
      )}
      {celebrate && (
        <span className="absolute -right-0.5 -top-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-400 text-[10px] font-bold text-white shadow-md ring-2 ring-white">
          ✓
        </span>
      )}
      <div
        className={`relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 shadow-lg shadow-indigo-600/40 ring-2 ring-white ${
          thinking ? 'brand-breathe' : celebrate ? 'brand-pop' : ''
        }`}
      >
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]" />
        <img
          src={LOGO_SRC}
          alt=""
          className={`relative ${s.logo} object-contain drop-shadow-md brightness-0 invert`}
        />
      </div>
      <span
        className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-white ${
          thinking
            ? 'brand-status-pulse bg-amber-300'
            : celebrate
              ? 'bg-emerald-400'
              : 'bg-emerald-300'
        }`}
      />
    </div>
  );
}
