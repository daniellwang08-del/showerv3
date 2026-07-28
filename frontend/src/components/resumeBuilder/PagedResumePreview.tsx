import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayoutMetrics, ResumeDesign } from '../../types/resumeDesign';
import type { UserProfile } from '../../types/profile';
import { PT_TO_PX, ResumePreview, resumeHasHeaderBand, resumeVerticalMarginsPx } from './ResumePreview';

/** Exact header-band geometry measured from the rendered preview (points). */
export interface MeasuredHeaderMetrics {
  band_pt: number | null;
  gap_pt: number | null;
  measured_at_px: number;
}

/** Per-role body gaps measured from the rendered preview (points). */
export type MeasuredLayoutMetrics = LayoutMetrics;

/** Maps each measured DOM gap (between two consecutive `[data-gap-role]` leaves) to a
 *  manifest field. Keyed by the *current* block's role; a few roles disambiguate the
 *  first-after-heading case from the repeated-row case via the previous role. */
const LAYOUT_FIELDS: (keyof LayoutMetrics)[] = [
  'heading_before_pt',
  'heading_after_pt',
  'exp_lead_pt',
  'exp_label_pt',
  'exp_bullet_pt',
  'exp_used_pt',
  'exp_company_pt',
  'skill_row_pt',
  'edu_entry_pt',
  'cert_row_pt',
];

const LETTER_RATIO = 11 / 8.5; // height / width for US Letter
/** Native layout width used to lay out and measure the resume. Every instance
 *  (main preview and thumbnail rail) renders at this width and is then scaled,
 *  so page breaks are identical regardless of the on-screen size.
 *
 *  This MUST equal a true US-Letter page width at 96 dpi (8.5 in × 96 = 816 px,
 *  i.e. 612 pt × PT_TO_PX). Elements are sized in px via PT_TO_PX = 1.3333, so any
 *  other reference width would scale text/margins relative to the page differently
 *  than the LibreOffice-rendered PDF and shift every line break. */
export const RESUME_REF_WIDTH = 816;

const round1 = (n: number): number => Math.round(n * 10) / 10;
/** Treat two (possibly null) pt values as equal within ~0.4 pt, so sub-pixel jitter
 *  from the browser layout does not trigger a save/recompile loop. */
