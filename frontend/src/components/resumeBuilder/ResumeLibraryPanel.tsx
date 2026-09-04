import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Loader2,
  CheckCircle2,
  Sparkles,
  Search,
  ChevronDown,
  Briefcase,
} from 'lucide-react';
import type { ResumeLibraryItem, ResumeSearchHit } from '../../types/resumeLibrary';
import { searchResumeLibrary } from '../../api/resumeLibraryApi';
import { useResumeBuilderStore } from '../../stores/resumeBuilderStore';
import { profileToContent } from '../../utils/resumeContent';

/** Prefer company for the rail label; fall back to resume name. */
function displayLabel(item: Pick<ResumeLibraryItem, 'company' | 'name'>): string {
  const company = item.company?.trim();
  if (company) return company;
  return item.name?.trim() || 'Untitled';
}

function displaySub(item: Pick<ResumeLibraryItem, 'company' | 'name' | 'job_title'>): string | null {
  const company = item.company?.trim();
  const title = item.job_title?.trim();
  if (company && title) return title;
  if (company && item.name?.trim() && item.name.trim() !== company) return item.name.trim();
  if (!company && title) return title;
  return null;
}

function ResumeRailRow({ item }: { item: ResumeLibraryItem }) {
  const activeId = useResumeBuilderStore((s) => s.activeResumeId);
  const switching = useResumeBuilderStore((s) => s.switchingResume);
  const switchingId = useResumeBuilderStore((s) => s.switchingResumeId);
  const switchResume = useResumeBuilderStore((s) => s.switchResume);
  const renameResume = useResumeBuilderStore((s) => s.renameResume);
  const removeResume = useResumeBuilderStore((s) => s.removeResume);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isActive = item.id === activeId;
  const isLoading = switchingId === item.id;
  const label = displayLabel(item);
  const sub = displaySub(item);
  const completed = item.status === 'completed';

  const submitRename = () => {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== item.name) void renameResume(item.id, name);
    else setDraft(item.name);
  };

  const select = () => {
    if (isActive || switching || renaming) return;
    void switchResume(item.id);
  };

  return (
    <div
      className={`group relative overflow-hidden rounded-lg border transition ${
        isActive || isLoading
          ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200'
          : 'border-transparent bg-transparent hover:border-slate-200 hover:bg-white'
      }`}
    >
      {renaming ? (
        <div className="flex items-center gap-0.5 px-1.5 py-1.5">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') {
                setRenaming(false);
                setDraft(item.name);
              }
            }}
            className="min-w-0 flex-1 rounded border border-blue-300 bg-white px-1 py-0.5 text-[11px] text-slate-800 outline-none focus:ring-1 focus:ring-blue-200"
          />
          <button type="button" onClick={submitRename} className="rounded p-0.5 text-emerald-600 hover:bg-emerald-50" aria-label="Save name">
            <Check size={12} />
          </button>
          <button
            type="button"
            onClick={() => {
              setRenaming(false);
              setDraft(item.name);
            }}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100"
            aria-label="Cancel rename"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={select}
          disabled={isActive || switching}
          title={isActive ? 'Currently editing' : isLoading ? `Loading ${label}…` : `Open ${label}`}
          className="flex w-full flex-col items-stretch gap-0.5 px-2 py-2 text-left disabled:cursor-default"
        >
          <span className="flex items-center gap-1">
            <span className="truncate text-[12px] font-semibold leading-tight text-slate-800" title={label}>
              {label}
            </span>
            {isLoading ? (
              <Loader2 size={11} className="shrink-0 animate-spin text-blue-600" />
            ) : isActive ? (
              <span className="shrink-0 rounded bg-blue-600 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-white">
                On
              </span>
            ) : null}
          </span>
          {sub && (
            <span className="truncate text-[10px] leading-tight text-slate-500" title={sub}>
              {sub}
            </span>
          )}
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            {completed && (
              <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-emerald-600">
                <CheckCircle2 size={9} /> Done
              </span>
            )}
            {item.source === 'tailored' && (
              <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-indigo-600">
                <Sparkles size={9} /> AI
              </span>
            )}
          </span>
        </button>
      )}

      {!renaming && (
        <div className="flex items-center justify-center gap-0.5 border-t border-slate-100/80 px-1 py-1 opacity-70 transition group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDraft(item.name);
              setRenaming(true);
            }}
            disabled={switching}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
            title="Rename"
            aria-label="Rename"
          >
            <Pencil size={11} />
          </button>
          {confirmDelete ? (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(false);
                  void removeResume(item.id);
                }}
                className="rounded p-1 text-red-600 hover:bg-red-50"
                title="Confirm delete"
                aria-label="Confirm delete"
              >
                <Trash2 size={11} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(false);
                }}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
                title="Cancel"
                aria-label="Cancel delete"
              >
                <X size={11} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(true);
              }}
              disabled={switching}
              className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
              title="Delete"
              aria-label="Delete"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      )}

      {isLoading && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-blue-100" aria-hidden>
          <div className="resume-rail-loading-bar h-full w-1/3 rounded-full bg-blue-500" />
        </div>
      )}
    </div>
  );
}

