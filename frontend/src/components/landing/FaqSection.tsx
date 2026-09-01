import { useState } from 'react';
import { Plus } from 'lucide-react';
import { FAQS } from './landingData';
import { LANDING_CONTAINER, SectionHeading, SectionShell } from './landingUi';

export function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <SectionShell id="faq" className="bg-[#070b16]">
      <div className={LANDING_CONTAINER}>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:items-start lg:gap-16">
          <div className="landing-reveal lg:sticky lg:top-28">
            <SectionHeading
              align="left"
              eyebrow="Questions"
              title="What people ask before signing up"
              subtitle="Straight answers about automation, your documents and your data."
            />
          </div>

          <div className="space-y-3">
            {FAQS.map((faq, index) => {
              const open = openIndex === index;
              return (
                <div
                  key={faq.q}
                  className="landing-reveal overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl transition duration-300 hover:border-white/20"
                  style={{ transitionDelay: `${index * 50}ms` }}
                >
                  <button
                    type="button"
                    onClick={() => setOpenIndex(open ? null : index)}
                    aria-expanded={open}
                    className="flex w-full items-center justify-between gap-5 px-5 py-5 text-left sm:px-6"
                  >
                    <span className="text-[15px] font-black text-white sm:text-base">{faq.q}</span>
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/70 transition duration-300 ${
                        open ? 'rotate-45 border-sky-300/40 bg-sky-400/15 text-sky-200' : ''
                      }`}
                    >
                      <Plus size={14} strokeWidth={3} />
                    </span>
                  </button>
                  <div
                    className={`grid transition-all duration-500 ease-out ${
                      open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <p className="px-5 pb-6 text-[14px] leading-relaxed text-white/60 sm:px-6">
                        {faq.a}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
