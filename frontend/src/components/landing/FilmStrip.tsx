import { FILM_STILLS } from './landingMedia';
import { TonedImage } from './landingUi';

export function FilmStrip() {
  return (
    <section className="relative border-b border-white/8 bg-[#04060F] py-10 sm:py-12" aria-label="The workflow on film">
      <p className="mb-6 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-white/50">
        From listing to submitted application
      </p>
      <div className="landing-marquee-mask overflow-hidden">
        <div className="landing-marquee landing-marquee-fast flex w-max hover:[animation-play-state:paused]">
          {[0, 1].map((copy) => (
            <div key={copy} className="flex gap-4 pr-4" aria-hidden={copy === 1 ? 'true' : undefined}>
              {FILM_STILLS.map((frame) => (
                <figure
                  key={`${copy}-${frame.label}`}
                  className="relative h-40 w-60 shrink-0 overflow-hidden rounded-2xl border border-white/10 sm:h-48 sm:w-80"
                >
                  <TonedImage src={frame.src} className="absolute inset-0" />
                  <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#04060F]/90 to-transparent px-4 pb-3 pt-10 text-[11px] font-black uppercase tracking-[0.16em] text-white">
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
