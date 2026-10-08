import { toast } from 'sonner';
import type { JobAddBatch } from '@/types/jobAdd';
import { addNoticeDescription, addNoticeTitle } from './jobAddShare';

/** Tells the user how a fresh add was stored. The default lives in Preferences. */
export function showJobAddNotice(batch: JobAddBatch) {
  toast.success(addNoticeTitle(batch), {
    id: `job-add-${batch.id}`,
    duration: 5000,
    description: addNoticeDescription(batch),
  });
}
