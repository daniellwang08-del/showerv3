import { toast } from 'sonner';
import { useJobsStore } from '@/stores/jobsStore';
import { extractHttpUrlsFromText } from '@/utils/extractHttpUrls';

/** Submit every job link found in `text` to the pipeline, reporting progress as one toast. */
export async function submitJobUrls(text: string): Promise<boolean> {
  const count = extractHttpUrlsFromText(text).length;
  if (count === 0) {
    toast.error('No job links found. Paste one or more http(s) URLs.');
    return false;
  }
  const id = toast.loading(`Submitting ${count} job${count === 1 ? '' : 's'}…`);
  let addNoticeShown = false;
  try {
    const result = await useJobsStore.getState().submitPastedText(text);
    addNoticeShown = Boolean(result && 'addNoticeShown' in result && result.addNoticeShown);
  } catch {
    // The store records the error in submitError.
  }
  const { submitError, submitNotice, submitNoticeKind } = useJobsStore.getState();
  if (submitError) toast.error(submitError, { id });
  else if (addNoticeShown) toast.dismiss(id);
  else if (submitNoticeKind === 'warning') toast.warning(submitNotice || 'Submitted with warnings', { id });
  else toast.success(submitNotice || `Submitted ${count} job${count === 1 ? '' : 's'}`, { id });
  return !submitError;
}
