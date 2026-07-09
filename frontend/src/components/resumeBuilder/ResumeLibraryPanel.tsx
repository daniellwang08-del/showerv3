import { useState } from 'react';
import {
  Plus,
  Copy,
  Trash2,
  Pencil,
  Check,
  X,
  Loader2,
  CircleDot,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import type { UserProfile } from '../../types/profile';
import type { ResumeDesign } from '../../types/resumeDesign';
import type { ResumeLibraryItem } from '../../types/resumeLibrary';
import { useResumeBuilderStore } from '../../stores/resumeBuilderStore';
import { effectiveProfile, profileToContent } from '../../utils/resumeContent';
import { ResumePreview } from './ResumePreview';
import { RESUME_REF_WIDTH } from './PagedResumePreview';

const LETTER_RATIO = 11 / 8.5;
const THUMB_WIDTH = 116;

/** A small, non-interactive top-of-page snapshot of a resume design (client-rendered,
 *  no server image). Renders the live preview at native width and scales it down. */
function ResumeThumb({ design, profile }: { design: ResumeDesign; profile: UserProfile | null }) {
  const scale = THUMB_WIDTH / RESUME_REF_WIDTH;
  return (
    <div
      className="shrink-0 overflow-hidden rounded-md bg-white ring-1 ring-slate-900/10"
      style={{ width: THUMB_WIDTH, height: THUMB_WIDTH * LETTER_RATIO }}
    >
      <div
        style={{ width: RESUME_REF_WIDTH, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        aria-hidden="true"
      >
        <ResumePreview design={design} profile={profile} />
      </div>
    </div>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function ResumeCard({ item, profile }: { item: ResumeLibraryItem; profile: UserProfile | null }) {
  const activeId = useResumeBuilderStore((s) => s.activeResumeId);
  const switching = useResumeBuilderStore((s) => s.switchingResume);
  const switchResume = useResumeBuilderStore((s) => s.switchResume);
  const renameResume = useResumeBuilderStore((s) => s.renameResume);
  const setResumeStatus = useResumeBuilderStore((s) => s.setResumeStatus);
  const duplicateResumeEntry = useResumeBuilderStore((s) => s.duplicateResumeEntry);
  const removeResume = useResumeBuilderStore((s) => s.removeResume);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isActive = item.id === activeId;
  const thumbProfile = effectiveProfile(profile, item.design.content);
  const completed = item.status === 'completed';

  const submitRename = () => {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== item.name) void renameResume(item.id, name);
    else setDraft(item.name);
  };

  return (
    <div
      className={`rounded-xl border bg-white p-2.5 shadow-sm transition ${
        isActive ? 'border-blue-400 ring-2 ring-blue-200' : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => !isActive && void switchResume(item.id)}
          disabled={isActive || switching}
          title={isActive ? 'Currently editing' : 'Open in the builder'}
          className="relative shrink-0 rounded-md transition disabled:cursor-default enabled:hover:opacity-90"
        >
          <ResumeThumb design={item.design} profile={thumbProfile} />
          {isActive && (
            <span className="absolute left-1 top-1 rounded bg-blue-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm">
              Editing
            </span>
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col">
          {renaming ? (
            <div className="flex items-center gap-1">
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
                className="min-w-0 flex-1 rounded-md border border-blue-300 px-1.5 py-1 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-200"
              />
              <button type="button" onClick={submitRename} className="rounded p-1 text-emerald-600 hover:bg-emerald-50" aria-label="Save name">
                <Check size={14} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenaming(false);
                  setDraft(item.name);
                }}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
                aria-label="Cancel rename"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-1">
              <p className="truncate text-sm font-semibold text-slate-800" title={item.name}>
                {item.name}
              </p>
              <button
                type="button"
                onClick={() => {
                  setDraft(item.name);
                  setRenaming(true);
                }}
                className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="Rename"
                title="Rename"
              >
                <Pencil size={13} />
              </button>
            </div>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void setResumeStatus(item.id, completed ? 'draft' : 'completed')}
              title={completed ? 'Mark as draft' : 'Mark as complete'}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition ${
                completed
                  ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                  : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
              }`}
            >
              {completed ? <CheckCircle2 size={11} /> : <CircleDot size={11} />}
              {completed ? 'Completed' : 'Draft'}
            </button>
            {item.source === 'tailored' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                <Sparkles size={10} /> Tailored
              </span>
            )}
          </div>

          {(item.job_title || item.company) && (
            <p className="mt-1 truncate text-[11px] text-slate-500" title={[item.job_title, item.company].filter(Boolean).join(' · ')}>
              {[item.job_title, item.company].filter(Boolean).join(' · ')}
            </p>
          )}
          <p className="mt-auto pt-1 text-[10px] text-slate-400">Updated {relativeTime(item.updated_at)}</p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1 border-t border-slate-100 pt-2">
        {!isActive && (
          <button
            type="button"
            onClick={() => void switchResume(item.id)}
            disabled={switching}
            className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700 transition hover:bg-blue-100 disabled:opacity-60"
          >
            {switching ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
            Edit
          </button>
        )}
        <button
          type="button"
          onClick={() => void duplicateResumeEntry(item.id)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100"
        >
          <Copy size={12} /> Duplicate
        </button>
        <div className="ml-auto">
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  void removeResume(item.id);
                }}
                className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 transition hover:bg-red-100"
              >
                <Trash2 size={12} /> Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-red-50 hover:text-red-600"
              aria-label="Delete resume"
            >
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ResumeLibraryPanel() {
  const resumes = useResumeBuilderStore((s) => s.resumes);
  const profile = useResumeBuilderStore((s) => s.profile);
  const design = useResumeBuilderStore((s) => s.design);
  const createResumeEntry = useResumeBuilderStore((s) => s.createResumeEntry);
  const [creating, setCreating] = useState(false);

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

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-slate-800">My resumes</p>
            <p className="text-[11px] text-slate-500">
              Every resume you edit or tailor lives here. Pick one to edit - it becomes your active resume.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onNew()}
            disabled={creating}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-60"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            New
          </button>
        </div>
      </div>

      {resumes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
          No saved resumes yet. Click <span className="font-semibold text-slate-700">New</span> to start one, or tailor
          your resume with the OneClick AI center below.
        </div>
      ) : (
        <div className="space-y-2.5">
          {resumes.map((item) => (
            <ResumeCard key={item.id} item={item} profile={profile} />
          ))}
        </div>
      )}
    </div>
  );
}
