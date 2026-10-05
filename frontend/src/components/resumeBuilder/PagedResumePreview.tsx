import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayoutMetrics, PaperSize, ResumeDesign } from '../../types/resumeDesign';
import type { UserProfile } from '../../types/profile';
import {
  PT_TO_PX,
  ResumePreview,
  resumeHasHeaderBand,
  resumeVerticalMarginsPx,
  type CoverLetterBody,
} from './ResumePreview';

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

/** Leaf roles that must not end a page (they introduce the block after them). */
const KEEP_WITH_NEXT = new Set(['heading', 'exp-head', 'exp-lead', 'exp-label']);

/** Mark which `[data-block]` leaves belong on this page clone.
 *  Uses a data attribute (not `el.style.visibility`) so a later React style
 *  rewrite, e.g. changing heading color, cannot drop on-page titles. */
export function stampPageBlockVisibility(host: HTMLElement, visible: boolean[]): void {
  const els = host.querySelectorAll<HTMLElement>('[data-block]');
  els.forEach((el, idx) => {
    el.dataset.onPage = visible[idx] ? '1' : '0';
    el.style.removeProperty('visibility');
  });
}

/** Page geometry in CSS px at 96 dpi. The PDF renderer prints frames of exactly this
 *  size onto pages of exactly this size, so each on-screen page is one PDF page. */
export const PAPER_SIZES: Record<PaperSize, { label: string; widthPx: number; heightPx: number; css: string }> = {
  letter: { label: 'US Letter', widthPx: 816, heightPx: 1056, css: '8.5in 11in' },
  a4: { label: 'A4', widthPx: (210 / 25.4) * 96, heightPx: (297 / 25.4) * 96, css: '210mm 297mm' },
};

export function paperOf(design: ResumeDesign): PaperSize {
  return design.layout.paper === 'a4' ? 'a4' : 'letter';
}

/** Native width of a US Letter page; galleries and thumbnails lay out at this width. */
export const RESUME_REF_WIDTH = PAPER_SIZES.letter.widthPx;

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
  visible: boolean[]; // per [data-block] (document order): painted on this page
}

export interface ResumeLayoutInfo {
  pageCount: number;
  /** Flow offsets (native px) where pages 2..n start. */
  breaks: number[];
  paper: PaperSize;
}

interface Props {
  design: ResumeDesign;
  profile: UserProfile | null;
  letter?: CoverLetterBody | null;
  /** On-screen width of each page, in CSS pixels (already includes any zoom). Ignored in print mode. */
  displayWidth?: number;
  gap?: number;
  showBadges?: boolean;
  /** `print` renders bare, unscaled page frames that the PDF renderer prints 1:1. */
  mode?: 'screen' | 'print';
  /** Prefix for each page's DOM id, so a thumbnail can scroll to it. */
  idPrefix?: string;
  onPageCount?: (count: number) => void;
  onLayout?: (info: ResumeLayoutInfo) => void;
  onSelect?: (index: number) => void;
  /** Reports the exact rendered header-band geometry (pt) so the .docx export can pin
   *  its band to the same height. Wire this on a single instance only. */
  onMeasureHeader?: (m: MeasuredHeaderMetrics) => void;
  /** Reports the realized per-role body gaps (pt) for the .docx export. */
  onMeasureLayout?: (m: MeasuredLayoutMetrics) => void;
  /** Only run the offscreen measure pass (no visible pages). */
  measureOnly?: boolean;
}

/**
 * The one paginator behind every resume surface: the studio preview, thumbnails and
 * the server-side PDF (which loads this same component in Chromium in `print` mode).
 *
 * The resume is laid out once (hidden) at the paper's native width with the vertical
 * page margin removed. Leaf `[data-block]` elements (headings, entry heads, single
 * bullets, letter paragraphs) are measured and a page break is moved up to the top
 * of any leaf that would cross the bottom edge. Each page then shows its slice of
 * the flow through a clipped viewport, and every block that does not overlap the
 * slice is hidden, so a PDF page never carries invisible text from another page.
 * A full-bleed header band keeps a zero top margin on page 1 only.
 */
