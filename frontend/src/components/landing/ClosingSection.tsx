import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { NaoWordmark } from '@/components/brand/NaoLogo';
import { HERO_STATS, NAV_LINKS } from './landingData';
import { BRAND_HORIZON } from './landingMedia';
import { Eyebrow, GhostCta, LANDING_CONTAINER, PrimaryCta } from './landingUi';

export function ClosingSection() {
  return (
    <>
      <section className="landing-section relative overflow-hidden bg-[#04060F] py-24 sm:py-32">
        <div className={`${LANDING_CONTAINER} relative`}>
          <div className="landing-reveal relative mx-auto max-w-5xl overflow-hidden rounded-[36px] border border-white/10 bg-[#070B1C] px-6 py-14 text-center sm:px-16 sm:py-16">
            {/* The horizon arc (46% of the image) sits at the card's bottom edge, echoing the hero. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-[50%] h-full"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent, #000 30%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 30%)',
              }}
            >
              <img
                src={BRAND_HORIZON}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover object-center opacity-80"
              />
            </div>

            <div className="relative">
              <Eyebrow>Start today</Eyebrow>
              <h2 className="mt-6 text-balance text-3xl font-black leading-[1.1] tracking-tight text-white sm:text-4xl lg:text-5xl">
                Your next application is already written
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-white/70 sm:text-lg">
                Create an account, add your profile once, and let the pipeline do the searching,
                scoring and writing. You keep the final click.
              </p>

              <dl className="mx-auto mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
                {HERO_STATS.map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-2xl border border-white/10 bg-[#0A1030]/90 px-3 py-4"
                  >
                    <dt className="text-2xl font-black tabular-nums text-white">{stat.value}</dt>
                    <dd className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#BFD6FF]">
                      {stat.label}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <PrimaryCta to="/signup">
                  Sign up free
                  <ArrowRight size={16} strokeWidth={2.75} />
                </PrimaryCta>
                <GhostCta to="/login" className="bg-[#04060F]/60">
                  I already have an account
                </GhostCta>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 bg-[#04060F]">
        <div className={`${LANDING_CONTAINER} flex flex-col gap-10 py-14 sm:flex-row sm:items-start sm:justify-between`}>
          <div>
            <Link to="/" className="inline-flex text-white" aria-label="NAO home">
              <NaoWordmark className="h-5 text-white" />
            </Link>
            <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-white/55">
              An AI workspace that sources, scores and prepares job applications end to end.
            </p>
          </div>

          <nav className="flex flex-wrap items-center gap-x-6 gap-y-3" aria-label="Footer">
            {NAV_LINKS.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                className="text-[13px] font-semibold text-white/60 transition hover:text-white"
              >
                {link.label}
              </a>
            ))}
            <Link
              to="/login"
              className="text-[13px] font-semibold text-white/60 transition hover:text-white"
            >
              Sign in
            </Link>
            <Link to="/signup" className="text-[13px] font-bold text-[#6F9BFF] transition hover:text-[#BFD6FF]">
              Sign up
            </Link>
          </nav>
        </div>

        <div className={`${LANDING_CONTAINER} border-t border-white/5 py-6`}>
          <p className="text-[12px] font-semibold text-white/50">
            © {new Date().getFullYear()} NAO. All rights reserved.
          </p>
        </div>
      </footer>
    </>
  );
}
