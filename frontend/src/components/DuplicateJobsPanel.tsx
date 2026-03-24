import type { ReactNode } from 'react';
import { ArrowLeftRight, Search, Trash2, AlertCircle } from 'lucide-react';
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
  children,
}: Props) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-6 py-8 md:bg-gradient-to-b md:from-purple-50/50 md:to-white">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-6 w-6 text-orange-600" />
          <h2 className="text-2xl font-bold text-slate-900">Duplicates found</h2>
        </div>
        <p className="mt-1 text-sm text-slate-500">Review and resolve duplicate job postings</p>
      </div>

      <div className="mb-4 shrink-0 min-w-0">
        {children}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="rounded-lg border border-orange-200/50 bg-gradient-to-b from-white to-orange-50/30">
          {loadingLists ? (
            <div className="p-4 text-sm text-slate-500">Loading...</div>
          ) : items.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No duplicates yet.</div>
          ) : (
            <ul className="divide-y divide-orange-100/50">
              {items.map((item) => (
                <li key={item.id} className="group">
                  <div className="relative" data-job-menu-root="true">
                    <div className="flex items-center justify-between gap-2 border border-transparent px-3 py-1 transition hover:bg-orange-50">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 cursor-pointer"
                        title={item.url}
                      >
                        <div className="truncate text-xs text-slate-700 hover:text-orange-600 hover:underline">{item.url}</div>
                      </a>

                      <button
                        type="button"
                        className="shrink-0 border border-slate-300 bg-white px-1.5 py-0.5 text-xs text-slate-700 opacity-0 transition-opacity duration-200 hover:bg-slate-100 group-hover:opacity-100"
                        aria-label="Actions"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onToggleMenu(item.id);
                        }}
                      >
                        ...
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
