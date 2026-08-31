import { CAST } from './landingMedia';

/**
 * Atmospheric collage of working professionals. These are stock portraits,
 * not customers, and are not presented as reviews.
 *
 * Sits on the first screen under the hero so the opening fold is one
 * full-viewport composition rather than a short block floating in empty space.
 */
export function ProofStrip() {
  return (
    <section className="relative shrink-0 border-t border-white/5 py-5 sm:py-6">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 px-5 text-center">
        <div className="flex items-center -space-x-3">
          {CAST.map((person) => (
            <img
              key={person.src}
              src={person.src}
              alt=""
              className="h-10 w-10 rounded-full object-cover ring-2 ring-[#05070f] sm:h-11 sm:w-11"
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
