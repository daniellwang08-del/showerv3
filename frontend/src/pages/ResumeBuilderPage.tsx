import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  FileText,
  Loader2,
  Maximize2,
  X,
} from 'lucide-react';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { PageHeader } from '../components/layout/PageHeader';
import { BrandedLoader } from '../components/layout/BrandedLoader';
import { ThemeGallery } from '../components/resumeBuilder/ThemeGallery';
import { TypographyControls } from '../components/resumeBuilder/TypographyControls';
import { ColorControls } from '../components/resumeBuilder/ColorControls';
import { LayoutControls } from '../components/resumeBuilder/LayoutControls';
import { HeaderImageControls } from '../components/resumeBuilder/HeaderImageControls';
import { SummaryStyleGallery } from '../components/resumeBuilder/SummaryStyleGallery';
import { SkillsStyleGallery } from '../components/resumeBuilder/SkillsStyleGallery';
import { ExperienceStyleGallery } from '../components/resumeBuilder/ExperienceStyleGallery';
import { ExperienceControls } from '../components/resumeBuilder/ExperienceControls';
import { EducationControls } from '../components/resumeBuilder/EducationControls';
import { CertificatesControls } from '../components/resumeBuilder/CertificatesControls';
import { SectionManager } from '../components/resumeBuilder/SectionManager';
import { ResumePageStack } from '../components/resumeBuilder/PagedResumePreview';
import { ResumePdfEmbed } from '../components/resumeBuilder/ResumePdfEmbed';
import { Toolbar } from '../components/resumeBuilder/Toolbar';
import { selectIsDirty, useResumeBuilderStore } from '../stores/resumeBuilderStore';
import { effectiveProfile, normalizeResumeContent, profileToContent } from '../utils/resumeContent';
import { ContentControls } from '../components/resumeBuilder/ContentControls';
import { ResumeLibraryPanel } from '../components/resumeBuilder/ResumeLibraryPanel';
import { OneClickAICenter, OneClickAILauncher } from '../components/resumeBuilder/OneClickAICenter';
import { previewResumeDesignPdf } from '../api/resumeDesignApi';

/** Wait for style/content edits (and metric settle) before re-running compile→dxpdf. */
const PREVIEW_DEBOUNCE_MS = 450;

interface AxiosLikeError {
  response?: { status?: number; data?: { detail?: string } };
}

function errorDetail(err: unknown, fallback: string): string {
  const e = err as AxiosLikeError;
  return e?.response?.data?.detail || fallback;
}

