import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Heart, Palette, Trash2 } from 'lucide-react';
import type { ResumeDesign, ThemePreset } from '../../types/resumeDesign';
import type { UserProfile } from '../../types/profile';
import { ControlCard } from './controls';
import { ResumePreview } from './ResumePreview';
import { RESUME_REF_WIDTH } from './PagedResumePreview';
import { effectiveProfile } from '../../utils/resumeContent';
import { themeDesignFor, useResumeBuilderStore } from '../../stores/resumeBuilderStore';

const PAGE_SIZE = 6;

/** Exactly what applying the theme produces, with the current resume content. */
const themeThumbDesign = themeDesignFor;

function ThemeThumb({
  design,
  profile,
}: {
  design: ResumeDesign;
  profile: UserProfile | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostW, setHostW] = useState(0);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const sync = () => {
      const w = el.clientWidth;
      if (w > 0) setHostW(w);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scale the full letter-size preview into the fluid tile width so 2-col
  // grids never force a fixed 112px min-content wider than the Style sidebar.
  const scale = hostW > 0 ? hostW / RESUME_REF_WIDTH : 0;

  return (
    <div
      ref={hostRef}
      className="relative w-full overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-slate-900/10"
      style={{ aspectRatio: 8.5 / 11 }}
      aria-hidden
    >
      {scale > 0 && (
        <div
          className="pointer-events-none absolute left-0 top-0 origin-top-left"
          style={{
            width: RESUME_REF_WIDTH,
            transform: `scale(${scale})`,
          }}
        >
          <ResumePreview design={design} profile={profile} />
        </div>
      )}
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
    <ControlCard icon={Palette} title="Resume style">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          One click restyles every section. Fine-tune below.
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

      <div className="grid min-w-0 grid-cols-2 gap-2 sm:gap-2.5">
        {pageThemes.map((theme) => {
          const active = theme.id === design.theme_id;
          const loved = Boolean(theme.is_loved);
          const thumbDesign = themeThumbDesign(theme, design);
          const thumbProfile = effectiveProfile(profile, thumbDesign.content);

          return (
            <div
              key={theme.id}
              className={`group relative flex min-w-0 flex-col items-stretch gap-1.5 overflow-hidden rounded-xl border p-1.5 text-left transition sm:gap-2 sm:p-2 ${
                active
                  ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-400/70'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 hover:shadow-sm'
              }`}
            >
              <button
                type="button"
                onClick={() => onApply(theme)}
                title={theme.description}
                className="relative min-w-0 text-left"
              >
                <ThemeThumb design={thumbDesign} profile={thumbProfile} />
                <span
                  className="absolute left-1 top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white"
                  style={{ backgroundColor: theme.accent_swatch }}
                  aria-hidden
                />
                {active && (
                  <span className="absolute bottom-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm ring-2 ring-white">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
              </button>

              <div className="absolute right-1 top-1 z-10 flex max-w-[calc(100%-1.75rem)] items-center justify-end gap-0.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleThemeLove(theme.id);
                  }}
                  title={loved ? 'Unlove theme' : 'Love theme'}
                  aria-label={loved ? 'Unlove theme' : 'Love theme'}
                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/95 shadow-sm ring-1 transition sm:h-7 sm:w-7 ${
                    loved
                      ? 'text-rose-500 ring-rose-200 hover:bg-rose-50'
                      : 'text-slate-400 ring-slate-200 hover:text-rose-500'
                  }`}
                >
                  <Heart size={12} className={loved ? 'fill-current' : ''} />
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
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/95 text-slate-400 shadow-sm ring-1 ring-slate-200 transition hover:bg-red-50 hover:text-red-600 sm:h-7 sm:w-7"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => onApply(theme)}
                title={theme.description || theme.label}
                className="min-w-0 px-0.5 text-left"
              >
                <span className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-slate-900">
                    {theme.label}
                  </span>
                  {theme.is_custom && (
                    <span className="shrink-0 rounded bg-violet-100 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-violet-700">
                      Custom
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </ControlCard>
  );
}
