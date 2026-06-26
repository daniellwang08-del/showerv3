import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Loader2, Mail, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { PageScrollArea } from '../components/layout/PageScrollArea';
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
import { ResumePageStack, RESUME_REF_WIDTH } from '../components/resumeBuilder/PagedResumePreview';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
import { Toolbar } from '../components/resumeBuilder/Toolbar';
import { selectIsDirty, useResumeBuilderStore } from '../stores/resumeBuilderStore';
import { previewResumeDesignPdf } from '../api/resumeDesignApi';
import { downloadResumeTemplatePreview } from '../api/resumeTemplateApi';
import { generateCoverLetterFromResumeDesign } from '../api/coverLetterTemplateApi';

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

  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [previewPageCount, setPreviewPageCount] = useState(1);
  const [zoom, setZoom] = useState(1);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [previewWidth, setPreviewWidth] = useState(0);
  const [coverState, setCoverState] = useState<{ loading: boolean; msg: string | null; ok: boolean }>({
    loading: false,
    msg: null,
    ok: false,
  });

  useEffect(() => {
    void store.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
    const update = () => setPreviewWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handlePreview = useCallback(async () => {
    if (!store.design) return;
    setPreviewing(true);
    setPreviewError(null);
    setPreviewOpen(true);
    try {
      const blob = await previewResumeDesignPdf(store.design);
      const url = URL.createObjectURL(blob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (err) {
      setPreviewError(errorDetail(err, 'Could not generate the PDF preview.'));
    } finally {
      setPreviewing(false);
    }
  }, [store.design]);

  const handleDownload = useCallback(async () => {
    if (!store.design) return;
    setDownloading(true);
    try {
      if (dirty) await store.save();
      const blob = await downloadResumeTemplatePreview();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'resume-template.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    } finally {
      setDownloading(false);
    }
  }, [store, dirty]);

  const handleGenerateCoverLetter = useCallback(async () => {
    setCoverState({ loading: true, msg: null, ok: false });
    try {
      if (dirty) await store.save();
      await generateCoverLetterFromResumeDesign();
      setCoverState({ loading: false, ok: true, msg: 'Cover letter template generated from this theme.' });
    } catch (err) {
      setCoverState({ loading: false, ok: false, msg: errorDetail(err, 'Could not generate the cover letter template.') });
    }
  }, [store, dirty]);

  if (store.loading || !store.design || !store.catalog) {
    return (
      <PageScrollArea>
        <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
          <Loader2 size={18} className="animate-spin text-blue-500" />
          {store.error ?? 'Loading resume builder…'}
        </div>
      </PageScrollArea>
    );
  }

  const { design, catalog, profile } = store;

  const baseWidth = Math.min((previewWidth || RESUME_REF_WIDTH) - 4, RESUME_REF_WIDTH);
  const mainDisplayWidth = Math.max(240, baseWidth * zoom);
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 10) / 10));
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 10) / 10));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 px-5 pt-5">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white">
              <FileText size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 md:text-3xl">Resume Builder</h1>
              <p className="mt-0.5 text-sm text-slate-600">
                Pick a theme and fine-tune styling. Changes save automatically and update your active resume template.
              </p>
            </div>
          </div>
          <Toolbar
            dirty={dirty}
            saving={store.saving}
            previewing={previewing}
            downloading={downloading}
            ready={store.ready}
            onReset={store.resetToSaved}
            onPreview={() => void handlePreview()}
            onDownload={() => void handleDownload()}
          />
        </div>

        {store.saveError && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle size={15} />
            {store.saveError}
          </div>
        )}
        {store.profileWorkCount === 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertCircle size={15} />
            Add work experience in your Profile so the builder can create experience slots.
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <Mail size={16} className="text-indigo-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-800">Matching cover letter</p>
            <p className="text-xs text-slate-500">
              Generate a cover letter template that reuses this theme. Saves the current design first.
            </p>
          </div>
          {coverState.msg && (
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                coverState.ok ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {coverState.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
              {coverState.msg}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleGenerateCoverLetter()}
            disabled={coverState.loading}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
          >
            {coverState.loading ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
            Generate
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-y-auto px-5 pb-5 lg:grid-cols-[minmax(280px,320px)_minmax(0,1fr)_auto] lg:overflow-hidden lg:[grid-template-rows:minmax(0,1fr)]">
        <div className="builder-scroll min-w-0 space-y-4 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-2">
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
              <ExperienceStyleGallery styles={catalog.experience_styles} design={design} onApply={store.applyExperienceStyle} />
            )}
            <ExperienceControls style={design.sections.experience_style} onChange={store.updateExperienceStyle} />
            <EducationControls style={design.sections.education_style} onChange={store.updateEducationStyle} />
            <CertificatesControls style={design.sections.certificates_style} onChange={store.updateCertificatesStyle} />
            <SectionManager design={design} onToggle={store.toggleSection} onMove={store.moveSection} />
          </div>

          <div className="flex min-w-0 flex-col lg:min-h-0">
            <div className="flex flex-col rounded-2xl border border-slate-200 bg-slate-100 p-3 shadow-inner sm:p-4 lg:min-h-0 lg:flex-1">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Live preview</span>
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                    {previewPageCount} page{previewPageCount === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
                  <button
                    type="button"
                    onClick={zoomOut}
                    disabled={zoom <= ZOOM_MIN}
                    aria-label="Zoom out"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ZoomOut size={15} />
                  </button>
                  <span className="w-11 text-center text-xs font-semibold tabular-nums text-slate-700">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={zoomIn}
                    disabled={zoom >= ZOOM_MAX}
                    aria-label="Zoom in"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ZoomIn size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom(1)}
                    disabled={zoom === 1}
                    aria-label="Reset zoom"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCcw size={14} />
                  </button>
                </div>
              </div>
              <div ref={previewBoxRef} className="builder-scroll overflow-auto lg:min-h-0 lg:flex-1">
                <div className="mx-auto w-max">
                  <ResumePageStack
                    design={design}
                    profile={profile}
                    displayWidth={mainDisplayWidth}
                    idPrefix="resume-page"
                    onPageCount={setPreviewPageCount}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Page thumbnail rail (like the slide list in PowerPoint) */}
          <aside className="hidden lg:flex lg:min-h-0 lg:flex-col">
            <div className="flex flex-col rounded-2xl border border-slate-200 bg-slate-100 p-2 shadow-inner lg:min-h-0 lg:flex-1">
              <div className="px-1 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Pages
              </div>
              <div className="builder-scroll flex flex-col items-center gap-3 overflow-y-auto px-1 pb-1 lg:min-h-0 lg:flex-1">
                <ResumePageStack
                  design={design}
                  profile={profile}
                  displayWidth={132}
                  gap={12}
                  onSelect={(i) =>
                    document
                      .getElementById(`resume-page-${i}`)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                />
              </div>
            </div>
          </aside>
        </div>

      {previewOpen && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-[3px]"
            onClick={() => setPreviewOpen(false)}
            aria-hidden="true"
          />
          <div className="relative z-10 flex h-[90vh] w-[88vw] min-w-[640px] max-w-[1100px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-800">Accurate PDF preview</h2>
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
              {previewing && (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
                  <Loader2 size={20} className="animate-spin text-blue-500" />
                  Rendering document…
                </div>
              )}
              {previewError && !previewing && (
                <div className="flex h-full items-center justify-center px-8 text-center text-sm text-red-600">
                  {previewError}
                </div>
              )}
              {previewUrl && !previewing && !previewError && (
                <iframe title="Resume PDF preview" src={previewUrl} className="h-full w-full border-0 bg-white" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
