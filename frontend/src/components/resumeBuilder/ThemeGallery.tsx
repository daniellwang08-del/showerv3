import { useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Heart, Palette, Trash2 } from 'lucide-react';
import type { ResumeDesign, ThemePreset } from '../../types/resumeDesign';
import type { UserProfile } from '../../types/profile';
import { ControlCard } from './controls';
import { ResumePreview } from './ResumePreview';
import { RESUME_REF_WIDTH } from './PagedResumePreview';
import { effectiveProfile } from '../../utils/resumeContent';
import { useResumeBuilderStore } from '../../stores/resumeBuilderStore';

const LETTER_RATIO = 11 / 8.5;
const THUMB_W = 112;
const PAGE_SIZE = 6;

/** Theme chrome + current resume content for a realistic tile preview. */
function themeThumbDesign(theme: ThemePreset, current: ResumeDesign): ResumeDesign {
  const keepImage = current.layout.header_image ?? null;
  return {
    ...theme.design,
    layout: {
      ...theme.design.layout,
      section_order: current.layout.section_order,
      hidden_sections: current.layout.hidden_sections,
      header_image: keepImage,
      header_background: keepImage ? 'image' : theme.design.layout.header_background,
      header_metrics: null,
      layout_metrics: null,
    },
    sections: { ...current.sections },
    content: current.content ?? theme.design.content ?? null,
  };
}

function ThemeThumb({
  design,
  profile,
}: {
  design: ResumeDesign;
  profile: UserProfile | null;
}) {
  const scale = THUMB_W / RESUME_REF_WIDTH;
  return (
    <div
      className="relative mx-auto overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-slate-900/10"
      style={{ width: THUMB_W, height: THUMB_W * LETTER_RATIO }}
      aria-hidden
    >
      <div
        className="pointer-events-none origin-top-left"
        style={{
          width: RESUME_REF_WIDTH,
          transform: `scale(${scale})`,
        }}
      >
        <ResumePreview design={design} profile={profile} />
      </div>
    </div>
  );
}

export function ThemeGallery({
  themes,
  design,
  onApply,
}: {
  themes: ThemePreset[];
  design: ResumeDesign;
  onApply: (theme: ThemePreset) => void;
}) {
  const profile = useResumeBuilderStore((s) => s.profile);
  const toggleThemeLove = useResumeBuilderStore((s) => s.toggleThemeLove);
  const deleteCustomTheme = useResumeBuilderStore((s) => s.deleteCustomTheme);
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(themes.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageThemes = themes.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => {
    if (page > pageCount - 1) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  const step = (dir: -1 | 1) => {
    setPage((p) => Math.max(0, Math.min(pageCount - 1, p + dir)));
  };

  return (
    <ControlCard icon={Palette} title="Theme">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {themes.length} theme{themes.length === 1 ? '' : 's'} · Loved first · {PAGE_SIZE}/page
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={safePage <= 0}
            aria-label="Previous themes"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:opacity-40"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="min-w-[2.5rem] text-center text-[11px] font-semibold tabular-nums text-slate-500">
            {safePage + 1}/{pageCount}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={safePage >= pageCount - 1}
            aria-label="Next themes"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {pageThemes.map((theme) => {
          const active = theme.id === design.theme_id;
          const loved = Boolean(theme.is_loved);
          const thumbDesign = themeThumbDesign(theme, design);
          const thumbProfile = effectiveProfile(profile, thumbDesign.content);

          return (
            <div
              key={theme.id}
              className={`group relative flex flex-col items-stretch gap-2 rounded-xl border p-2 text-left transition ${
                active
                  ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-400/70'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 hover:shadow-sm'
              }`}
            >
              <button
                type="button"
                onClick={() => onApply(theme)}
                title={theme.description}
                className="relative text-left"
              >
                <ThemeThumb design={thumbDesign} profile={thumbProfile} />
                <span
                  className="absolute left-1.5 top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white"
                  style={{ backgroundColor: theme.accent_swatch }}
                  aria-hidden
                />
                {active && (
                  <span className="absolute bottom-1.5 right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm ring-2 ring-white">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
              </button>

              <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleThemeLove(theme.id);
                  }}
                  title={loved ? 'Unlove theme' : 'Love theme'}
                  aria-label={loved ? 'Unlove theme' : 'Love theme'}
                  className={`inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/95 shadow-sm ring-1 transition ${
                    loved
                      ? 'text-rose-500 ring-rose-200 hover:bg-rose-50'
                      : 'text-slate-400 ring-slate-200 hover:text-rose-500'
                  }`}
                >
                  <Heart size={13} className={loved ? 'fill-current' : ''} />
                </button>
                {theme.is_custom && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteCustomTheme(theme.id);
                    }}
                    title="Delete custom theme"
                    aria-label="Delete custom theme"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/95 text-slate-400 shadow-sm ring-1 ring-slate-200 transition hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>

              <button type="button" onClick={() => onApply(theme)} className="min-w-0 px-0.5 text-left">
                <span className="flex items-center gap-1">
                  <span className="block truncate text-[12px] font-bold text-slate-900">{theme.label}</span>
                  {theme.is_custom && (
                    <span className="shrink-0 rounded bg-violet-100 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-violet-700">
                      Custom
                    </span>
                  )}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[10px] leading-snug text-slate-500">
                  {theme.description}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </ControlCard>
  );
}