function SearchResultRow({ hit }: { hit: ResumeSearchHit }) {
  const activeId = useResumeBuilderStore((s) => s.activeResumeId);
  const switching = useResumeBuilderStore((s) => s.switchingResume);
  const switchingId = useResumeBuilderStore((s) => s.switchingResumeId);
  const switchResume = useResumeBuilderStore((s) => s.switchResume);
  const openJobBuild = useResumeBuilderStore((s) => s.openJobBuild);

  const isJobBuild = hit.kind === 'job_build';
  const isActive = !isJobBuild && hit.id === activeId;
  const isLoading = switchingId === hit.id || (!!hit.build_id && switchingId === hit.build_id);
  const label = displayLabel(hit);
  const sub = displaySub(hit);

  const select = () => {
    if (isActive || switching) return;
    if (isJobBuild) {
      const buildId = hit.build_id || hit.id;
      void openJobBuild(buildId);
      return;
    }
    void switchResume(hit.id);
  };

  return (
    <button
      type="button"
      onClick={select}
      disabled={isActive || switching || !hit.content_ready}
      title={
        isActive
          ? 'Currently editing'
          : isLoading
            ? `Loading ${label}…`
            : isJobBuild
              ? `Open job resume · ${label}`
              : `Open ${label}`
      }
      className={`group relative flex w-full flex-col items-stretch gap-0.5 rounded-lg border px-2 py-2 text-left transition disabled:cursor-default ${
        isActive || isLoading
          ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200'
          : 'border-transparent bg-transparent hover:border-slate-200 hover:bg-white'
      }`}
    >
      <span className="flex items-center gap-1">
        <span className="truncate text-[12px] font-semibold leading-tight text-slate-800" title={label}>
          {label}
        </span>
        {isLoading ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-blue-600" />
        ) : isActive ? (
          <span className="shrink-0 rounded bg-blue-600 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-white">
            On
          </span>
        ) : null}
      </span>
      {sub && (
        <span className="truncate text-[10px] leading-tight text-slate-500" title={sub}>
          {sub}
        </span>
      )}
      <span className="mt-0.5 flex flex-wrap items-center gap-1">
        {isJobBuild ? (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-sky-700">
            <Briefcase size={9} /> Job
          </span>
        ) : hit.source === 'tailored' ? (
          <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-indigo-600">
            <Sparkles size={9} /> AI
          </span>
        ) : (
          <span className="text-[9px] font-semibold text-slate-500">Library</span>
        )}
      </span>
    </button>
  );
}

