import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ResumeDesign } from '../../types/resumeDesign';
import type { UserProfile } from '../../types/profile';
import { ResumePreview, resumeHasHeaderBand, resumeVerticalMarginsPx } from './ResumePreview';

const LETTER_RATIO = 11 / 8.5; // height / width for US Letter
/** Native layout width used to lay out and measure the resume. Every instance
 *  (main preview and thumbnail rail) renders at this width and is then scaled,
 *  so page breaks are identical regardless of the on-screen size. */
export const RESUME_REF_WIDTH = 760;

interface Page {
  offset: number; // native px into the content flow where this page starts
  height: number; // native px of content shown on this page
  topMargin: number; // native px white margin above the content on this page
}

interface Props {
  design: ResumeDesign;
  profile: UserProfile | null;
  /** On-screen width of each page, in CSS pixels (already includes any zoom). */
  displayWidth: number;
  gap?: number;
  showBadges?: boolean;
  /** Prefix for each page's DOM id, so a thumbnail can scroll to it. */
  idPrefix?: string;
  onPageCount?: (count: number) => void;
  onSelect?: (index: number) => void;
}

/**
 * Renders the live resume preview split into discrete US-Letter page frames,
 * stacked vertically like the page view in Word / the slide list in
 * PowerPoint.
 *
 * The resume is laid out once (hidden) at RESUME_REF_WIDTH with the vertical
 * page margin removed; its `[data-block]` elements (section headings, entry
 * heads, individual bullets, ...) are measured so a page break prefers to fall
 * BETWEEN blocks. Each visible page reserves a real top + bottom margin, then
 * shows the matching content slice via a clipped viewport - so a long work
 * experience naturally flows onto the next page instead of being kept whole.
 * A full-bleed header band keeps a zero top margin on page 1 only.
 */
export function ResumePageStack({
  design,
  profile,
  displayWidth,
  gap = 20,
  showBadges = true,
  idPrefix,
  onPageCount,
  onSelect,
}: Props) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Page[]>([{ offset: 0, height: 0, topMargin: 0 }]);

  const { top: marginTop, bottom: marginBottom } = resumeVerticalMarginsPx(design);
  const hasBand = resumeHasHeaderBand(design);
  const nativePageH = RESUME_REF_WIDTH * LETTER_RATIO;

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;

    const compute = () => {
      const total = root.scrollHeight;
      const rootTop = root.getBoundingClientRect().top;
      const ranges = (Array.from(root.querySelectorAll('[data-block]')) as HTMLElement[])
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top - rootTop, bottom: r.bottom - rootTop };
        })
        .sort((a, b) => a.top - b.top);

      const result: Page[] = [];
      let start = 0;
      let pageIndex = 0;
      let guard = 0;
      while (start < total - 0.5 && guard++ < 500) {
        const topMargin = pageIndex === 0 && hasBand ? 0 : marginTop;
        const areaH = Math.max(40, nativePageH - topMargin - marginBottom);
        let target = start + areaH;

        if (target >= total) {
          result.push({ offset: start, height: total - start, topMargin });
          start = total;
          break;
        }

        // If a block starts inside this page but crosses the bottom edge, move
        // the break up to its top so it begins the next page. Blocks that begin
        // before the page (taller than the area) are allowed to split instead.
        let cut = Infinity;
        for (const rg of ranges) {
          if (rg.top > start + 0.5 && rg.top < target && rg.bottom > target + 0.5) {
            cut = Math.min(cut, rg.top);
          }
        }
        if (cut !== Infinity && cut > start + 0.5) target = cut;
        if (target <= start) target = start + areaH; // always make progress

        result.push({ offset: start, height: target - start, topMargin });
        start = target;
        pageIndex += 1;
      }

      setPages(result.length ? result : [{ offset: 0, height: total, topMargin: hasBand ? 0 : marginTop }]);
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(root);
    return () => ro.disconnect();
  }, [design, profile, marginTop, marginBottom, hasBand, nativePageH]);

  const scale = displayWidth / RESUME_REF_WIDTH;
  const dispW = displayWidth;
  const dispH = nativePageH * scale;
  const pageCount = pages.length;

  useEffect(() => {
    onPageCount?.(pageCount);
  }, [pageCount, onPageCount]);

  const interactive = Boolean(onSelect);
  const Frame = interactive ? 'button' : 'div';

  return (
    <div className="flex flex-col items-center" style={{ gap }}>
      {/* Hidden measuring instance at native width (vertical margin removed). */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', left: -99999, top: 0, width: RESUME_REF_WIDTH, visibility: 'hidden', pointerEvents: 'none' }}
      >
        <div ref={measureRef}>
          <ResumePreview design={design} profile={profile} paged />
        </div>
      </div>

      {pages.map((page, i) => (
        <Frame
          key={i}
          id={idPrefix ? `${idPrefix}-${i}` : undefined}
          type={interactive ? 'button' : undefined}
          onClick={interactive ? () => onSelect?.(i) : undefined}
          className={`relative block shrink-0 overflow-hidden rounded-lg bg-white shadow-lg ring-1 ring-slate-900/10 ${
            interactive ? 'cursor-pointer transition hover:ring-2 hover:ring-blue-400' : ''
          }`}
          style={{ width: dispW, height: dispH }}
        >
          <div
            style={{
              width: RESUME_REF_WIDTH,
              height: nativePageH,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              position: 'relative',
              overflow: 'hidden',
              background: '#ffffff',
            }}
          >
            {/* Content viewport: clipped to this page's slice, inset by the top
                margin. The white page shows through above and below as margins. */}
            <div
              style={{
                position: 'absolute',
                top: page.topMargin,
                left: 0,
                width: RESUME_REF_WIDTH,
                height: page.height,
                overflow: 'hidden',
              }}
            >
              <div style={{ position: 'absolute', top: -page.offset, left: 0, width: RESUME_REF_WIDTH }}>
                <ResumePreview design={design} profile={profile} paged />
              </div>
            </div>
          </div>
          {showBadges && (
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white shadow-sm">
              {i + 1}
            </span>
          )}
        </Frame>
      ))}
    </div>
  );
}
