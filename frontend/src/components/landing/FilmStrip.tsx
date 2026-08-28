import { FILM_STILLS } from './landingMedia';

export function FilmStrip() {
  return (
    <section className="relative border-y border-white/10 bg-[#070b16] py-8 sm:py-10" aria-label="The workflow on film">
      <p className="mb-5 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-white/35">
        From listing to submitted application
      </p>
      <div className="landing-marquee-mask overflow-hidden">
        <div className="landing-marquee landing-marquee-fast flex w-max">
          {[0, 1].map((copy) => (
            <div key={copy} className="flex gap-4 pr-4" aria-hidden={copy === 1 ? 'true' : undefined}>
              {FILM_STILLS.map((frame) => (
                <figure
                  key={`${copy}-${frame.label}`}
                  className="relative h-36 w-56 shrink-0 overflow-hidden rounded-2xl border border-white/10 sm:h-44 sm:w-72"
                >
                  <img
                    src={frame.src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                  <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2.5 pt-8 text-[11px] font-black uppercase tracking-[0.16em] text-white">
                    {frame.label}
                  </figcaption>
                </figure>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