export function ResumeBuilderPage() {
  const store = useResumeBuilderStore();
  const dirty = useResumeBuilderStore(selectIsDirty);

  const panelTab = useResumeBuilderStore((s) => s.panelTab);
  const setPanelTab = useResumeBuilderStore((s) => s.setPanelTab);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

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

  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const previewGenRef = useRef(0);

  /** Debounced real PDF — primary preview source of truth. */
  useEffect(() => {
    if (!store.design) return;
    const design = store.design;
    const gen = ++previewGenRef.current;
    setPreviewing(true);
    setPreviewError(null);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const preview = await previewResumeDesignPdf(design);
          if (gen !== previewGenRef.current) return;
          setPreviewUrl((prev) => {
            if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
            return preview.url;
          });
          setPreviewError(null);
        } catch (err) {
          if (gen !== previewGenRef.current) return;
          const aborted = err instanceof DOMException && err.name === 'AbortError';
          if (!aborted) {
            setPreviewError(errorDetail(err, 'Could not render the PDF preview.'));
          }
        } finally {
          if (gen === previewGenRef.current) setPreviewing(false);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [store.design]);

  const handleRefreshPreview = useCallback(async () => {
    if (!store.design) return;
    const gen = ++previewGenRef.current;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const preview = await previewResumeDesignPdf(store.design);
      if (gen !== previewGenRef.current) return;
      setPreviewUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return preview.url;
      });
    } catch (err) {
      if (gen !== previewGenRef.current) return;
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      if (!aborted) {
        setPreviewError(errorDetail(err, 'Could not render the PDF preview.'));
      }
    } finally {
      if (gen === previewGenRef.current) setPreviewing(false);
    }
  }, [store.design]);

  if (store.loading || !store.design || !store.catalog) {
    return (
      <PageScrollArea>
        <BrandedLoader label={store.error ?? 'Loading resume builder…'} />
      </PageScrollArea>
    );
  }

  const { design, catalog, profile } = store;
  const previewProfile = effectiveProfile(profile, design.content);

  const editPanel = (
    <div className="builder-scroll min-h-0 min-w-0 space-y-3 overflow-y-auto overscroll-contain pr-0.5 sm:space-y-4 lg:h-full lg:pr-1">
      <div className="sticky top-0 z-20 space-y-2.5 bg-slate-50/95 pb-1 backdrop-blur-sm dark:bg-transparent">
        <OneClickAILauncher compact />
        <div className="inline-flex w-full rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {(['style', 'content'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setPanelTab(tab)}
              className={`min-h-10 flex-1 rounded-lg px-2 py-2 text-sm font-semibold capitalize transition sm:px-3 ${
                panelTab === tab
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab === 'style' ? 'Style' : 'Content'}
            </button>
          ))}
        </div>
      </div>

      {panelTab === 'content' ? (
        <ContentControls
          content={design.content ? normalizeResumeContent(design.content) : profileToContent(profile)}
          onChange={store.setContent}
        />
      ) : (
        <>
          <ThemeGallery themes={catalog.themes} design={design} onApply={store.applyTheme} />
          <TypographyControls design={design} fonts={catalog.fonts} onChange={store.updateTypography} />
          <ColorControls
            design={design}
            presets={catalog.color_presets}
            onChange={store.updateColors}
            onApplyPreset={store.applyColorPreset}
          />
          <LayoutControls design={design} onLayout={store.updateLayout} onSections={store.updateSectionOptions} />
          <HeaderImageControls design={design} image={design.layout.header_image} onChange={store.setHeaderImage} />
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
          <CertificatesControls
            style={design.sections.certificates_style}
            onChange={store.updateCertificatesStyle}
          />
          <SectionManager design={design} onToggle={store.toggleSection} onMove={store.moveSection} />
        </>
      )}
    </div>
  );

  const resumesRail = (
    <div className="min-h-0 min-w-0 lg:h-full">
      <ResumeLibraryPanel />
    </div>
  );

  const previewPanel = (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden lg:h-full lg:min-w-0">
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 p-2 shadow-inner sm:p-2.5 lg:p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 sm:text-xs">
              PDF preview
            </span>
            {previewing ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-600">
                <Loader2 size={11} className="animate-spin" />
                Updating…
              </span>
            ) : (
              <span className="hidden text-[10px] text-slate-400 sm:inline">
                Native PDF · same file as export
              </span>
            )}
          </div>
        </div>

        <div className="relative min-h-0 min-w-0 w-full flex-1 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200/80">
          {previewError && !previewUrl && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-red-600">{previewError}</p>
              <button
                type="button"
                onClick={() => void handleRefreshPreview()}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Retry
              </button>
            </div>
          )}
          {!previewError && !previewUrl && previewing && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 size={20} className="animate-spin text-blue-500" />
              Rendering PDF…
            </div>
          )}
          {previewUrl && (
            <div className={`h-full w-full ${previewing ? 'opacity-90' : ''}`}>
              <ResumePdfEmbed url={previewUrl} />
            </div>
          )}
          {previewError && previewUrl && (
            <div className="absolute bottom-2 left-1/2 z-10 w-[min(100%-1rem,24rem)] -translate-x-1/2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs text-amber-800 shadow-sm">
              {previewError} — showing last good PDF.{' '}
              <button type="button" className="font-semibold underline" onClick={() => void handleRefreshPreview()}>
                Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Offscreen HTML measure pass — feeds header/layout metrics into the PDF compiler. */}
      <ResumePageStack
        design={design}
        profile={previewProfile}
        displayWidth={816}
        measureOnly
        onMeasureHeader={store.setHeaderMetrics}
        onMeasureLayout={store.setLayoutMetrics}
      />

      <div className="shrink-0 space-y-3 px-3 pt-3 sm:space-y-3.5 sm:px-5 sm:pt-4">
        <PageHeader
          icon={FileText}
          gradient="from-blue-600 to-indigo-600"
          title="Resume Builder"
          description="Style and edit this resume. Preview is the real PDF. Changes auto-save after a short pause."
          actions={
            <Toolbar
              dirty={dirty}
              saving={store.saving}
              previewing={previewing}
              ready={store.ready}
              savingTheme={store.savingTheme}
              onReset={store.resetToSaved}
              onPreview={() => setPreviewOpen(true)}
              onSaveTheme={(name) => store.saveCurrentAsTheme(name)}
            />
          }
        />

        {store.saveError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{store.saveError}</span>
          </div>
        )}
        {store.themeError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{store.themeError}</span>
          </div>
        )}
        {store.profileWorkCount === 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              Add work experience in your Profile so the builder can create experience slots.
            </span>
          </div>
        )}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden px-3 pb-3 pt-3 sm:px-5 sm:pb-4">
        <div className="grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[minmax(12rem,2.5fr)_minmax(0,6fr)_minmax(8rem,1.5fr)] gap-3 sm:gap-4 lg:grid-cols-[minmax(0,2.5fr)_minmax(0,6fr)_minmax(0,1.5fr)] lg:grid-rows-1 xl:gap-4">
          {editPanel}
          {previewPanel}
          {resumesRail}
        </div>
      </div>

      {previewOpen && (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center p-3 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-[3px]"
            onClick={() => setPreviewOpen(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 flex h-[min(92dvh,980px)] w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10 sm:w-[min(94vw,1100px)]">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Maximize2 size={15} className="text-slate-400" />
                Fullscreen PDF
              </h2>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
              >
                <X size={16} />
              </button>
            </header>
            <div className="min-h-0 flex-1 bg-slate-100">
              {previewing && !previewUrl && (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
                  <Loader2 size={20} className="animate-spin text-blue-500" />
                  Rendering document…
                </div>
              )}
              {previewError && !previewUrl && (
                <div className="flex h-full items-center justify-center px-8 text-center text-sm text-red-600">
                  {previewError}
                </div>
              )}
              {previewUrl && <ResumePdfEmbed url={previewUrl} />}
            </div>
          </div>
        </div>
      )}

      <OneClickAICenter />
    </div>
  );
}
