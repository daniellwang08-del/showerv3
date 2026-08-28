import { STEPS } from './landingData';
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

        <ol className="mt-16 space-y-4">
          {STEPS.map((step, index) => (
            <li
              key={step.step}
              className="landing-reveal"
              style={{ transitionDelay: `${index * 70}ms` }}
            >
              <div className="group relative grid gap-5 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-xl transition duration-500 hover:border-sky-300/25 hover:bg-white/[0.07] sm:grid-cols-[auto_minmax(0,1fr)] sm:p-8">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 w-px bg-gradient-to-b from-transparent via-sky-300/50 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                />

                <div className="flex items-center gap-4 sm:w-28 sm:flex-col sm:items-start">
                  <span className="text-3xl font-black tabular-nums text-white/15 transition-colors duration-500 group-hover:text-sky-300/70 sm:text-4xl">
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
              </div>
            </li>
          ))}
        </ol>
      </div>
    </SectionShell>
  );
}
