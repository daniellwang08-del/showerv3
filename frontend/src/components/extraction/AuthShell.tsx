import type { ReactNode } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { NaoWordmark } from '@/components/brand/NaoLogo';
import { usePublicViewport } from '../../hooks/usePublicViewport';
import { LandingHeader } from '../landing/LandingHeader';
import { Eyebrow, LANDING_CONTAINER } from '../landing/landingUi';

type AuthMode = 'login' | 'signup';

const HORIZON_SRC = '/brand/nao-horizon.jpg';

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

const tabClass = (active: boolean) =>
  `rounded-full px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6F9BFF]/70 ${
    active ? 'bg-white text-[#04060F] shadow-sm' : 'text-white/60 hover:text-white'
  }`;

/** Landing header over the NAO horizon key art; shared by every public auth screen. */
export function AuthBackdrop({ children }: { children: ReactNode }) {
  usePublicViewport('landing-theme');

  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-hidden bg-[#04060F] text-white antialiased">
      <LandingHeader />

      <div className="relative isolate flex min-h-0 flex-1 flex-col">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <img
            src={HORIZON_SRC}
            alt=""
            className="h-full w-full object-cover object-[50%_35%] opacity-90"
          />
          <div className="absolute inset-0 bg-[#04060F]/45" />
          <div className="absolute inset-0 bg-gradient-to-b from-[#04060F]/70 via-transparent to-[#04060F]" />
          <div className="absolute inset-0 hidden bg-gradient-to-r from-[#04060F]/85 via-[#04060F]/30 to-transparent lg:block" />
        </div>

        {children}
      </div>
    </div>
  );
}

/**
 * Public auth chrome: the landing header over the NAO horizon key art, then a
 * split composition (brand story, interactive form). The form panel is the only
 * card, it exists so fields stay a clear interaction target.
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
  const isLogin = mode === 'login';

  return (
    <AuthBackdrop>
        <div
          className={`${LANDING_CONTAINER} grid flex-1 items-center gap-10 py-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(20rem,26rem)] lg:gap-14 lg:py-16 xl:gap-20`}
        >
          <div className="max-w-xl">
            <NaoWordmark className="mb-8 hidden h-9 text-white lg:block" />

            <Eyebrow icon={<Sparkles size={12} strokeWidth={3} />}>
              {isLogin ? 'Welcome back' : 'Start free'}
            </Eyebrow>

            <h1 className="mt-5 text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl xl:text-[3.35rem]">
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

            <p className="mt-5 max-w-md text-pretty text-[15px] leading-relaxed text-white/70 sm:text-base">
              {isLogin
                ? 'Sign in to pick up matches, tailored documents, and autofill, the same NAO you left, ready on this device.'
                : 'Create an account to sync five job networks, score roles against your profile, and open applications with the form already filled.'}
            </p>

            <ul className="mt-8 hidden space-y-4 sm:block">
              {PROOFS.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.title} className="flex gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#6F9BFF]/25 bg-[#3D74FF]/10 text-[#9DB9FF]">
                      <Icon size={16} strokeWidth={2.25} />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-white">{item.title}</p>
                      <p className="mt-0.5 text-sm leading-snug text-white/55">{item.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="mx-auto w-full max-w-md lg:mx-0 lg:justify-self-end">
            <div className="rounded-2xl border border-white/10 bg-[#070B1C]/95 p-5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.95)] sm:p-7">
              <div
                className="mb-6 grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1"
                role="tablist"
                aria-label="Account"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isLogin}
                  onClick={() => onModeChange('login')}
                  className={tabClass(isLogin)}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isLogin}
                  onClick={() => onModeChange('signup')}
                  className={tabClass(!isLogin)}
                >
                  Sign up
                </button>
              </div>

              <div className="mb-5">
                <h2 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
                  {isLogin ? 'Sign in to NAO' : 'Create your free account'}
                </h2>
                <p className="mt-1.5 text-sm text-white/60">
                  {isLogin
                    ? 'Use the email and password for your workspace.'
                    : 'No credit card. An admin approves new accounts before the workspace opens.'}
                </p>
              </div>

              {children}

              <p className="mt-6 flex items-start gap-2 border-t border-white/10 pt-5 text-xs leading-relaxed text-white/50">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[#6F9BFF]" />
                <span>
                  By continuing you agree to use NAO for your own applications. Autofill never
                  submits without you.
                  <span className="mt-1 flex items-center gap-1 text-white/60">
                    Prefer the tour first?
                    <a
                      href="/#how-it-works"
                      className="inline-flex items-center gap-0.5 rounded font-semibold text-[#9DB9FF] transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6F9BFF]/70"
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
    </AuthBackdrop>
  );
}
