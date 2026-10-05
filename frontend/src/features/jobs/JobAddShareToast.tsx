import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useJobAddStore } from '@/stores/jobAddStore';
import type { JobAddBatch } from '@/types/jobAdd';
import type { JobShareScope } from '@/types/settings';
import { shareToastPrompt, shareToastTitle } from './jobAddShare';

const TOAST_OPTIONS: { scope: Exclude<JobShareScope, 'users'>; label: string }[] = [
  { scope: 'private', label: 'Keep private' },
  { scope: 'team', label: 'Share with the team' },
  { scope: 'all', label: 'Share with everyone' },
];

export function JobAddShareToast({ batchId, prompt }: { batchId: string; prompt: string }) {
  const share = useJobAddStore((s) => s.share);
  const openPicker = useJobAddStore((s) => s.openPicker);

  const apply = (scope: Exclude<JobShareScope, 'users'>) => {
    void share(batchId, scope).then((next) => {
      if (!next) return;
      toast.success(
        scope === 'private'
          ? 'These jobs stay private'
          : scope === 'team'
            ? 'Shared with the team'
            : 'Shared with everyone',
        { id: `job-add-share-${batchId}`, duration: 2500 },
      );
    });
  };

  return (
    <div className="mt-1 space-y-2">
      <p>{prompt}</p>
      <div className="flex flex-col items-stretch gap-1">
        {TOAST_OPTIONS.map((opt) => (
          <Button
            key={opt.scope}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 justify-start text-xs"
            onClick={() => apply(opt.scope)}
          >
            {opt.label}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 justify-start text-xs"
          onClick={() => {
            toast.dismiss(`job-add-share-${batchId}`);
            openPicker(batchId);
          }}
        >
          Share with specific people
        </Button>
      </div>
    </div>
  );
}

export function showJobAddShareToast(batch: JobAddBatch) {
  toast.success(shareToastTitle(batch), {
    id: `job-add-share-${batch.id}`,
    duration: 5000,
    description: <JobAddShareToast batchId={batch.id} prompt={shareToastPrompt(batch)} />,
  });
}
