import { Pencil, Flag, Copy, Trash2, CheckCircle } from 'lucide-react';
import { SubmittedUrlItem } from '../types/ui';
import JobTimeline from './JobTimeline';

type Props = {
  loadingLists: boolean;
  items: SubmittedUrlItem[];
  compareValidJobId: string | null;
  setRowRef: (id: string, el: HTMLLIElement | null) => void;
  openMenuId: string | null;
  onToggleMenu: (id: string) => void;
  onCloseMenu: () => void;
  onEdit: (item: SubmittedUrlItem) => void;
  onReportInvalid: (item: SubmittedUrlItem) => void;
  onReportDuplicate: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
  onBatchDelete?: (items: SubmittedUrlItem[]) => void;
  onMarkApplied: (items: SubmittedUrlItem[], userInitial: string) => void;
  onMarkUnapplied: (items: SubmittedUrlItem[]) => void;
  onShowScrapedContent?: (item: SubmittedUrlItem) => void;
  onShowJobMatch?: (item: SubmittedUrlItem) => void;
  onTriggerJobMatch?: (item: SubmittedUrlItem) => void;
  onJobUrlClick?: (item: SubmittedUrlItem) => void;
  onRescrape?: (item: SubmittedUrlItem) => void;
  userInitial?: string;
};

export function ValidJobsPanel({
  loadingLists,
  items,
  compareValidJobId,
  setRowRef,
  openMenuId,
  onToggleMenu,
  onCloseMenu,
  onEdit,
  onReportInvalid,
  onReportDuplicate,
  onDelete,
  onBatchDelete,
  onMarkApplied,
  onMarkUnapplied,
  onShowScrapedContent,
  onShowJobMatch,
  onTriggerJobMatch,
  onJobUrlClick,
  onRescrape,
  userInitial,
}: Props) {
  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-hidden border-b border-blue-200/30 px-6 py-8 md:border-b-0 md:border-r md:bg-white">
      <div className="mb-8">
        <div className="flex items-center gap-2">
          <CheckCircle className="h-6 w-6 text-blue-600" />
          <h2 className="text-2xl font-bold text-slate-900">To do jobs</h2>
        </div>
        <p className="mt-1 text-sm text-slate-500">List of valid job postings to process</p>
      </div>

      {/* Timeline with integrated job list */}
      <JobTimeline
        items={items}
        openMenuId={openMenuId}
        onToggleMenu={onToggleMenu}
        onEdit={onEdit}
        onReportInvalid={onReportInvalid}
        onReportDuplicate={onReportDuplicate}
        onDelete={onDelete}
        onBatchDelete={onBatchDelete}
        onMarkApplied={onMarkApplied}
        onMarkUnapplied={onMarkUnapplied}
        onShowScrapedContent={onShowScrapedContent}
        onShowJobMatch={onShowJobMatch}
        onTriggerJobMatch={onTriggerJobMatch}
        onJobUrlClick={onJobUrlClick}
        onRescrape={onRescrape}
        userInitial={userInitial}
        MenuComponent={null}
      />
    </div>
  );
}
