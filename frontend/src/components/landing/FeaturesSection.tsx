import {
  Activity,
  BarChart3,
  Bot,
  LayoutTemplate,
  Plug,
  Radar,
  ShieldCheck,
  Target,
  Wand2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FEATURES, type Feature } from './landingData';
import { FEATURES_BAND } from './landingMedia';
import { ACCENTS, GlassCard, LANDING_CONTAINER, SectionHeading, SectionShell } from './landingUi';

const ICONS: Record<Feature['icon'], LucideIcon> = {
  radar: Radar,
  target: Target,
  layout: LayoutTemplate,
  wand: Wand2,
  activity: Activity,
  shield: ShieldCheck,
  bot: Bot,
  plug: Plug,
  chart: BarChart3,
};

const BENTO: Record<number, string> = {
  0: 'lg:col-span-2',
  8: 'lg:col-span-3',
};

export function FeaturesSection() {
  return (
    <SectionShell id="features" className="overflow-hidden bg-[#070b16]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 opacity-30"
        style={{
          backgroundImage: `url(${FEATURES_BAND})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          maskImage: 'linear-gradient(to bottom, black, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)',
        }}
      />
      <div className={`${LANDING_CONTAINER} relative`}>
        <div className="landing-reveal">
          <SectionHeading
            eyebrow="The platform"
            title="Everything a serious job search needs, in one workspace"
            subtitle="Sourcing, analysis, document generation, autofill and reporting are one system, so nothing is copied between tools and nothing gets lost between them."
          />
        </div>

        <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, index) => {
            const Icon = ICONS[feature.icon];
            const accent = ACCENTS[feature.accent];
            const span = BENTO[index] ?? '';
            const featured = Boolean(span);
            const wide = index === 8;
            return (
              <div
                key={feature.title}
                className={`landing-reveal h-full ${span}`.trim()}
                style={{ transitionDelay: `${(index % 3) * 80}ms` }}
              >
                <GlassCard
                  className={`h-full ${featured ? 'sm:p-8' : ''}`.trim()}
                  glow={accent.glow}
                >
                  <div className={wide ? 'lg:flex lg:items-center lg:gap-8' : undefined}>
                    <span
                      className={`inline-flex shrink-0 items-center justify-center rounded-2xl border ${accent.chip} ${accent.icon} ${
                        featured ? 'h-12 w-12' : 'h-11 w-11'
                      }`}
                    >
                      <Icon size={featured ? 21 : 19} strokeWidth={2.25} />
                    </span>
                    <div>
                      <h3
                        className={`mt-5 font-black tracking-tight text-white ${wide ? 'lg:mt-0' : ''} ${
                          featured ? 'text-xl sm:text-[22px]' : 'text-[17px]'
                        }`}
                      >
                        {feature.title}
                      </h3>
                      <p
                        className={`mt-2.5 leading-relaxed text-white/55 ${
                          featured ? 'max-w-3xl text-[15px]' : 'text-[14px]'
                        }`}
                      >
                        {feature.body}
                      </p>
                    </div>
                  </div>
                </GlassCard>
              </div>
            );
          })}
        </div>
      </div>
    </SectionShell>
  );
}
