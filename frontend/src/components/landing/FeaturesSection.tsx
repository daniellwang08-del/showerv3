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
import { ICON_TILE, LANDING_CONTAINER, SectionHeading, SectionShell, SurfaceCard } from './landingUi';

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
    <SectionShell id="features" className="overflow-hidden border-y border-white/8 bg-[#070B1C]">
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
            const span = BENTO[index] ?? '';
            const featured = Boolean(span);
            const wide = index === 8;
            return (
              <div
                key={feature.title}
                className={`landing-reveal h-full ${span}`.trim()}
                style={{ transitionDelay: `${(index % 3) * 80}ms` }}
              >
                <SurfaceCard raised className={`h-full ${featured ? 'sm:p-8' : ''}`.trim()}>
                  <div className={wide ? 'lg:flex lg:items-center lg:gap-8' : undefined}>
                    <span
                      className={`inline-flex shrink-0 items-center justify-center rounded-2xl ${ICON_TILE} ${
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
                        className={`mt-2.5 leading-relaxed text-white/65 ${
                          featured ? 'max-w-3xl text-[15px]' : 'text-[14px]'
                        }`}
                      >
                        {feature.body}
                      </p>
                    </div>
                  </div>
                </SurfaceCard>
              </div>
            );
          })}
        </div>
      </div>
    </SectionShell>
  );
}
