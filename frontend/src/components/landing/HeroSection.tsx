import { ArrowRight, PlayCircle, Sparkles } from 'lucide-react';
import { HERO_STATS } from './landingData';
import { HERO_GIF, HERO_POSTER, HERO_VIDEO } from './landingMedia';
import {
  CinematicBackdrop,
  CountStat,
  HeadlineCycle,
  NetworkField,
  PointerGlow,
} from './landingMotion';
import { Eyebrow, GhostCta, PrimaryCta } from './landingUi';
import { ProductMock } from './ProductMock';

const HEADLINE_WORDS = ['Start closing them.', 'Start matching them.', 'Start filling them.', 'Start landing them.'];

export function HeroSection() {
  return (
    <section className="landing-hero relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <CinematicBackdrop video={HERO_VIDEO} poster={HERO_POSTER} gif={HERO_GIF} gifOpacity={0.14} />
      <NetworkField />
      <div aria-hidden="true" className="landing-grid absolute inset-0 opacity-[0.28]" />
      <span
        aria-hidden="true"
        className="landing-aurora pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded-full bg-sky-500/30 blur-[100px]"
      />
      <span
        aria-hidden="true"
        className="landing-aurora landing-aurora-delay pointer-events-none absolute -right-16 top-24 h-80 w-80 rounded-full bg-fuchsia-500/25 blur-[110px]"
      />
      <span
        aria-hidden="true"
        className="landing-aurora pointer-events-none absolute bottom-10 left-1/3 h-56 w-56 rounded-full bg-indigo-500/20 blur-[90px]"
        style={{ animationDelay: '-3s' }}
      />

      <PointerGlow>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 lg:grid-cols-2 lg:items-center">
            <div className="flex flex-col justify-center px-5 py-8 sm:px-8 lg:px-10 lg:py-8 xl:pl-16 xl:pr-8">
              <Eyebrow icon={<Sparkles size={12} strokeWidth={3} />}>
                AI job application workspace
              </Eyebrow>

              <h1 className="mt-5 max-w-xl text-4xl font-black leading-[1.05] tracking-tight text-white sm:text-5xl xl:text-[3.5rem]">
                <span className="block">Stop hunting jobs.</span>
                <HeadlineCycle words={HEADLINE_WORDS} />
              </h1>

              <p className="mt-5 max-w-lg text-pretty text-[15px] leading-relaxed text-white/70 sm:text-base xl:text-[17px]">
                Atomspace finds fresh roles across five job networks, reads the real posting from the
                hiring system, scores it against your profile, then writes the tailored résumé and
                cover letter. When you are ready to apply, it fills the form for you.
              </p>

              <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <PrimaryCta to="/signup" className="landing-cta-pulse">
                  Create your free account
                  <ArrowRight size={16} strokeWidth={2.75} />
                </PrimaryCta>
                <GhostCta to="/login">Sign in</GhostCta>
                <a
                  href="#how-it-works"
                  className="inline-flex items-center gap-2 px-2 py-3 text-sm font-bold text-white/60 transition hover:text-white"
                >
                  <PlayCircle size={17} strokeWidth={2.5} className="landing-play-pulse" />
                  See how it works
                </a>
              </div>

              <dl className="mt-8 grid max-w-xl grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-4">
                {HERO_STATS.map((stat) => (
                  <CountStat key={stat.label} value={stat.value} label={stat.label} hint={stat.hint} />
                ))}
              </dl>
            </div>

            <div className="relative mx-auto flex min-h-[28rem] w-full max-w-xl min-w-0 flex-col px-4 pb-6 sm:min-h-[32rem] sm:px-6 lg:mx-0 lg:h-[min(34rem,calc(100dvh-7rem))] lg:max-w-none lg:min-h-0 lg:py-6 lg:pl-4 lg:pr-8 xl:pr-12">
              <ProductMock />
            </div>
          </div>
        </div>
      </PointerGlow>
    </section>
  );
}
