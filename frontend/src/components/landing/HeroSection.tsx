import { ArrowRight, PlayCircle, Sparkles } from 'lucide-react';
import { HERO_STATS } from './landingData';
import { BRAND_HORIZON } from './landingMedia';
import { CountStat, HeadlineCycle } from './landingMotion';
import { Eyebrow, GhostCta, PrimaryCta } from './landingUi';
import { ProductMock } from './ProductMock';

const HEADLINE_WORDS = ['Start closing them.', 'Start matching them.', 'Start filling them.', 'Start landing them.'];

/**
 * The horizon is pushed down so its arc (46% of the image) lands under the
 * copy: just above the product mock on stacked layouts, and between the copy
 * and the mock at about 56% height on the two-column layout.
 */
function HorizonBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="landing-horizon absolute inset-x-0 bottom-0 h-[56rem] lg:top-[10%] lg:h-auto lg:bottom-[-10%]"
        style={{
          maskImage: 'linear-gradient(to bottom, transparent, #000 22%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 22%)',
        }}
      >
        <img
          src={BRAND_HORIZON}
          alt=""
          decoding="async"
          fetchPriority="high"
          className="h-full w-full object-cover object-center"
        />
      </div>
      <div className="absolute inset-0 bg-[#04060F]/25" />
      <div className="absolute inset-y-0 left-0 hidden w-[62%] bg-gradient-to-r from-[#04060F]/85 via-[#04060F]/45 to-transparent lg:block" />
      <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#04060F] to-transparent" />
    </div>
  );
}

export function HeroSection() {
  return (
    <section className="landing-hero relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#04060F]">
      <HorizonBackdrop />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
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
              NAO finds fresh roles across five job networks, reads the real posting from the
              hiring system, scores it against your profile, then writes the tailored résumé and
              cover letter. When you are ready to apply, it fills the form for you.
            </p>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <PrimaryCta to="/signup">
                Create your free account
                <ArrowRight size={16} strokeWidth={2.75} />
              </PrimaryCta>
              <GhostCta to="/login">Sign in</GhostCta>
              <a
                href="#how-it-works"
                className="inline-flex items-center gap-2 px-2 py-3 text-sm font-bold text-white/70 transition hover:text-white"
              >
                <PlayCircle size={17} strokeWidth={2.5} />
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
    </section>
  );
}
