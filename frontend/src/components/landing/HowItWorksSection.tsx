import { STEPS } from './landingData';
import { STEP_VISUALS } from './landingMedia';
import { LANDING_CONTAINER, SectionHeading, SectionShell } from './landingUi';

export function HowItWorksSection() {
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

        <ol className="relative mt-16 space-y-5">
          <span
            aria-hidden="true"
            className="landing-pipeline-line pointer-events-none absolute left-[1.15rem] top-6 hidden h-[calc(100%-3rem)] w-px sm:left-[2.35rem] sm:block"
          />
          {STEPS.map((step, index) => {
            const visual = STEP_VISUALS[index];
            return (
              <li
                key={step.step}
                className="landing-reveal"
                style={{ transitionDelay: `${index * 70}ms` }}
              >
                <div className="group relative grid gap-5 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-xl transition duration-500 hover:border-sky-300/25 hover:bg-white/[0.07] sm:p-8 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,16rem)]">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-sky-300/50 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                  />

                  <div className="flex items-center gap-4 sm:w-28 sm:flex-col sm:items-start">
                    <span className="landing-step-num text-3xl font-black tabular-nums text-white/15 transition-colors duration-500 group-hover:text-sky-300/70 sm:text-4xl">
                      {step.step}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-xl font-black tracking-tight text-white sm:text-2xl">
                      {step.title}
                    </h3>
                    <p className="mt-3 max-w-3xl text-pretty text-[15px] leading-relaxed text-white/60">
                      {step.body}
                    </p>
                    <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.14em] text-sky-200/70">
                      {step.detail}
                    </p>
                  </div>

                  {visual ? (
                    <figure className="relative hidden h-36 overflow-hidden rounded-2xl border border-white/10 lg:block">
                      <img
                        src={visual.src}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="landing-ken-burns h-full w-full object-cover opacity-80 transition duration-700 group-hover:scale-105 group-hover:opacity-100"
                      />
                      <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2.5 pt-8 text-[10px] font-black uppercase tracking-[0.14em] text-white">
                        {visual.caption}
                      </figcaption>
                    </figure>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </SectionShell>
  );
}
