import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, ListChecks } from 'lucide-react';
import type { ResumeDesign, SkillsStyle } from '../../types/resumeDesign';
import { ControlCard } from './controls';
import { SkillsBlock } from './ResumePreview';

const REF_W = 300;
const THUMB_W = 168;
const THUMB_H = 116;
const SCALE = THUMB_W / REF_W;
const SAMPLE = [
  { category: 'Languages', skills: 'Python, TypeScript, Go, SQL' },
  { category: 'Cloud & DevOps', skills: 'AWS, Docker, Kubernetes, CI/CD' },
];

export function SkillsStyleGallery({
  styles,
  design,
  onApply,
}: {
  styles: SkillsStyle[];
  design: ResumeDesign;
  onApply: (style: SkillsStyle) => void;
}) {
  const activeId = design.sections.skills_style?.id;
  const rowRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ down: false, moved: false, startX: 0, startLeft: 0 });

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (raw === 0) return;
      e.preventDefault();
      el.scrollLeft += raw * unit;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = rowRef.current;
    if (!el) return;
    drag.current = { down: true, moved: false, startX: e.clientX, startLeft: el.scrollLeft };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = rowRef.current;
    if (!el || !drag.current.down) return;
    const dx = e.clientX - drag.current.startX;
    if (!drag.current.moved && Math.abs(dx) > 4) {
      drag.current.moved = true;
      el.setPointerCapture?.(e.pointerId);
    }
    if (drag.current.moved) {
      el.scrollLeft = drag.current.startLeft - dx;
      e.preventDefault();
    }
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = rowRef.current;
    if (el && el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    drag.current.down = false;
  };
  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (drag.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      drag.current.moved = false;
    }
  };
  const step = (dir: -1 | 1) => {
    rowRef.current?.scrollBy({ left: dir * (THUMB_W + 12) * 2, behavior: 'smooth' });
  };

  return (
    <ControlCard icon={ListChecks} title="Skills style">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-slate-500">Scroll or drag to preview {styles.length} treatments.</p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Previous styles"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Next styles"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      <div
        ref={rowRef}
        className="summary-gallery -mx-1 flex snap-x gap-3 px-1 pb-2"
        style={{ overflowX: 'auto', overflowY: 'hidden', touchAction: 'pan-y', cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
      >
        {styles.map((s) => {
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onApply(s)}
              title={s.label}
              draggable={false}
              className={`group relative snap-start rounded-xl border p-1.5 text-left transition ${
                active
                  ? 'border-blue-500 ring-2 ring-blue-500/40'
                  : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
              }`}
              style={{ flex: '0 0 auto', backgroundColor: '#ffffff' }}
            >
              <div
                className="overflow-hidden rounded-lg border border-slate-200"
                style={{ width: THUMB_W, height: THUMB_H, backgroundColor: '#ffffff' }}
              >
                <div
                  style={{
                    width: REF_W,
                    transform: `scale(${SCALE})`,
                    transformOrigin: 'top left',
                    padding: 12,
                    boxSizing: 'border-box',
                    pointerEvents: 'none',
                  }}
                >
                  <SkillsBlock design={design} style={s} skills={SAMPLE} />
                </div>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-1 px-0.5">
                <span className={`truncate text-[11px] font-semibold ${active ? 'text-blue-700' : 'text-slate-600'}`}>
                  {s.label}
                </span>
                {active && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
                    <Check size={11} />
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </ControlCard>
  );
}
