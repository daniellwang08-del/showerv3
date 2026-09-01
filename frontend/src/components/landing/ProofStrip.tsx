import { JOB_SOURCES } from './landingData';
import { CAST } from './landingMedia';

/**
 * Trust band that sits under the first full-screen fold: source names,
 * atmospheric portraits, and the one-system promise.
 *
 * Portraits are stock, not customers, and are not presented as reviews.
 */
export function ProofStrip() {
  return (
    <section className="relative overflow-hidden border-y border-white/8 bg-[#070b16]">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-300/40 to-transparent"
      />

      <div className="px-5 py-6 sm:px-8 sm:py-7">
        <p className="text-center text-[11px] font-bold uppercase tracking-[0.22em] text-white/35">
          Sourcing from
        </p>
        <div className="landing-marquee-mask mt-4 overflow-hidden">
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
                    className="whitespace-nowrap text-lg font-black tracking-tight text-white/32 sm:text-xl"
                  >
                    {source}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 border-t border-white/6 px-5 py-7 text-center sm:py-8">
        <div className="flex items-center -space-x-3">
          {CAST.map((person) => (
            <img
              key={person.src}
              src={person.src}
              alt=""
              className="h-10 w-10 rounded-full object-cover ring-2 ring-[#070b16] sm:h-11 sm:w-11"
            />
          ))}
          <span className="ml-4 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-sky-200">
            You stay in the loop
          </span>
        </div>
        <p className="max-w-2xl text-pretty text-sm font-semibold leading-relaxed text-white/65 sm:text-base">
          Sourcing, scoring, documents and autofill are one system — so a raw
          listing becomes a finished application without you switching tools.
        </p>
      </div>
    </section>
  );
}
