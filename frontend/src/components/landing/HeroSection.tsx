import { ArrowRight, PlayCircle, Sparkles } from 'lucide-react';
import { HERO_STATS, JOB_SOURCES } from './landingData';
import { Eyebrow, GhostCta, LANDING_CONTAINER, PrimaryCta } from './landingUi';
import { ProductMock } from './ProductMock';

export function HeroSection() {
  return (
    <section className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-24">
      {/* Cinematic backdrop, reused from the sign-in screen so the public site
          and the product share one visual identity. */}
      <img
        src="/login-still.jpg"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover opacity-35"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-[#05070f]/70 via-[#05070f]/85 to-[#05070f]"
      />
      <div aria-hidden="true" className="landing-grid absolute inset-0 opacity-[0.35]" />
      <span
        aria-hidden="true"
        className="landing-aurora pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded-full bg-sky-500/25 blur-[100px]"
      />
      <span
        aria-hidden="true"
        className="landing-aurora landing-aurora-delay pointer-events-none absolute -right-16 top-40 h-80 w-80 rounded-full bg-fuchsia-500/20 blur-[110px]"
      />

      <div className={`${LANDING_CONTAINER} relative`}>
        <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
          <div className="max-w-xl">
            <Eyebrow icon={<Sparkles size={12} strokeWidth={3} />}>
              AI job application workspace
            </Eyebrow>

            <h1 className="mt-6 text-balance text-4xl font-black leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
              Stop hunting jobs.
              <span className="mt-1 block bg-gradient-to-r from-sky-300 via-blue-200 to-indigo-300 bg-clip-text text-transparent">
                Start closing them.
              </span>
            </h1>

            <p className="mt-6 text-pretty text-lg leading-relaxed text-white/65">
              Atomspace finds fresh roles across five job networks, reads the real posting from the
              hiring system, scores it against your profile, then writes the tailored résumé and
              cover letter. When you are ready to apply, it fills the form for you.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <PrimaryCta to="/signup">
                Create your free account
                <ArrowRight size={16} strokeWidth={2.75} />
              </PrimaryCta>
              <GhostCta to="/login">
                Sign in
              </GhostCta>
              <a
                href="#how-it-works"
                className="inline-flex items-center gap-2 px-2 py-3 text-sm font-bold text-white/60 transition hover:text-white"
              >
                <PlayCircle size={17} strokeWidth={2.5} />
                See how it works
              </a>
            </div>

            <dl className="mt-12 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
              {HERO_STATS.map((stat) => (
                <div key={stat.label}>
                  <dt className="text-2xl font-black tabular-nums text-white sm:text-3xl">
                    {stat.value}
                  </dt>
                  <dd className="mt-1 text-[13px] font-bold text-sky-200">{stat.label}</dd>
                  <dd className="text-[11px] font-semibold leading-snug text-white/40">
                    {stat.hint}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="relative lg:pl-4">
            <ProductMock />
          </div>
        </div>

        <div className="mt-20 sm:mt-24">
          <p className="text-center text-[11px] font-bold uppercase tracking-[0.22em] text-white/35">
            Sourcing from
          </p>
          <div className="landing-marquee-mask mt-5 overflow-hidden">
            {/* Two identical groups: shifting the track by exactly -50% keeps the
                loop seamless. The second group is decorative. */}
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
                      className="whitespace-nowrap text-lg font-black tracking-tight text-white/25 sm:text-xl"
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
    </section>
  );
}