export function ResumePageStack({
  design,
  profile,
  letter = null,
  displayWidth,
  gap = 20,
  showBadges = true,
  mode = 'screen',
  idPrefix,
  onPageCount,
  onLayout,
  onSelect,
  onMeasureHeader,
  onMeasureLayout,
  measureOnly = false,
}: Props) {
  const measureRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [pages, setPages] = useState<Page[]>([{ offset: 0, height: 0, topMargin: 0, visible: [] }]);
  // Last reported geometry, so callbacks only fire on a real change (otherwise
  // reporting -> store update -> re-render -> re-measure would loop).
  const lastReported = useRef<MeasuredHeaderMetrics | null>(null);
  const lastReportedLayout = useRef<MeasuredLayoutMetrics | null>(null);

  const paper = paperOf(design);
  const { widthPx: nativeW, heightPx: nativeH } = PAPER_SIZES[paper];
  const { top: marginTop, bottom: marginBottom } = resumeVerticalMarginsPx(design);
  const hasBand = resumeHasHeaderBand(design);

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;

    const reportHeaderMetrics = (rootEl: HTMLElement, rootTopPx: number) => {
      if (!onMeasureHeader) return;
      const band = rootEl.querySelector('[data-header-band]') as HTMLElement | null;
      let next: MeasuredHeaderMetrics;
      if (!band) {
        next = { band_pt: null, gap_pt: null, measured_at_px: nativeW };
      } else {
        const bandRect = band.getBoundingClientRect();
        const bandBottom = bandRect.bottom - rootTopPx;
        let firstTop = Infinity;
        for (const el of Array.from(rootEl.querySelectorAll('[data-block]')) as HTMLElement[]) {
          if (el === band || band.contains(el)) continue;
          const top = el.getBoundingClientRect().top - rootTopPx;
          if (top > bandBottom - 1 && top < firstTop) firstTop = top;
        }
        const gapPx = firstTop === Infinity ? null : Math.max(0, firstTop - bandBottom);
        const rawBand = round1(bandRect.height / PT_TO_PX);
        const rawGap = gapPx == null ? null : round1(gapPx / PT_TO_PX);
        next = {
          band_pt: Math.min(rawBand, 220),
          gap_pt: rawGap == null ? null : Math.min(rawGap, 48),
          measured_at_px: nativeW,
        };
      }
      const prev = lastReported.current;
      if (!prev || !nearlyEqual(prev.band_pt, next.band_pt) || !nearlyEqual(prev.gap_pt, next.gap_pt)) {
        lastReported.current = next;
        onMeasureHeader(next);
      }
    };

    const reportLayoutMetrics = (rootEl: HTMLElement, rootTopPx: number) => {
      if (!onMeasureLayout) return;
      const leaves = (Array.from(rootEl.querySelectorAll('[data-gap-role]')) as HTMLElement[])
        .filter((el) => !el.querySelector('[data-gap-role]'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { role: el.dataset.gapRole ?? '', top: r.top - rootTopPx, bottom: r.bottom - rootTopPx, left: r.left, right: r.right };
        });

      // Measure vertical gaps only within a column (a 2-column layout interleaves).
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
          const g = Math.max(0, cur.top - prev.bottom) / PT_TO_PX;
          const afterHeading = prev.role === 'heading';
          switch (cur.role) {
            case 'heading':
              add('heading_before_pt', g);
              break;
            case 'skill':
              add(afterHeading ? 'heading_after_pt' : 'skill_row_pt', g);
              break;
            case 'edu':
              add(afterHeading ? 'heading_after_pt' : 'edu_entry_pt', g);
              break;
            case 'cert':
              add(afterHeading ? 'heading_after_pt' : 'cert_row_pt', g);
              break;
            case 'exp-head':
              add(afterHeading ? 'heading_after_pt' : 'exp_company_pt', g);
              break;
            case 'exp-lead':
              add('exp_lead_pt', g);
              break;
            case 'exp-label':
              add('exp_label_pt', g);
              break;
            case 'exp-bull':
              add('exp_bullet_pt', g);
              break;
            case 'exp-used':
              add('exp_used_pt', g);
              break;
          }
        }
      }
      const next = { measured_at_px: nativeW } as MeasuredLayoutMetrics;
      for (const f of LAYOUT_FIELDS) {
        const a = acc[f];
        next[f] = a ? round1(a.sum / a.n) : null;
      }
      const prev = lastReportedLayout.current;
      if (!prev || LAYOUT_FIELDS.some((f) => !nearlyEqual(prev[f], next[f]))) {
        lastReportedLayout.current = next;
        onMeasureLayout(next);
      }
    };

    const compute = () => {
      const box = root.getBoundingClientRect();
      // A display:none ancestor (mobile Edit tab) collapses the measurer to 0.
      // Writing those zeros would mark the design dirty and trigger a save.
      if (box.width < 8 || root.scrollHeight < 8) return;
      const total = root.scrollHeight;
      const rootTop = box.top;

      reportHeaderMetrics(root, rootTop);
      reportLayoutMetrics(root, rootTop);
      if (measureOnly) return;

      const blocks = (Array.from(root.querySelectorAll('[data-block]')) as HTMLElement[]).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          top: r.top - rootTop,
          bottom: r.bottom - rootTop,
          leaf: !el.querySelector('[data-block]'),
          keepNext: KEEP_WITH_NEXT.has(el.dataset.gapRole ?? '') || el.hasAttribute('data-keep-next'),
        };
      });
      const leaves = blocks.filter((b) => b.leaf && b.bottom - b.top > 0.5);

      const slices: Omit<Page, 'visible'>[] = [];
      let start = 0;
      let pageIndex = 0;
      let guard = 0;
      while (start < total - 0.5 && guard++ < 500) {
        const topMargin = pageIndex === 0 && hasBand ? 0 : marginTop;
        const areaH = Math.max(40, nativeH - topMargin - marginBottom);
        let target = start + areaH;
        if (target >= total) {
          slices.push({ offset: start, height: total - start, topMargin });
          break;
        }
        // A leaf that starts on this page but crosses the bottom edge moves the break
        // up to its top. A leaf taller than a whole page is allowed to split.
        let cut = Infinity;
        for (const b of leaves) {
          if (b.top > start + 0.5 && b.top < target && b.bottom > target + 0.5) cut = Math.min(cut, b.top);
        }
        if (cut !== Infinity && cut > start + 0.5) target = cut;
        // Never end a page on a heading or label: carry it over with what it introduces.
        for (let k = 0; k < 6; k++) {
          let last: (typeof leaves)[number] | null = null;
          for (const b of leaves) {
            if (b.top >= start - 0.5 && b.bottom <= target + 0.5 && (!last || b.bottom > last.bottom)) last = b;
          }
          if (!last || !last.keepNext || last.top <= start + 0.5) break;
          target = last.top;
        }
        if (target <= start) target = start + areaH;
        slices.push({ offset: start, height: target - start, topMargin });
        start = target;
        pageIndex += 1;
      }
      if (!slices.length) slices.push({ offset: 0, height: total, topMargin: hasBand ? 0 : marginTop });

      const next: Page[] = slices.map((s) => {
        const end = s.offset + s.height;
        return { ...s, visible: blocks.map((b) => b.top < end - 0.5 && b.bottom > s.offset + 0.5) };
      });
      setPages((prev) => (samePages(prev, next) ? prev : next));
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(root);
    return () => ro.disconnect();
  }, [design, profile, letter, marginTop, marginBottom, hasBand, nativeW, nativeH, onMeasureHeader, onMeasureLayout, measureOnly]);

  // Hide every block that belongs to another page so a PDF page never carries
  // extractable text from another page. Re-stamp after `design` changes: React
  // rewrites heading/color style objects and used to wipe inline visibility,
  // which made section titles inherit hidden from the page host.
  useLayoutEffect(() => {
    if (measureOnly) return;
    pages.forEach((page, i) => {
      const host = pageRefs.current[i];
      if (!host) return;
      stampPageBlockVisibility(host, page.visible);
    });
  }, [pages, measureOnly, design]);

  const pageCount = pages.length;
  useEffect(() => {
    if (measureOnly) return;
    onPageCount?.(pageCount);
    onLayout?.({ pageCount, breaks: pages.slice(1).map((p) => Math.round(p.offset * 10) / 10), paper });
  }, [pages, pageCount, paper, onPageCount, onLayout, measureOnly]);

  const measurer = (
    <div
      aria-hidden="true"
      className="resume-doc"
      style={{ position: 'absolute', left: -99999, top: 0, width: nativeW, visibility: 'hidden', pointerEvents: 'none' }}
    >
      <div ref={measureRef}>
        <ResumePreview design={design} profile={profile} letter={letter} paged />
      </div>
    </div>
  );

  if (measureOnly) return measurer;

  const renderPageBody = (page: Page, i: number) => (
    <div style={{ width: nativeW, height: nativeH, position: 'relative', overflow: 'hidden', background: '#ffffff' }}>
      {/* Content viewport: this page's slice of the flow, inset by the top margin. */}
      <div style={{ position: 'absolute', top: page.topMargin, left: 0, width: nativeW, height: page.height, overflow: 'hidden' }}>
        <div
          ref={(el) => {
            pageRefs.current[i] = el;
          }}
          className="resume-page-body"
          style={{ position: 'absolute', top: -page.offset, left: 0, width: nativeW }}
        >
          <ResumePreview design={design} profile={profile} letter={letter} paged />
        </div>
      </div>
    </div>
  );

  if (mode === 'print') {
    return (
      <div className="resume-doc">
        {measurer}
        {pages.map((page, i) => (
          <div
            key={i}
            data-print-page={i + 1}
            style={{ width: nativeW, height: nativeH, overflow: 'hidden', breakAfter: i < pages.length - 1 ? 'page' : 'auto' }}
          >
            {renderPageBody(page, i)}
          </div>
        ))}
      </div>
    );
  }

  const dispW = displayWidth ?? nativeW;
  const scale = dispW / nativeW;
  const dispH = nativeH * scale;
  const interactive = Boolean(onSelect);
  const Frame = interactive ? 'button' : 'div';

  return (
    <div className="resume-doc flex w-full flex-col items-center" style={{ gap }}>
      {measurer}
      {pages.map((page, i) => (
        <Frame
          key={i}
          id={idPrefix ? `${idPrefix}-${i}` : undefined}
          type={interactive ? 'button' : undefined}
          onClick={interactive ? () => onSelect?.(i) : undefined}
          className={`relative block shrink-0 overflow-hidden rounded-[3px] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.12),0_8px_24px_-8px_rgba(15,23,42,0.18)] ring-1 ring-black/5 ${
            interactive ? 'cursor-pointer transition hover:ring-2 hover:ring-ring' : ''
          }`}
          style={{ width: dispW, height: dispH }}
        >
          <div style={{ width: nativeW, height: nativeH, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            {renderPageBody(page, i)}
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

function samePages(a: Page[], b: Page[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    return (
      Math.abs(p.offset - q.offset) < 0.25 &&
      Math.abs(p.height - q.height) < 0.25 &&
      p.topMargin === q.topMargin &&
      p.visible.length === q.visible.length &&
      p.visible.every((v, j) => v === q.visible[j])
    );
  });
}
