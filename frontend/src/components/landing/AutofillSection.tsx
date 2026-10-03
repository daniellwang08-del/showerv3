import { Check, Chrome, MousePointerClick } from 'lucide-react';
import { ATS_PLATFORMS, AUTOFILL_POINTS, INTEGRATIONS } from './landingData';
import { AutofillDemo } from './AutofillDemo';
import { AUTOFILL_POSTER } from './landingMedia';
import { Chip, Eyebrow, ICON_TILE, LANDING_CONTAINER, SectionShell, SurfaceCard } from './landingUi';

export function AutofillSection() {
  return (
    <SectionShell id="autofill">
      <div className={LANDING_CONTAINER}>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-start lg:gap-16">
          <div className="landing-reveal">
            <Eyebrow icon={<Chrome size={12} strokeWidth={3} />}>Chrome side panel</Eyebrow>
            <h2 className="mt-5 text-balance text-3xl font-black leading-[1.1] tracking-tight text-white sm:text-4xl lg:text-[2.75rem]">
              The application form fills itself
            </h2>
            <p className="mt-4 text-pretty text-base leading-relaxed text-white/65 sm:text-lg">
              Open the panel on any application page. It knows which hiring system you are on,
              which job you are applying to, and which documents belong to it, then it types
              everything so you can review and submit.
            </p>

            <div className="relative mt-8 overflow-hidden rounded-[28px] border border-white/10 bg-[#070B1C] shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
              <div className="flex items-center gap-2 border-b border-white/8 px-4 py-2.5">
                <span className="h-2 w-2 rounded-full bg-white/15" />
                <span className="h-2 w-2 rounded-full bg-white/15" />
                <span className="h-2 w-2 rounded-full bg-white/15" />
                <span className="ml-2 text-[11px] font-bold text-white/50">workday · application</span>
              </div>
              <div className="relative h-56 sm:h-72" aria-hidden="true">
                <img src={AUTOFILL_POSTER} alt="" className="h-full w-full object-cover grayscale" />
                <span className="absolute inset-0 bg-[#3D74FF]/45 mix-blend-color" />
                <span className="absolute inset-0 bg-[#04060F]/40" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#04060F] via-[#04060F]/30 to-transparent" />
              </div>
              <p className="absolute bottom-4 left-5 rounded-full border border-white/15 bg-[#04060F]/80 px-3.5 py-1.5 text-[12px] font-black uppercase tracking-[0.16em] text-white">
                You watch. You submit.
              </p>
            </div>

            <ul className="mt-10 grid gap-5 sm:grid-cols-2">
              {AUTOFILL_POINTS.map((point) => (
                <li key={point.title} className="flex gap-3.5">
                  <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${ICON_TILE}`}>
                    <Check size={13} strokeWidth={3.5} />
                  </span>
                  <div>
                    <h3 className="text-[15px] font-black text-white">{point.title}</h3>
                    <p className="mt-1.5 text-[14px] leading-relaxed text-white/65">{point.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="landing-reveal lg:sticky lg:top-28" style={{ transitionDelay: '90ms' }}>
            <SurfaceCard className="p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#2C5BF5] text-white">
                  <MousePointerClick size={18} strokeWidth={2.5} />
                </span>
                <div>
                  <p className="text-sm font-black text-white">Watch it type</p>
                  <p className="text-[12px] font-semibold text-white/55">
                    Illustrative Workday pass · 14 platforms in production
                  </p>
                </div>
              </div>

              <div className="mt-6">
                <AutofillDemo />
              </div>

              <div className="mt-7 flex flex-wrap gap-2">
                {ATS_PLATFORMS.map((platform) => (
                  <Chip key={platform}>{platform}</Chip>
                ))}
                <span className="inline-flex items-center rounded-full border border-dashed border-white/20 bg-transparent px-3.5 py-1.5 text-[13px] font-semibold text-white/55">
                  + generic fallback
                </span>
              </div>

              <div className="mt-8 border-t border-white/10 pt-7">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/50">
                  Send the results where you work
                </p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {INTEGRATIONS.map((integration) => (
                    <div
                      key={integration.name}
                      className="rounded-2xl border border-white/10 bg-[#0A1030] p-4 transition duration-300 hover:border-white/20"
                    >
                      <img
                        src={integration.icon}
                        alt=""
                        aria-hidden="true"
                        className="h-6 w-6 object-contain"
                      />
                      <p className="mt-3 text-[13px] font-black text-white">{integration.name}</p>
                      <p className="mt-1 text-[12px] leading-snug text-white/60">
                        {integration.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </SurfaceCard>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
