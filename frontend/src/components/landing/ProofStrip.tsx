import { CAST } from './landingMedia';

/**
 * Atmospheric collage of working professionals. These are stock portraits,
 * not customers, and are not presented as reviews.
 */
export function ProofStrip() {
  return (
    <section className="relative py-10 sm:py-12">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-5 px-5 text-center">
        <div className="flex items-center -space-x-3">
          {CAST.map((person) => (
            <img
              key={person.src}
              src={person.src}
              alt=""
              className="h-11 w-11 rounded-full object-cover ring-2 ring-[#05070f] sm:h-12 sm:w-12"
            />
          ))}
          <span className="ml-4 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-sky-200">
            You stay in the loop
          </span>
        </div>
        <p className="max-w-2xl text-pretty text-base font-semibold leading-relaxed text-white/70 sm:text-lg">
          Sourcing, scoring, documents and autofill are one system — so a raw
          listing becomes a finished application without you switching tools.
        </p>
      </div>
    </section>
  );
}