/** Narrow right-rail list of resumes with expandable search across library + job builds. */
export function ResumeLibraryPanel() {
  const resumes = useResumeBuilderStore((s) => s.resumes);
  const profile = useResumeBuilderStore((s) => s.profile);
  const design = useResumeBuilderStore((s) => s.design);
  const createResumeEntry = useResumeBuilderStore((s) => s.createResumeEntry);
  const [creating, setCreating] = useState(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [companyQuery, setCompanyQuery] = useState('');
  const [roleQuery, setRoleQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ResumeSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const companyInputRef = useRef<HTMLInputElement>(null);

  const onNew = async () => {
    if (!design) return;
    setCreating(true);
    try {
      const content = profileToContent(profile);
      await createResumeEntry({
        name: 'Untitled resume',
        design: { ...design, content },
        source: 'manual',
        status: 'draft',
        activate: true,
      });
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!searchOpen) return;
    const t = window.setTimeout(() => companyInputRef.current?.focus(), 220);
    return () => window.clearTimeout(t);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;

    const company = companyQuery.trim();
    const role = roleQuery.trim();
    if (!company && !role) {
      setSearchResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }

    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await searchResumeLibrary({
            company: company || undefined,
            job_title: role || undefined,
          });
          if (seq !== searchSeq.current) return;
          setSearchResults(res.resumes);
        } catch {
          if (seq !== searchSeq.current) return;
          setSearchResults([]);
          setSearchError('Search failed. Try again.');
        } finally {
          if (seq === searchSeq.current) setSearching(false);
        }
      })();
    }, 280);

    return () => window.clearTimeout(timer);
  }, [companyQuery, roleQuery, searchOpen]);

  const hasQuery = Boolean(companyQuery.trim() || roleQuery.trim());

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="shrink-0 border-b border-slate-200 px-2 py-2">
        <div className="flex items-center justify-between gap-1">
          <p className="truncate text-[11px] font-bold uppercase tracking-wide text-slate-500">Resumes</p>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              title={searchOpen ? 'Hide search' : 'Search resumes'}
              aria-label={searchOpen ? 'Hide search' : 'Search resumes'}
              aria-expanded={searchOpen}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition ${
                searchOpen
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              {searchOpen ? <ChevronDown size={13} /> : <Search size={13} />}
            </button>
            <button
              type="button"
              onClick={() => void onNew()}
              disabled={creating}
              title="New resume"
              aria-label="New resume"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-blue-600 text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-60"
            >
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            </button>
          </div>
        </div>
        <p className="mt-1 text-[10px] font-medium leading-snug text-slate-500">
          Click a resume to edit it. Search by company or role, or tap + to add a new version.
        </p>
      </div>

      <div
        className={`grid min-h-0 shrink-0 transition-[grid-template-rows] duration-300 ease-out ${
          searchOpen ? 'grid-rows-[1fr] basis-1/2' : 'grid-rows-[0fr] basis-0'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col border-b border-slate-200 bg-slate-50/80">
            <div className="shrink-0 space-y-1.5 px-2 pb-1.5 pt-2">
              <label className="block">
                <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                  Company
                </span>
                <input
                  ref={companyInputRef}
                  value={companyQuery}
                  onChange={(e) => setCompanyQuery(e.target.value)}
                  placeholder="e.g. Impruvon"
                  className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                  Role
                </span>
                <input
                  value={roleQuery}
                  onChange={(e) => setRoleQuery(e.target.value)}
                  placeholder="e.g. Software Engineer"
                  className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                />
              </label>
              <p className="text-[9px] leading-snug text-slate-500">
                Library + job workflow · both fields when filled
              </p>
            </div>
            <div className="builder-scroll min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
              {searching ? (
                <div className="flex items-center justify-center gap-1.5 py-4 text-[10px] text-slate-500">
                  <Loader2 size={12} className="animate-spin" />
                  Searching…
                </div>
              ) : searchError ? (
                <p className="px-1.5 py-3 text-center text-[10px] text-rose-600">{searchError}</p>
              ) : !hasQuery ? (
                <p className="px-1.5 py-3 text-center text-[10px] leading-snug text-slate-500">
                  Type a company or role to search.
                </p>
              ) : searchResults.length === 0 ? (
                <p className="px-1.5 py-3 text-center text-[10px] leading-snug text-slate-500">
                  No resumes match.
                </p>
              ) : (
                searchResults.map((hit) => (
                  <SearchResultRow key={`${hit.kind}-${hit.id}`} hit={hit} />
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="builder-scroll min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain p-1.5">
        {resumes.length === 0 ? (
          <p className="px-1.5 py-4 text-center text-[10px] leading-snug text-slate-500">
            No resumes yet. Tap + or tailor with OneClick AI.
          </p>
        ) : (
          resumes.map((item) => <ResumeRailRow key={item.id} item={item} />)
        )}
      </div>
    </aside>
  );
}
