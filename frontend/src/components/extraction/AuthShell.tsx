import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type IntroPhase = 'intro' | 'flash' | 'done';

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Shared chrome for the auth screens: the one-time cinematic video intro,
 * the still background, the right-aligned glass card with the flowing star
 * border, and the brand header. Only the form passed as `children` changes
 * between sign in and sign up, so the background never replays on switch.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<IntroPhase>(prefersReducedMotion ? 'done' : 'intro');
  const videoRef = useRef<HTMLVideoElement>(null);
  const finishedRef = useRef(prefersReducedMotion);

  const finishIntro = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setPhase('flash');
    window.setTimeout(() => setPhase('done'), 520);
  }, []);

  useEffect(() => {
    if (phase !== 'intro') return;
    const video = videoRef.current;
    const playPromise = video?.play?.();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => finishIntro());
    }
    const fallback = window.setTimeout(finishIntro, 12000);
    return () => window.clearTimeout(fallback);
  }, [phase, finishIntro]);

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration === 0) return;
    if (video.duration - video.currentTime <= 1) finishIntro();
  };

  return (
    <div className="app-surface relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-blue-100 via-blue-50 to-indigo-100 p-4 lg:justify-end lg:pr-[26vw]">
      {/* Final still background, revealed once the intro finishes */}
      <img
        src="/login-still.jpg"
        alt=""
        aria-hidden="true"
        className={`absolute inset-0 z-0 h-full w-full object-cover transition-opacity duration-1000 ease-out ${
          phase === 'done' ? 'opacity-100' : 'opacity-0'
        }`}
      />

      <video
        ref={videoRef}
        className={`absolute inset-0 z-0 h-full w-full object-cover transition-[filter,opacity] duration-700 ease-out motion-reduce:hidden ${
          phase === 'flash' ? 'brightness-[0.35] saturate-100' : 'brightness-100'
        } ${phase === 'done' ? 'opacity-0' : 'opacity-100'}`}
        autoPlay
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        onTimeUpdate={handleTimeUpdate}
        onEnded={finishIntro}
      >
        <source src="/login-bg.mp4" type="video/mp4" />
      </video>

      {/* Right-side scrim fades in with the card so the glass stays legible.
          Hardcoded dark hex (not slate-*) so the app's dark-mode palette remap
          can't invert this cinematic scrim into a light wash. */}
      <div
        className={`absolute inset-0 z-[1] bg-gradient-to-l from-[#05080f]/85 via-[#0b1220]/35 to-transparent transition-opacity duration-700 ease-out ${
          phase === 'done' ? 'opacity-100' : 'opacity-0'
        }`}
        aria-hidden="true"
      />

      {/* Smooth dark fade that bridges the video into the card reveal */}
      <div
        className={`pointer-events-none absolute inset-0 z-[2] bg-[#05080f] ${
          phase === 'flash'
            ? 'opacity-95 transition-opacity duration-500 ease-in'
            : 'opacity-0 transition-opacity duration-700 ease-out'
        }`}
        aria-hidden="true"
      />

      {/* Skip the intro for returning users */}
      {phase === 'intro' && (
        <button
          type="button"
          onClick={finishIntro}
          className="absolute bottom-5 right-5 z-20 rounded-full border border-white/40 bg-white/10 px-4 py-1.5 text-xs font-semibold text-white/90 backdrop-blur-md transition hover:bg-white/20"
        >
          Skip
        </button>
      )}

      <div
        className={`relative z-10 w-full max-w-md transition-all duration-700 ease-out ${
          phase === 'done'
            ? 'translate-y-0 scale-100 opacity-100 blur-0'
            : 'pointer-events-none translate-y-4 scale-95 opacity-0 blur-sm'
        }`}
      >
        {/* Ambient glow behind the glass for a brilliant edge */}
        <div
          className="pointer-events-none absolute -inset-px -z-10 rounded-[28px] bg-gradient-to-br from-sky-400/40 via-indigo-500/30 to-fuchsia-500/30 opacity-70 blur-2xl"
          aria-hidden="true"
        />

        <div className="relative overflow-hidden rounded-3xl border border-white/25 bg-white/10 p-8 shadow-[0_20px_60px_-15px_rgba(2,6,23,0.7)] ring-1 ring-inset ring-white/15 backdrop-blur-2xl">
          {/* Glossy top sheen */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/25 to-transparent"
            aria-hidden="true"
          />

          <div className="relative">
            <div className="mb-8 text-center">
              <div className="relative mx-auto mb-3 w-fit">
                <div className="absolute inset-0 -z-10 rounded-full bg-sky-400/30 blur-2xl" aria-hidden="true" />
                <img
                  src="/atomspace-logo.png"
                  alt="Atomspace"
                  className="h-16 w-auto object-contain drop-shadow-[0_4px_18px_rgba(56,189,248,0.45)]"
                />
              </div>
              <h1 className="bg-gradient-to-r from-white via-blue-50 to-sky-200 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent drop-shadow-[0_2px_10px_rgba(56,189,248,0.45)]">
                Atomspace
              </h1>
              <p className="mt-2 text-sm font-semibold text-blue-50">Your AI job application workspace</p>
            </div>

            {children}
          </div>
        </div>

        {/* Bright stars flowing along the modal border */}
        <div className="modal-star-border pointer-events-none absolute inset-0 rounded-3xl" aria-hidden="true" />
      </div>
    </div>
  );
}
