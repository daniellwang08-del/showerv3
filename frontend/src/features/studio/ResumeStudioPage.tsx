import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ChevronDown,
  Download,
  FileText,
  FileType2,
  LayoutTemplate,
  Loader2,
  Mail,
  Minus,
  Palette,
  PenLine,
  Plus,
  Rows3,
  ScanEye,
  SlidersHorizontal,
  Type,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageTitle } from '@/components/app/PageTitle';
import { cn } from '@/lib/utils';
import { BrandedLoader } from '@/components/layout/BrandedLoader';
import { ThemeGallery } from '@/components/resumeBuilder/ThemeGallery';
import { TypographyControls } from '@/components/resumeBuilder/TypographyControls';
import { ColorControls } from '@/components/resumeBuilder/ColorControls';
import { LayoutControls } from '@/components/resumeBuilder/LayoutControls';
import { HeaderImageControls } from '@/components/resumeBuilder/HeaderImageControls';
import { SummaryStyleGallery } from '@/components/resumeBuilder/SummaryStyleGallery';
import { SkillsStyleGallery } from '@/components/resumeBuilder/SkillsStyleGallery';
import { ExperienceStyleGallery } from '@/components/resumeBuilder/ExperienceStyleGallery';
import { ExperienceControls } from '@/components/resumeBuilder/ExperienceControls';
import { EducationControls } from '@/components/resumeBuilder/EducationControls';
import { CertificatesControls } from '@/components/resumeBuilder/CertificatesControls';
import { SectionManager } from '@/components/resumeBuilder/SectionManager';
import { ContentControls } from '@/components/resumeBuilder/ContentControls';
import { Toolbar } from '@/components/resumeBuilder/Toolbar';
import { ControlCard } from '@/components/resumeBuilder/controls';
import { PAPER_SIZES, ResumePageStack, paperOf } from '@/components/resumeBuilder/PagedResumePreview';
import type { CoverLetterBody } from '@/components/resumeBuilder/ResumePreview';
import { selectIsDirty, useResumeBuilderStore } from '@/stores/resumeBuilderStore';
import { effectiveProfile, normalizeResumeContent, profileToContent } from '@/utils/resumeContent';
import {
  fetchLibraryCoverLetter,
  renderDesign,
  saveFile,
  saveLibraryCoverLetter,
} from '@/api/documentsApi';
import type { PaperSize } from '@/types/resumeDesign';

type Tab = 'theme' | 'type' | 'sections' | 'content';
type DocKind = 'resume' | 'letter';

const TABS: { id: Tab; label: string; icon: typeof Palette }[] = [
  { id: 'theme', label: 'Theme', icon: Palette },
  { id: 'type', label: 'Type & layout', icon: Type },
  { id: 'sections', label: 'Sections', icon: Rows3 },
  { id: 'content', label: 'Content', icon: PenLine },
];

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 1.75, 2];
const CANVAS_PAD = 48;
const LETTER_SAVE_DEBOUNCE_MS = 700;

function letterParagraphs(body: string): string[] {
  return body
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { detail?: string } } };
  return e?.response?.data?.detail || fallback;
}

/** Resume studio: style and edit the active resume on live pages. What you see is
 *  what the PDF gets: the server prints these same page components in Chromium. */