const nearlyEqual = (a: number | null, b: number | null): boolean => {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) < 0.4;
};

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
  /** Reports the exact rendered header-band geometry (pt) so the compiler can pin the
   *  .docx band to the same height the browser drew. Wire this on a single instance
   *  (the main preview) only. */
  onMeasureHeader?: (m: MeasuredHeaderMetrics) => void;
  /** Reports the realized per-role body gaps (pt) so the compiler/fill engine reproduce
   *  the exact spacing the user designed. Wire on the main preview only. */
  onMeasureLayout?: (m: MeasuredLayoutMetrics) => void;
  /** When true, only run the offscreen measure pass (no visible HTML pages). Used while
   *  the builder shows accurate PDF page images as the primary preview. */
  measureOnly?: boolean;
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
  onMeasureHeader,
  onMeasureLayout,
  measureOnly = false,
}: Props) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Page[]>([{ offset: 0, height: 0, topMargin: 0 }]);
  // Last reported band geometry, so we only fire onMeasureHeader on a real change
  // (otherwise reporting → store update → re-render → re-measure would loop).
  const lastReported = useRef<MeasuredHeaderMetrics | null>(null);
  // Same idempotency guard for the per-role body spacing manifest.
  const lastReportedLayout = useRef<MeasuredLayoutMetrics | null>(null);

  const { top: marginTop, bottom: marginBottom } = resumeVerticalMarginsPx(design);
  const hasBand = resumeHasHeaderBand(design);
  const nativePageH = RESUME_REF_WIDTH * LETTER_RATIO;

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;

    const reportHeaderMetrics = (rootEl: HTMLElement, rootTopPx: number) => {
      if (!onMeasureHeader) return;
      const band = rootEl.querySelector('[data-header-band]') as HTMLElement | null;
      let next: MeasuredHeaderMetrics;
      if (!band) {
        next = { band_pt: null, gap_pt: null, measured_at_px: RESUME_REF_WIDTH };
      } else {
        const bandRect = band.getBoundingClientRect();
        const bandBottom = bandRect.bottom - rootTopPx;
        // First content block after the band (the band itself is a [data-block]).
        let firstTop = Infinity;
        for (const el of Array.from(rootEl.querySelectorAll('[data-block]')) as HTMLElement[]) {
          if (el === band || band.contains(el)) continue;
          const top = el.getBoundingClientRect().top - rootTopPx;
          if (top > bandBottom - 1 && top < firstTop) firstTop = top;
        }
        const gapPx = firstTop === Infinity ? null : Math.max(0, firstTop - bandBottom);
        // Clamp absurd geometry. Do NOT null band_pt — a null pin lets dxpdf size the
        // first-page header from nested contact tables, which can grow past the page
        // and shove the Technical two-column body onto page 2 (blank page-1 body).
        const twoCol = design.layout.columns === 2;
        const bandCap = twoCol ? 110 : 220;
        const gapCap = twoCol ? 16 : 48;
        const rawBand = round1(bandRect.height / PT_TO_PX);
        const rawGap = gapPx == null ? null : round1(gapPx / PT_TO_PX);
        next = {
          band_pt: Math.min(rawBand, bandCap),
          gap_pt: rawGap == null ? null : Math.min(rawGap, gapCap),
          measured_at_px: RESUME_REF_WIDTH,
        };
      }
      const prev = lastReported.current;
      const changed =
        !prev ||
        !nearlyEqual(prev.band_pt, next.band_pt) ||
        !nearlyEqual(prev.gap_pt, next.gap_pt);
      if (changed) {
        lastReported.current = next;
        onMeasureHeader(next);
      }
    };

    const reportLayoutMetrics = (rootEl: HTMLElement, rootTopPx: number) => {
      if (!onMeasureLayout) return;
      // Flat, document-ordered list of the *leaf* gap-role blocks (a tagged element
      // that contains no other tagged element). Measuring leaves keeps the vertical
      // sequence non-nested, so `top - prevBottom` is the true inter-paragraph gap.
      const leaves = (Array.from(rootEl.querySelectorAll('[data-gap-role]')) as HTMLElement[])
        .filter((el) => !el.querySelector('[data-gap-role]'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            role: el.dataset.gapRole ?? '',
            top: r.top - rootTopPx,
            bottom: r.bottom - rootTopPx,
            left: r.left,
            right: r.right,
          };
        });

      // In a 2-column layout the left and right column leaves interleave in `top`
      // order, so a flat top-sort would measure meaningless cross-column "gaps".
      // Partition leaves into columns by horizontal overlap, then measure vertical
      // gaps only *within* a column. A single-column layout collapses to one group,
      // so this is a no-op there.
      type Leaf = (typeof leaves)[number];
      const columns: { left: number; right: number; items: Leaf[] }[] = [];
      for (const leaf of leaves.slice().sort((a, b) => a.left - b.left)) {
        const mid = (leaf.left + leaf.right) / 2;
        const col = columns.find((c) => mid >= c.left && mid <= c.right);
        if (col) {
          col.items.push(leaf);
          col.left = Math.min(col.left, leaf.left);
          col.right = Math.max(col.right, leaf.right);
        } else {
          columns.push({ left: leaf.left, right: leaf.right, items: [leaf] });
        }
      }

      const acc: Record<string, { sum: number; n: number }> = {};
      const add = (key: keyof LayoutMetrics, v: number) => {
        const a = acc[key] ?? (acc[key] = { sum: 0, n: 0 });
        a.sum += v;
        a.n += 1;
      };
      for (const col of columns) {
        const ordered = col.items.slice().sort((a, b) => a.top - b.top);
        for (let i = 1; i < ordered.length; i++) {
          const prev = ordered[i - 1];
          const cur = ordered[i];
          const gap = Math.max(0, cur.top - prev.bottom) / PT_TO_PX;
          const afterHeading = prev.role === 'heading';
          switch (cur.role) {
            case 'heading':
              add('heading_before_pt', gap);
              break;
            case 'skill':
              add(afterHeading ? 'heading_after_pt' : 'skill_row_pt', gap);
              break;
            case 'edu':
              add(afterHeading ? 'heading_after_pt' : 'edu_entry_pt', gap);
              break;
            case 'cert':
              add(afterHeading ? 'heading_after_pt' : 'cert_row_pt', gap);
              break;
            case 'exp-head':
              add(afterHeading ? 'heading_after_pt' : 'exp_company_pt', gap);
              break;
            case 'exp-lead':
              add('exp_lead_pt', gap);
              break;
            case 'exp-label':
              add('exp_label_pt', gap);
              break;
            case 'exp-bull':
              add('exp_bullet_pt', gap);
              break;
            case 'exp-used':
              add('exp_used_pt', gap);
              break;
          }
        }
      }
      const next = { measured_at_px: RESUME_REF_WIDTH } as MeasuredLayoutMetrics;
      for (const f of LAYOUT_FIELDS) {
        const a = acc[f];
        next[f] = a ? round1(a.sum / a.n) : null;
      }
      const prev = lastReportedLayout.current;
      const changed = !prev || LAYOUT_FIELDS.some((f) => !nearlyEqual(prev[f], next[f]));
      if (changed) {
        lastReportedLayout.current = next;
        onMeasureLayout(next);
      }
    };

    const compute = () => {
      const total = root.scrollHeight;
      const rootTop = root.getBoundingClientRect().top;

      reportHeaderMetrics(root, rootTop);
      reportLayoutMetrics(root, rootTop);

      if (measureOnly) return;

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
  }, [design, profile, marginTop, marginBottom, hasBand, nativePageH, onMeasureHeader, onMeasureLayout, measureOnly]);

  const scale = displayWidth / RESUME_REF_WIDTH;
  const dispW = displayWidth;
  const dispH = nativePageH * scale;
  const pageCount = pages.length;

  useEffect(() => {
    if (measureOnly) return;
    onPageCount?.(pageCount);
  }, [pageCount, onPageCount, measureOnly]);

  if (measureOnly) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-[-99999px] top-0 overflow-hidden opacity-0"
        style={{ width: RESUME_REF_WIDTH }}
      >
        <div ref={measureRef}>
          <ResumePreview design={design} profile={profile} paged />
        </div>
      </div>
    );
  }

  const interactive = Boolean(onSelect);
  const Frame = interactive ? 'button' : 'div';

  return (
    <div className="flex w-full flex-col items-center" style={{ gap }}>
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
            <span className="resume-page-badge pointer-events-none absolute bottom-1.5 right-1.5 z-10 min-w-[1.125rem] rounded px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none tabular-nums shadow-sm">
              {i + 1}
            </span>
          )}
        </Frame>
      ))}
    </div>
  );
}
