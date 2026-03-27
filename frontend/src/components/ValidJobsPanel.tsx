import { CheckCircle } from 'lucide-react';
import { SubmittedUrlItem } from '../types/ui';
import JobTimeline from './JobTimeline';

type Props = {
  items: SubmittedUrlItem[];
  compareValidJobId?: string | null;
  openMenuId: string | null;
  onToggleMenu: (id: string) => void;
  onEdit: (item: SubmittedUrlItem) => void;
  onReportInvalid: (item: SubmittedUrlItem) => void;
  onReportDuplicate: (item: SubmittedUrlItem) => void;
  onDelete: (item: SubmittedUrlItem) => void;
  onBatchDelete?: (items: SubmittedUrlItem[]) => void;
  onMarkApplied: (items: SubmittedUrlItem[], userInitial: string) => void;
  onMarkUnapplied: (items: SubmittedUrlItem[]) => void;
  onOpenSelectedUrls?: (items: SubmittedUrlItem[]) => void;
  onShowScrapedContent?: (item: SubmittedUrlItem) => void;
  onShowJobMatch?: (item: SubmittedUrlItem) => void;
  onTriggerJobMatch?: (item: SubmittedUrlItem) => void;
  onJobUrlClick?: (item: SubmittedUrlItem) => void;
  onRescrape?: (item: SubmittedUrlItem) => void;
  userInitial?: string;
};

export function ValidJobsPanel({
  items,
  openMenuId,
  onToggleMenu,
  onEdit,
  onReportInvalid,
  onReportDuplicate,
  onDelete,
  onBatchDelete,
  onMarkApplied,
  onMarkUnapplied,
  onOpenSelectedUrls,
  onShowScrapedContent,
  onShowJobMatch,
  onTriggerJobMatch,
  onJobUrlClick,
  onRescrape,
  userInitial,
  compareValidJobId,
}: Props) {
  return (
    <div className="glass-card m-3 flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-blue-200/60 px-4 py-4 md:mb-3 md:mr-0 md:border-r md:bg-white/70 md:px-6 md:py-6">
      <div className="mb-4 shrink-0 md:mb-6">
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
        compareValidJobId={compareValidJobId}
        onToggleMenu={onToggleMenu}
        onEdit={onEdit}
        onReportInvalid={onReportInvalid}
        onReportDuplicate={onReportDuplicate}
        onDelete={onDelete}
        onBatchDelete={onBatchDelete}
        onMarkApplied={onMarkApplied}
        onMarkUnapplied={onMarkUnapplied}
        onOpenSelectedUrls={onOpenSelectedUrls}
        onShowScrapedContent={onShowScrapedContent}
        onShowJobMatch={onShowJobMatch}
        onTriggerJobMatch={onTriggerJobMatch}
        onJobUrlClick={onJobUrlClick}
        onRescrape={onRescrape}
        userInitial={userInitial}
      />
    </div>
  );
}
