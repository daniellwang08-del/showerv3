import { Check, Chrome, MousePointerClick } from 'lucide-react';
import { ATS_PLATFORMS, AUTOFILL_POINTS, INTEGRATIONS } from './landingData';
import { AutofillDemo } from './AutofillDemo';
import { AUTOFILL_POSTER, AUTOFILL_VIDEO, HERO_GIF } from './landingMedia';
import { Chip, Eyebrow, GlassCard, LANDING_CONTAINER, SectionShell } from './landingUi';

export function AutofillSection() {
  return (
    <SectionShell id="autofill">
      <div className={LANDING_CONTAINER}>
        <div className="grid gap-14 lg:grid-cols-2 lg:items-start lg:gap-16">
          <div className="landing-reveal">
            <Eyebrow icon={<Chrome size={12} strokeWidth={3} />}>Chrome side panel</Eyebrow>
            <h2 className="mt-5 text-balance text-3xl font-black leading-[1.1] tracking-tight text-white sm:text-4xl lg:text-[2.75rem]">
              The application form fills itself
            </h2>
            <p className="mt-4 text-pretty text-base leading-relaxed text-white/60 sm:text-lg">
              Open the panel on any application page. It knows which hiring system you are on,
              which job you are applying to, and which documents belong to it — then it types
              everything so you can review and submit.
            </p>

            <div className="relative mt-8 overflow-hidden rounded-3xl border border-white/10">
              <img
                src={AUTOFILL_POSTER}
                alt=""
                className="h-56 w-full object-cover sm:h-64 motion-reduce:block hidden"
              />
              <video
                className="h-56 w-full object-cover motion-reduce:hidden sm:h-64"
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                poster={AUTOFILL_POSTER}
                aria-hidden="true"
              >
                <source src={AUTOFILL_VIDEO} type="video/mp4" />
              </video>
              <img
                src={HERO_GIF}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full object-cover mix-blend-screen opacity-[0.14] motion-reduce:hidden"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#05070f] via-[#05070f]/35 to-transparent" />
              <p className="absolute bottom-4 left-5 text-[12px] font-black uppercase tracking-[0.16em] text-white">
                You watch. You submit.
              </p>
            </div>

            <ul className="mt-10 space-y-6">
              {AUTOFILL_POINTS.map((point) => (
                <li key={point.title} className="flex gap-4">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-400/10 text-emerald-300">
                    <Check size={13} strokeWidth={3.5} />
                  </span>
                  <div>
                    <h3 className="text-[15px] font-black text-white">{point.title}</h3>
                    <p className="mt-1.5 text-[14px] leading-relaxed text-white/55">{point.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="landing-reveal" style={{ transitionDelay: '90ms' }}>
            <GlassCard className="p-7 sm:p-8">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-lg shadow-indigo-900/50">
                  <MousePointerClick size={18} strokeWidth={2.5} />
                </span>
                <div>
                  <p className="text-sm font-black text-white">Watch it type</p>
                  <p className="text-[12px] font-semibold text-white/45">
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
                <span className="inline-flex items-center rounded-full border border-dashed border-white/20 bg-transparent px-3.5 py-1.5 text-[13px] font-semibold text-white/45">
                  + generic fallback
                </span>
              </div>

              <div className="mt-8 border-t border-white/10 pt-7">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/40">
                  Send the results where you work
                </p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {INTEGRATIONS.map((integration) => (
                    <div
                      key={integration.name}
                      className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 transition duration-300 hover:border-white/20 hover:bg-white/[0.07]"
                    >
                      <img
                        src={integration.icon}
                        alt=""
                        aria-hidden="true"
                        className="h-6 w-6 object-contain"
                      />
                      <p className="mt-3 text-[13px] font-black text-white">{integration.name}</p>
                      <p className="mt-1 text-[12px] leading-snug text-white/50">
                        {integration.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </GlassCard>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
