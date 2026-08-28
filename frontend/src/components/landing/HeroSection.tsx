import { ArrowRight, PlayCircle, Sparkles } from 'lucide-react';
import { HERO_STATS, JOB_SOURCES } from './landingData';
import { HERO_GIF, HERO_POSTER, HERO_VIDEO } from './landingMedia';
import {
  CinematicBackdrop,
  CountStat,
  FloatingCast,
  HeadlineCycle,
  LiveToasts,
  NetworkField,
  PointerGlow,
} from './landingMotion';
import { Eyebrow, GhostCta, LANDING_CONTAINER, PrimaryCta } from './landingUi';
import { ProductMock } from './ProductMock';

const HEADLINE_WORDS = ['Start closing them.', 'Start matching them.', 'Start filling them.', 'Start landing them.'];

export function HeroSection() {
  return (
    <section className="relative overflow-hidden pt-32 pb-16 sm:pt-40 sm:pb-24">
      <CinematicBackdrop video={HERO_VIDEO} poster={HERO_POSTER} gif={HERO_GIF} gifOpacity={0.14} />
      <NetworkField />
      <div aria-hidden="true" className="landing-grid absolute inset-0 opacity-[0.28]" />
      <span
        aria-hidden="true"
        className="landing-aurora pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded-full bg-sky-500/30 blur-[100px]"
      />
      <span
        aria-hidden="true"
        className="landing-aurora landing-aurora-delay pointer-events-none absolute -right-16 top-40 h-80 w-80 rounded-full bg-fuchsia-500/25 blur-[110px]"
      />
      <span
        aria-hidden="true"
        className="landing-aurora pointer-events-none absolute bottom-10 left-1/3 h-56 w-56 rounded-full bg-indigo-500/20 blur-[90px]"
        style={{ animationDelay: '-3s' }}
      />

      <PointerGlow>
        <div className={`${LANDING_CONTAINER} relative`}>
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
            <div className="max-w-xl">
              <Eyebrow icon={<Sparkles size={12} strokeWidth={3} />}>
                AI job application workspace
              </Eyebrow>

              <h1 className="mt-6 text-balance text-4xl font-black leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
                Stop hunting jobs.
                <HeadlineCycle words={HEADLINE_WORDS} />
              </h1>

              <p className="mt-6 text-pretty text-lg leading-relaxed text-white/70">
                Atomspace finds fresh roles across five job networks, reads the real posting from the
                hiring system, scores it against your profile, then writes the tailored résumé and
                cover letter. When you are ready to apply, it fills the form for you.
              </p>

              <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
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

              <dl className="mt-12 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
                {HERO_STATS.map((stat) => (
                  <CountStat key={stat.label} value={stat.value} label={stat.label} hint={stat.hint} />
                ))}
              </dl>
            </div>

            <div className="relative lg:pl-4">
              <FloatingCast />
              <LiveToasts />
              <div className="landing-tilt relative z-10">
                <ProductMock />
              </div>
            </div>
          </div>

          <div className="mt-20 sm:mt-24">
            <p className="text-center text-[11px] font-bold uppercase tracking-[0.22em] text-white/35">
              Sourcing from
            </p>
            <div className="landing-marquee-mask mt-5 overflow-hidden">
              <div className="landing-marquee flex w-max">
                {[0, 1].map((copy) => (
                  <div
                    key={copy}
                    className="flex items-center gap-10 pr-10"
                    aria-hidden={copy === 1 ? 'true' : undefined}
                  >
                    {JOB_SOURCES.map((source) => (
                      <span
                        key={source}
                        className="whitespace-nowrap text-lg font-black tracking-tight text-white/30 sm:text-xl"
                      >
                        {source}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </PointerGlow>
    </section>
  );
}
