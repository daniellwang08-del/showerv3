import type { ReactNode } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { usePublicViewport } from '../../hooks/usePublicViewport';
import { LandingHeader } from '../landing/LandingHeader';
import { HERO_GIF, HERO_POSTER, HERO_VIDEO } from '../landing/landingMedia';
import { CinematicBackdrop, NetworkField } from '../landing/landingMotion';
import { Eyebrow, LANDING_CONTAINER } from '../landing/landingUi';

type AuthMode = 'login' | 'signup';

const PROOFS = [
  {
    icon: Sparkles,
    title: 'Match, then tailor',
    detail: 'Score every role against your profile before the résumé is written.',
  },
  {
    icon: FileText,
    title: 'Documents ready to send',
    detail: 'Tailored résumé and cover letter land in your workspace, not a chat thread.',
  },
  {
    icon: Wand2,
    title: 'You keep the final click',
    detail: 'Autofill fills ATS fields. You review and submit.',
  },
] as const;

/**
 * Public auth chrome: same landing header + cinematic surface, then a split
 * composition (brand story · interactive form). The form panel is the only
 * “card” — it exists so fields stay a clear interaction target.
 */
export function AuthShell({
  children,
  mode,
  onModeChange,
}: {
  children: ReactNode;
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
}) {
  usePublicViewport('landing-theme');

  const isLogin = mode === 'login';

  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-hidden bg-[#05070f] text-white antialiased">
      <LandingHeader />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <CinematicBackdrop video={HERO_VIDEO} poster={HERO_POSTER} gif={HERO_GIF} gifOpacity={0.1} />
        <NetworkField />
        <div aria-hidden="true" className="landing-grid absolute inset-0 opacity-[0.22]" />
        <span
          aria-hidden="true"
          className="landing-aurora pointer-events-none absolute -left-24 top-16 h-72 w-72 rounded-full bg-sky-500/25 blur-[100px]"
        />
        <span
          aria-hidden="true"
          className="landing-aurora landing-aurora-delay pointer-events-none absolute -right-20 bottom-10 h-80 w-80 rounded-full bg-indigo-500/20 blur-[110px]"
        />

        <div
          className={`${LANDING_CONTAINER} relative z-10 grid flex-1 items-center gap-10 py-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(20rem,26rem)] lg:gap-14 lg:py-14 xl:gap-20`}
        >
          <div className="max-w-xl">
            <Eyebrow icon={<Sparkles size={12} strokeWidth={3} />}>
              {isLogin ? 'Welcome back' : 'Start free'}
            </Eyebrow>

            <h1 className="mt-5 text-4xl font-black leading-[1.05] tracking-tight text-white sm:text-5xl xl:text-[3.35rem]">
              {isLogin ? (
                <>
                  <span className="block">Your workspace</span>
                  <span className="block text-white/55">is waiting.</span>
                </>
              ) : (
                <>
                  <span className="block">Stop hunting jobs.</span>
                  <span className="block text-white/55">Start matching them.</span>
                </>
              )}
            </h1>

            <p className="mt-5 max-w-md text-pretty text-[15px] leading-relaxed text-white/65 sm:text-base">
              {isLogin
                ? 'Sign in to pick up matches, tailored documents, and autofill — the same Atomspace you left, ready on this device.'
                : 'Create an account to sync five job networks, score roles against your profile, and open applications with the form already filled.'}
            </p>

            <ul className="mt-8 hidden space-y-4 sm:block">
              {PROOFS.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.title} className="flex gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-sky-300/25 bg-sky-400/10 text-sky-300">
                      <Icon size={16} strokeWidth={2.5} />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-white">{item.title}</p>
                      <p className="mt-0.5 text-sm leading-snug text-white/50">{item.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="relative mx-auto w-full max-w-md lg:mx-0 lg:justify-self-end">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-6 rounded-[36px] bg-gradient-to-br from-sky-500/25 via-blue-500/15 to-indigo-500/20 opacity-90 blur-3xl"
            />

            <div className="relative overflow-hidden rounded-[28px] border border-white/12 bg-[#080d1c]/88 p-5 shadow-[0_40px_120px_-48px_rgba(2,6,23,0.95)] ring-1 ring-inset ring-white/10 backdrop-blur-2xl sm:p-7">
              <div className="relative">
                <div
                  className="mb-6 grid grid-cols-2 gap-1 rounded-full border border-white/12 bg-white/[0.04] p-1"
                  role="tablist"
                  aria-label="Account"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isLogin}
                    onClick={() => onModeChange('login')}
                    className={`rounded-full px-3 py-2.5 text-sm font-bold transition ${
                      isLogin
                        ? 'bg-[#f8fafc] text-[#05070f] shadow-sm'
                        : 'text-white/55 hover:text-white'
                    }`}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={!isLogin}
                    onClick={() => onModeChange('signup')}
                    className={`rounded-full px-3 py-2.5 text-sm font-bold transition ${
                      !isLogin
                        ? 'bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 text-white shadow-[0_10px_28px_-12px_rgba(37,99,235,0.9)]'
                        : 'text-white/55 hover:text-white'
                    }`}
                  >
                    Sign up
                  </button>
                </div>

                <div className="mb-5">
                  <h2 className="text-xl font-black tracking-tight text-white sm:text-2xl">
                    {isLogin ? 'Sign in to Atomspace' : 'Create your free account'}
                  </h2>
                  <p className="mt-1.5 text-sm text-white/50">
                    {isLogin
                      ? 'Use the email and password for your workspace.'
                      : 'No credit card. You can start matching in minutes.'}
                  </p>
                </div>

                {children}

                <p className="mt-6 flex items-start gap-2 text-[11px] leading-relaxed text-white/35">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-400/80" />
                  <span>
                    By continuing you agree to use Atomspace for your own applications. Autofill never
                    submits without you.
                    <span className="mt-1 flex items-center gap-1 text-white/45">
                      Prefer the tour first?
                      <a
                        href="/#how-it-works"
                        className="inline-flex items-center gap-0.5 font-semibold text-sky-300 transition hover:text-sky-200"
                      >
                        How it works
                        <ArrowRight size={12} strokeWidth={2.75} />
                      </a>
                    </span>
                  </span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
