import { useEffect, useState } from 'react';
import { STEPS } from './landingData';
import { STEP_VISUALS } from './landingMedia';
import { LANDING_CONTAINER, SectionHeading, SectionShell, TonedImage } from './landingUi';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

export function HowItWorksSection() {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (reduced || paused) return;
    const id = window.setInterval(() => {
      setActive((current) => (current + 1) % STEPS.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, [reduced, paused]);

  const step = STEPS[active];
  const visual = STEP_VISUALS[active];

  return (
    <SectionShell id="how-it-works">
      <div className={LANDING_CONTAINER}>
        <div className="landing-reveal">
          <SectionHeading
            eyebrow="The pipeline"
            title={
              <>
                Five stages run for you.
                <br className="hidden sm:block" /> You only choose where to apply.
              </>
            }
            subtitle="Each stage hands clean work to the next, so a raw listing becomes a scored opportunity with finished documents before you ever look at it."
          />
        </div>

        <div
          className="landing-reveal mt-14"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <ol className="grid gap-2 sm:grid-cols-5">
            {STEPS.map((item, index) => {
              const selected = index === active;
              return (
                <li key={item.step}>
                  <button
                    type="button"
                    onClick={() => setActive(index)}
                    aria-pressed={selected}
                    className={`group relative flex w-full flex-col overflow-hidden rounded-2xl border px-3.5 py-3.5 text-left transition duration-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6F9BFF]/70 ${
                      selected
                        ? 'border-[#6F9BFF]/40 bg-[#3D74FF]/10'
                        : 'border-white/10 bg-[#070B1C] hover:border-white/20'
                    }`}
                  >
                    {selected ? (
                      <span
                        aria-hidden="true"
                        className={`landing-step-progress pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-[#6F9BFF] ${
                          paused ? '[animation-play-state:paused]' : ''
                        }`}
                      />
                    ) : null}
                    <span
                      className={`text-[11px] font-black tabular-nums tracking-[0.16em] ${
                        selected ? 'text-[#BFD6FF]' : 'text-white/50'
                      }`}
                    >
                      {item.step}
                    </span>
                    <span
                      className={`mt-1.5 text-[13px] font-black leading-snug ${
                        selected ? 'text-white' : 'text-white/65'
                      }`}
                    >
                      {item.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="mt-5 grid overflow-hidden rounded-[28px] border border-white/10 bg-[#070B1C] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className="flex flex-col justify-center p-7 sm:p-10">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#BFD6FF]">
                Stage {step.step}
              </p>
              <h3 className="mt-3 text-2xl font-black tracking-tight text-white sm:text-3xl">
                {step.title}
              </h3>
              <p className="mt-4 max-w-xl text-pretty text-[15px] leading-relaxed text-white/65">
                {step.body}
              </p>
              <p className="mt-6 text-[11px] font-bold uppercase tracking-[0.14em] text-white/55">
                {step.detail}
              </p>
            </div>

            {visual ? (
              <figure className="relative min-h-[16rem] overflow-hidden sm:min-h-[20rem]">
                <TonedImage key={visual.src} src={visual.src} className="absolute inset-0" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#070B1C] via-transparent to-transparent lg:bg-gradient-to-r" />
                <figcaption className="absolute bottom-5 left-5 rounded-full border border-white/15 bg-[#04060F]/80 px-3.5 py-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-white">
                  {visual.caption}
                </figcaption>
              </figure>
            ) : null}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
