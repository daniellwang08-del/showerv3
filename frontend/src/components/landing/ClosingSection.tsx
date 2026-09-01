import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { HERO_STATS, NAV_LINKS } from './landingData';
import { CLOSING_IMAGE } from './landingMedia';
import { Eyebrow, GhostCta, LANDING_CONTAINER, PrimaryCta } from './landingUi';

export function ClosingSection() {
  return (
    <>
      <section className="landing-section relative overflow-hidden py-24 sm:py-32">
        <img
          src={CLOSING_IMAGE}
          alt=""
          aria-hidden="true"
          className="landing-ken-burns absolute inset-0 h-full w-full object-cover opacity-30"
        />
        <span
          aria-hidden="true"
          className="landing-aurora pointer-events-none absolute left-1/2 top-0 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-indigo-500/30 blur-[120px]"
        />
        <div aria-hidden="true" className="landing-grid absolute inset-0 opacity-25" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#05070f] via-[#05070f]/80 to-[#05070f]" />

        <div className={`${LANDING_CONTAINER} relative`}>
          <div className="landing-reveal relative mx-auto max-w-5xl overflow-hidden rounded-[36px] border border-white/12 bg-gradient-to-b from-white/[0.1] to-white/[0.03] px-6 py-14 text-center backdrop-blur-2xl sm:px-16 sm:py-16">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-300/60 to-transparent"
            />
            <span aria-hidden="true" className="landing-cta-orbit pointer-events-none absolute -inset-20 rounded-full" />

            <Eyebrow>Start today</Eyebrow>
            <h2 className="mt-6 text-balance text-3xl font-black leading-[1.1] tracking-tight text-white sm:text-4xl lg:text-5xl">
              Your next application is already written
            </h2>
            <p className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-white/60 sm:text-lg">
              Create an account, add your profile once, and let the pipeline do the searching,
              scoring and writing. You keep the final click.
            </p>

            <dl className="mx-auto mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
              {HERO_STATS.map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-4"
                >
                  <dt className="text-2xl font-black tabular-nums text-white">{stat.value}</dt>
                  <dd className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-sky-200">
                    {stat.label}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <PrimaryCta to="/signup" className="landing-cta-pulse">
                Sign up free
                <ArrowRight size={16} strokeWidth={2.75} />
              </PrimaryCta>
              <GhostCta to="/login">I already have an account</GhostCta>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 bg-[#04060d]">
        <div className={`${LANDING_CONTAINER} flex flex-col gap-10 py-14 sm:flex-row sm:items-start sm:justify-between`}>
          <div>
            <Link to="/" className="flex items-center gap-2.5">
              <img src="/atomspace-logo.png" alt="" className="h-7 w-7 object-contain" />
              <span className="text-[15px] font-black tracking-tight text-white">Atomspace</span>
            </Link>
            <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-white/40">
              An AI workspace that sources, scores and prepares job applications end to end.
            </p>
          </div>

          <nav className="flex flex-wrap items-center gap-x-6 gap-y-3" aria-label="Footer">
            {NAV_LINKS.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                className="text-[13px] font-semibold text-white/45 transition hover:text-white"
              >
                {link.label}
              </a>
            ))}
            <Link
              to="/login"
              className="text-[13px] font-semibold text-white/45 transition hover:text-white"
            >
              Sign in
            </Link>
            <Link to="/signup" className="text-[13px] font-bold text-sky-300 transition hover:text-sky-200">
              Sign up
            </Link>
          </nav>
        </div>

        <div className={`${LANDING_CONTAINER} border-t border-white/5 py-6`}>
          <p className="text-[12px] font-semibold text-white/30">
            © {new Date().getFullYear()} Atomspace. All rights reserved.
          </p>
        </div>
      </footer>
    </>
  );
}