export function ResumeStudioPage() {
  const store = useResumeBuilderStore();
  const dirty = useResumeBuilderStore(selectIsDirty);
  const [tab, setTab] = useState<Tab>(() =>
    useResumeBuilderStore.getState().panelTab === 'content' ? 'content' : 'theme',
  );
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('preview');
  const [doc, setDoc] = useState<DocKind>('resume');
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [fitScale, setFitScale] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [letter, setLetter] = useState<string | null>(null);
  const [letterSaving, setLetterSaving] = useState(false);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const letterTimer = useRef<number | null>(null);

  useEffect(() => {
    void store.load();
    return () => {
      useResumeBuilderStore.getState().flushAutoSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useResumeBuilderStore.getState();
      if (!selectIsDirty(s)) return;
      s.flushAutoSave();
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // The active library resume may carry a cover letter generated with it.
  const activeId = store.activeResumeId;
  useEffect(() => {
    setLetter(null);
    setDoc('resume');
    if (!activeId) return;
    let alive = true;
    fetchLibraryCoverLetter(activeId)
      .then((body) => {
        if (alive) setLetter(body);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [activeId]);

  const design = store.design;
  const paper: PaperSize = design ? paperOf(design) : 'letter';
  const nativeW = PAPER_SIZES[paper].widthPx;

  useEffect(() => {
    if (!canvasEl) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width - CANVAS_PAD;
      if (w > 0) setFitScale(Math.max(0.3, Math.min(1.25, w / nativeW)));
    });
    ro.observe(canvasEl);
    return () => ro.disconnect();
  }, [canvasEl, nativeW]);

  const scale = zoom === 'fit' ? fitScale : zoom;
  const stepZoom = (dir: 1 | -1) => {
    const cur = scale;
    const next =
      dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001);
    if (next) setZoom(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        stepZoom(1);
      } else if (e.key === '-') {
        e.preventDefault();
        stepZoom(-1);
      } else if (e.key === '0') {
        e.preventDefault();
        setZoom('fit');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onLetterChange = (value: string) => {
    setLetter(value);
    if (!activeId) return;
    if (letterTimer.current) window.clearTimeout(letterTimer.current);
    letterTimer.current = window.setTimeout(() => {
      setLetterSaving(true);
      saveLibraryCoverLetter(activeId, value)
        .catch(() => undefined)
        .finally(() => setLetterSaving(false));
    }, LETTER_SAVE_DEBOUNCE_MS);
  };

  const letterBody: CoverLetterBody | null = useMemo(
    () => (doc === 'letter' && letter ? { title: 'Cover Letter', paragraphs: letterParagraphs(letter) } : null),
    [doc, letter],
  );

  const exportAs = useCallback(
    async (kind: 'pdf' | 'docx') => {
      if (!design || exporting) return;
      setExporting(kind);
      setExportError(null);
      try {
        const { file } = await renderDesign(design, kind, { coverLetter: doc === 'letter' ? letter : null });
        saveFile(file);
      } catch (err) {
        setExportError(errorText(err, kind === 'pdf' ? 'Could not create the PDF.' : 'Could not create the Word file.'));
      } finally {
        setExporting(null);
      }
    },
    [design, exporting, doc, letter],
  );

  if (store.loading || !design || !store.catalog) {
    return (
      <div className="h-full">
        <PageTitle title="Resume studio" />
        <BrandedLoader label={store.error ?? 'Opening the studio…'} />
      </div>
    );
  }

  const { catalog, profile } = store;
  const previewProfile = effectiveProfile(profile, design.content);
  const activeResume = store.resumes.find((r) => r.id === store.activeResumeId) ?? null;
  const hasLetter = Boolean(letter && letter.trim());

  const panels: Record<Tab, ReactNode> = {
    theme: (
      <>
        <ThemeGallery themes={catalog.themes} design={design} onApply={store.applyTheme} />
        <ColorControls
          design={design}
          presets={catalog.color_presets}
          onChange={store.updateColors}
          onApplyPreset={store.applyColorPreset}
        />
      </>
    ),
    type: (
      <>
        <TypographyControls design={design} fonts={catalog.fonts} onChange={store.updateTypography} />
        <LayoutControls design={design} onLayout={store.updateLayout} onSections={store.updateSectionOptions} />
        <HeaderImageControls design={design} image={design.layout.header_image} onChange={store.setHeaderImage} />
      </>
    ),
    sections: (
      <>
        <SectionManager design={design} onToggle={store.toggleSection} onMove={store.moveSection} />
        {catalog.summary_styles?.length > 0 && (
          <SummaryStyleGallery styles={catalog.summary_styles} design={design} onApply={store.applySummaryStyle} />
        )}
        {catalog.skills_styles?.length > 0 && (
          <SkillsStyleGallery styles={catalog.skills_styles} design={design} onApply={store.applySkillsStyle} />
        )}
        {catalog.experience_styles?.length > 0 && (
          <ExperienceStyleGallery
            styles={catalog.experience_styles}
            design={design}
            onApply={store.applyExperienceStyle}
          />
        )}
        <ExperienceControls style={design.sections.experience_style} onChange={store.updateExperienceStyle} />
        <EducationControls style={design.sections.education_style} onChange={store.updateEducationStyle} />
        <CertificatesControls style={design.sections.certificates_style} onChange={store.updateCertificatesStyle} />
      </>
    ),
    content:
      doc === 'letter' ? (
        <ControlCard icon={Mail} title="Cover letter">
          <p className="text-xs text-muted-foreground">
            Separate paragraphs with a blank line. The letter uses this resume&apos;s letterhead and theme.
          </p>
          <Textarea
            value={letter ?? ''}
            onChange={(e) => onLetterChange(e.target.value)}
            className="min-h-[28rem] text-sm leading-relaxed"
            aria-label="Cover letter text"
          />
          <p className="text-[11px] text-muted-foreground">{letterSaving ? 'Saving…' : 'Changes save automatically.'}</p>
        </ControlCard>
      ) : (
        <ContentControls
          content={design.content ? normalizeResumeContent(design.content) : profileToContent(profile)}
          onChange={store.setContent}
        />
      ),
  };

  const controlPanel = (
    <aside className="flex min-h-0 min-w-0 flex-col border-r bg-background max-lg:border-r-0">
      <div role="tablist" aria-label="Studio panels" className="grid shrink-0 grid-cols-4 gap-1 border-b p-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              tab === id ? 'bg-brand-soft text-brand' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            <span className="max-w-full truncate">{label}</span>
          </button>
        ))}
      </div>
      <div className="builder-scroll min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">{panels[tab]}</div>
    </aside>
  );

  const canvas = (
    <section className="relative flex min-h-0 min-w-0 flex-col bg-muted/60" aria-label="Live pages">
      <div ref={setCanvasEl} className="studio-canvas scrollbar-thin min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto w-max">
          <ResumePageStack
            key={doc}
            design={design}
            profile={previewProfile}
            letter={letterBody}
            displayWidth={Math.round(nativeW * scale)}
            gap={24}
            idPrefix="studio-page"
            onPageCount={setPageCount}
            onMeasureHeader={doc === 'resume' ? store.setHeaderMetrics : undefined}
            onMeasureLayout={doc === 'resume' ? store.setLayoutMetrics : undefined}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur">
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Zoom out" onClick={() => stepZoom(-1)}>
            <Minus />
          </Button>
          <button
            type="button"
            onClick={() => setZoom('fit')}
            title="Fit to width (Ctrl+0)"
            className={cn(
              'h-7 min-w-14 rounded-full px-2 text-xs font-medium tabular-nums transition hover:bg-muted',
              zoom === 'fit' && 'text-brand',
            )}
          >
            {Math.round(scale * 100)}%
          </button>
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Zoom in" onClick={() => stepZoom(1)}>
            <Plus />
          </Button>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <span className="px-2 text-xs text-muted-foreground tabular-nums">
            {pageCount} {pageCount === 1 ? 'page' : 'pages'} · {PAPER_SIZES[paper].label}
          </span>
        </div>
      </div>
    </section>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageTitle title="Resume studio" />

      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2.5 sm:px-4">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-9 min-w-0 max-w-[18rem] flex-1 items-center sm:flex-none gap-2 rounded-lg px-2 text-left outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-muted"
            aria-label="Switch resume"
          >
            <LayoutTemplate className="size-4 shrink-0 text-brand" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{activeResume?.name ?? 'My resume'}</span>
            </span>
            {store.switchingResume ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 min-w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">Your resumes</DropdownMenuLabel>
              {store.resumes.map((r) => (
                <DropdownMenuItem key={r.id} onClick={() => void store.switchResume(r.id)}>
                  <FileText />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {r.id === store.activeResumeId && <span className="text-[10px] font-semibold text-brand">Editing</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/app/documents" />}>
              <FileType2 />
              All documents
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {hasLetter && (
          <div role="group" aria-label="Document" className="order-3 inline-flex rounded-lg border bg-muted p-0.5 sm:order-none">
            {(['resume', 'letter'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setDoc(k)}
                aria-pressed={doc === k}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition',
                  doc === k ? 'bg-card text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {k === 'resume' ? 'Resume' : 'Cover letter'}
              </button>
            ))}
          </div>
        )}

        <div className="order-3 flex min-w-0 flex-wrap items-center gap-1.5 sm:order-none sm:ml-auto sm:justify-end sm:gap-2">
          <div role="group" aria-label="Paper size" className="inline-flex rounded-lg border bg-muted p-0.5">
            {(['letter', 'a4'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => store.updateLayout({ paper: p })}
                aria-pressed={paper === p}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition',
                  paper === p ? 'bg-card text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {p === 'letter' ? 'Letter' : 'A4'}
              </button>
            ))}
          </div>

          <Toolbar
            dirty={dirty}
            saving={store.saving}
            ready={store.ready}
            savingTheme={store.savingTheme}
            compact
            onReset={store.resetToSaved}
            onSaveTheme={(name) => store.saveCurrentAsTheme(name)}
          />

        </div>

        <div className="order-2 inline-flex sm:order-none">
          <Button className="rounded-r-none" onClick={() => void exportAs('pdf')} disabled={exporting != null}>
            {exporting === 'pdf' ? <Loader2 className="animate-spin" /> : <Download />}
            PDF
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button className="rounded-l-none border-l border-l-primary-foreground/20 px-2" aria-label="More download formats" disabled={exporting != null} />
              }
            >
              {exporting === 'docx' ? <Loader2 className="animate-spin" /> : <ChevronDown />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-64">
              <DropdownMenuItem onClick={() => void exportAs('pdf')}>
                <Download />
                <span className="flex flex-col">
                  <span>PDF</span>
                  <span className="text-xs text-muted-foreground">Exactly what you see here</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportAs('docx')}>
                <FileType2 />
                <span className="flex flex-col">
                  <span>Word (editable)</span>
                  <span className="text-xs text-muted-foreground">Same design, spacing may shift in Word</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {(store.saveError || store.themeError || exportError || store.profileWorkCount === 0) && (
        <div className="shrink-0 space-y-2 border-b bg-background px-3 py-2 sm:px-4">
          {[store.saveError, store.themeError, exportError].filter(Boolean).map((msg) => (
            <p key={msg} className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {msg}
            </p>
          ))}
          {store.profileWorkCount === 0 && (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-status-preparing" />
              <span>
                Add work experience on your <Link to="/app/profile" className="font-medium text-brand underline-offset-2 hover:underline">Profile</Link> to fill the experience section.
              </span>
            </p>
          )}
        </div>
      )}

      <div className="flex shrink-0 border-b p-1.5 lg:hidden">
        <div role="group" aria-label="Studio view" className="grid w-full grid-cols-2 gap-1 rounded-lg bg-muted p-0.5">
          {(
            [
              ['edit', 'Edit', SlidersHorizontal],
              ['preview', 'Preview', ScanEye],
            ] as const
          ).map(([v, label, Icon]) => (
            <button
              key={v}
              type="button"
              aria-pressed={mobileView === v}
              onClick={() => setMobileView(v)}
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition',
                mobileView === v ? 'bg-card text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground',
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]">
        <div className={cn('min-h-0', mobileView === 'edit' ? 'flex' : 'hidden', 'flex-col lg:flex')}>{controlPanel}</div>
        <div className={cn('min-h-0', mobileView === 'preview' ? 'flex' : 'hidden', 'flex-col lg:flex')}>{canvas}</div>
      </div>
    </div>
  );
}
