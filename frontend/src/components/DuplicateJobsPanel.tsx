import type { ReactNode } from 'react';
import { ArrowLeftRight, Search, Trash2, AlertCircle, MoreHorizontal, X } from 'lucide-react';
import { SubmittedUrlItem } from '../types/ui';

type Props = {
  loadingLists: boolean;
  items: SubmittedUrlItem[];
  openMenuId: string | null;
  onToggleMenu: (id: string) => void;
  onCloseMenu: () => void;
  onCompare: (item: SubmittedUrlItem) => void;
  onReplace: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
  onClosePanel: () => void;
  children: ReactNode;
};

export function DuplicateJobsPanel({
  loadingLists,
  items,
  openMenuId,
  onToggleMenu,
  onCloseMenu,
  onCompare,
  onReplace,
  onDelete,
  onClosePanel,
  children,
}: Props) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="mb-4 flex items-start justify-between gap-3 border-b border-blue-100 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-bold text-slate-900">Duplicates found</h2>
            <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
              {items.length}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500">Review and resolve duplicate job postings</p>
        </div>
        <button
          type="button"
          onClick={onClosePanel}
          className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition"
          aria-label="Close duplicates panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-4 shrink-0 min-w-0">
        {children}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="glass-card rounded-xl border border-blue-200/70 bg-gradient-to-b from-white to-blue-50/30 shadow-sm">
          {loadingLists ? (
            <div className="p-4 text-sm text-slate-500">Loading...</div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-medium text-slate-600">No duplicates yet.</p>
              <p className="mt-1 text-xs text-slate-500">Potential duplicate URLs will appear here automatically.</p>
            </div>
          ) : (
            <ul className="divide-y divide-blue-100/60">
              {items.map((item) => (
                <li key={item.id} className="group">
                  <div className="relative" data-job-menu-root="true">
                    <div className="flex items-center justify-between gap-2 border border-transparent px-3 py-2 transition hover:bg-blue-50/70">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 cursor-pointer"
                        title={item.url}
                      >
                        <div className="truncate text-xs font-medium text-slate-700 hover:text-blue-700 hover:underline">{item.url}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {new Date(item.created_at_ms).toLocaleString()}
                        </div>
                      </a>

                      <button
                        type="button"
                        className="shrink-0 rounded-md border border-slate-300 bg-white p-1 text-slate-700 opacity-0 transition-opacity duration-200 hover:bg-slate-100 group-hover:opacity-100"
                        aria-label="Actions"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onToggleMenu(item.id);
                        }}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </div>

                    {openMenuId === item.id && (
                      <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-slate-200 bg-white shadow-lg">
                        <button
                          type="button"
                          className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
                          onClick={() => {
                            onCloseMenu();
                            onCompare(item);
                          }}
                        >
                          <span className="inline-flex items-center gap-2">
                            <Search className="h-4 w-4" />
                            Compare
                          </span>
                        </button>
                        <button
                          type="button"
                          className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50"
                          onClick={() => {
                            onCloseMenu();
                            onReplace(item);
                          }}
                        >
                          <span className="inline-flex items-center gap-2">
                            <ArrowLeftRight className="h-4 w-4" />
                            Replace
                          </span>
                        </button>
                        <button
                          type="button"
                          className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                          onClick={() => {
                            onCloseMenu();
                            onDelete(item);
                          }}
                        >
                          <span className="inline-flex items-center gap-2">
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
