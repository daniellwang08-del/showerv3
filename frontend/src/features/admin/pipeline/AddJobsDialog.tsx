import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useJobsStore } from '@/stores/jobsStore';
import { extractHttpUrlsFromText } from '@/utils/extractHttpUrls';
import { submitJobUrls } from '@/features/jobs/submitJobUrls';
import { pipelineKeys } from './queries';

const ACCEPT =
  '.docx,.xlsx,.txt,.text,.md,.markdown,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/markdown,text/html';

export function AddJobsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const count = extractHttpUrlsFromText(text).length;
  const canSubmit = count > 0 || files.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    const value = text;
    const attachments = files;
    setText('');
    setFiles([]);
    onOpenChange(false);
    if (attachments.length > 0) {
      const id = toast.loading(`Importing ${attachments.length} file${attachments.length === 1 ? '' : 's'}…`);
      try {
        await useJobsStore.getState().submitAttachmentFiles(attachments);
      } catch {
        // The store records the error in submitError.
      }
      const { submitError, submitNotice } = useJobsStore.getState();
      if (submitError) toast.error(submitError, { id });
      else toast.success(submitNotice || 'Attachment imported', { id });
    }
    if (extractHttpUrlsFromText(value).length > 0) await submitJobUrls(value);
    void qc.invalidateQueries({ queryKey: pipelineKeys.root });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add jobs to inventory</DialogTitle>
          <DialogDescription>
            Paste posting links or attach a document that lists them. New jobs are queued for JD extraction.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="pipeline-add-links">Job links</Label>
          <Textarea
            id="pipeline-add-links"
            rows={5}
            placeholder={'https://boards.greenhouse.io/acme/jobs/123\nhttps://jobs.lever.co/acme/456'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
            className="font-mono text-xs"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Paperclip /> Attach file
          </Button>
          {files.map((f) => (
            <span key={f.name} className="inline-flex h-7 items-center gap-1 rounded-full border bg-muted/50 pr-1 pl-2.5 text-xs">
              <span className="max-w-40 truncate">{f.name}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {count > 0 ? `${count} link${count === 1 ? '' : 's'} detected` : 'Tip: ⌘/Ctrl + Enter to submit'}
          </span>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            Add jobs
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
