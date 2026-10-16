import { useId } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';

/**
 * Home-page space backdrop: planetary rim, moon skin catching first light,
 * quiet satellites, and occasional falling stars. Decorative only.
 */
export function NaoSpaceHorizon({ className }: { className?: string }) {
  const reduceMotion = usePrefersReducedMotion();
  const uid = useId().replace(/:/g, '');

  return (
    <div aria-hidden className={cn('nao-horizon', !reduceMotion && 'nao-horizon--live', className)}>
      <div className="nao-space">
        <div className="nao-space__stars" />

        {!reduceMotion ? (
          <>
            <span className="nao-space__meteor nao-space__meteor--a" />
            <span className="nao-space__meteor nao-space__meteor--b" />
            <span className="nao-space__meteor nao-space__meteor--c" />
          </>
        ) : null}

        <div className="nao-space__moon-wrap">
          <svg className="nao-space__moon" viewBox="0 0 120 120" focusable="false">
            <defs>
              <radialGradient id={`${uid}-shade`} cx="38%" cy="42%" r="62%">
                <stop offset="0%" stopColor="#d8e4ff" stopOpacity="0.95" />
                <stop offset="42%" stopColor="#8aa6e8" stopOpacity="0.55" />
                <stop offset="72%" stopColor="#2a3a6e" stopOpacity="0.85" />
                <stop offset="100%" stopColor="#0b1024" stopOpacity="0.98" />
              </radialGradient>
              <linearGradient id={`${uid}-lit`} x1="18%" y1="20%" x2="88%" y2="86%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                <stop offset="28%" stopColor="#c9dbff" stopOpacity="0.72" />
                <stop offset="55%" stopColor="#6f9bff" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#6f9bff" stopOpacity="0" />
              </linearGradient>
              <radialGradient id={`${uid}-sun`} cx="78%" cy="22%" r="45%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                <stop offset="35%" stopColor="#bfd6ff" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#3d74ff" stopOpacity="0" />
              </radialGradient>
              <filter id={`${uid}-soft`} x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="1.2" />
              </filter>
            </defs>

            {/* Soft sun wash approaching the limb */}
            <circle cx="86" cy="28" r="34" fill={`url(#${uid}-sun)`} className="nao-space__sun-wash" />

            {/* Moon body: night side + lit skin */}
            <circle cx="52" cy="58" r="22" fill={`url(#${uid}-shade)`} />
            <ellipse
              cx="44"
              cy="52"
              rx="13.5"
              ry="20"
              fill={`url(#${uid}-lit)`}
              filter={`url(#${uid}-soft)`}
              className="nao-space__moon-skin"
            />
            {/* Subtle crater marks on the lit face */}
            <circle cx="40" cy="46" r="2.2" fill="#1a2748" opacity="0.22" />
            <circle cx="47" cy="58" r="1.5" fill="#1a2748" opacity="0.18" />
            <circle cx="38" cy="62" r="1.1" fill="#1a2748" opacity="0.16" />
          </svg>

          <div className="nao-space__orbit-tilt nao-space__orbit-tilt--near">
            <div
              className={cn(
                'nao-space__orbit-spin nao-space__orbit-spin--near',
                reduceMotion && 'nao-space__orbit-spin--static',
              )}
            >
              <span className="nao-space__sat nao-space__sat--a" />
            </div>
          </div>
          <div className="nao-space__orbit-tilt nao-space__orbit-tilt--far">
            <div
              className={cn(
                'nao-space__orbit-spin nao-space__orbit-spin--far',
                reduceMotion && 'nao-space__orbit-spin--static',
              )}
            >
              <span className="nao-space__sat nao-space__sat--b" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
