import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, FileText, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { attachmentUrl, fetchAdminIssue, updateIssue } from '@/api/issuesApi';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { IssueAttachment, IssueReport, IssueStatus } from '@/types/issues';
import { fullDate, relative } from '../packages/packagesModel';
import { categoryLabel, CONTEXT_LABELS, formatBytes, hostOf, ISSUES_KEY, STATUS_META, STATUS_ORDER } from './issuesModel';

export function IssueSheet({
  issueId,
  initial,
  onClose,
  onChanged,
}: {
  issueId: string | null;
  initial: IssueReport | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const issue = useQuery({
    queryKey: [...ISSUES_KEY, 'one', issueId],
    queryFn: () => fetchAdminIssue(issueId as string),
    enabled: !!issueId,
    initialData: initial ?? undefined,
  });
  const data = issueId ? issue.data : undefined;

  return (
    <Sheet open={!!issueId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        {data ? (
          <IssueDetail issue={data} onChanged={onChanged} />
        ) : issue.isError ? (
          <SheetHeader>
            <SheetTitle>Issue not found</SheetTitle>
            <SheetDescription>It may have been removed with the account that reported it.</SheetDescription>
          </SheetHeader>
        ) : (
          <div className="space-y-3 p-4">
            <SheetTitle className="sr-only">Loading issue</SheetTitle>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function IssueDetail({ issue, onChanged }: { issue: IssueReport; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState(issue.admin_note ?? '');
  const [viewing, setViewing] = useState<IssueAttachment | null>(null);
  useEffect(() => setNote(issue.admin_note ?? ''), [issue.id, issue.admin_note]);

  const save = useMutation({
    mutationFn: (body: { status?: IssueStatus; admin_note?: string | null }) => updateIssue(issue.id, body),
    onSuccess: (updated, body) => {
      queryClient.setQueryData([...ISSUES_KEY, 'one', issue.id], updated);
      onChanged();
      toast.success(body.status ? `Marked ${STATUS_META[body.status].label.toLowerCase()}` : 'Note saved');
    },
    onError: () => toast.error('Could not save the change. Try again.'),
  });

  const meta = STATUS_META[issue.status] ?? STATUS_META.open;
  const images = issue.attachments.filter((a) => a.kind === 'image');
  const files = issue.attachments.filter((a) => a.kind !== 'image');
  const context = CONTEXT_LABELS.filter(([key]) => issue.context?.[key] != null && issue.context[key] !== '');
  const noteChanged = note.trim() !== (issue.admin_note ?? '').trim();

  return (
    <>
      <SheetHeader className="gap-2 pr-12">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">#{issue.number}</span>
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium', meta.chip)}>
            <span aria-hidden className={cn('size-1.5 rounded-full', meta.dot)} />
            {meta.label}
          </span>
          <span>{categoryLabel(issue.category)}</span>
        </div>
        <SheetTitle className="text-lg leading-snug">{issue.title}</SheetTitle>
        <SheetDescription>
          Reported {relative(issue.created_at)} ({fullDate(issue.created_at)})
          {issue.reporter ? ` by ${issue.reporter.name}` : ''}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-6 px-4 pb-6">
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Status</h3>
          <ToggleGroup
            aria-label="Issue status"
            variant="outline"
            size="sm"
            spacing={0}
            value={[issue.status]}
            onValueChange={(next) => {
              const v = next[0] as IssueStatus | undefined;
              if (v && v !== issue.status) save.mutate({ status: v });
            }}
            disabled={save.isPending}
          >
            {STATUS_ORDER.map((s) => (
              <ToggleGroupItem key={s} value={s} className="gap-1.5">
                <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_META[s].dot)} />
                {STATUS_META[s].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {issue.status_changed_by && issue.status_changed_at ? (
            <p className="text-xs text-muted-foreground">
              Changed by {issue.status_changed_by.name} {relative(issue.status_changed_at)}
            </p>
          ) : null}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">What happened</h3>
          <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap break-words">{issue.description}</p>
        </section>

        {images.length ? (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              Screenshots ({images.length})
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {images.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setViewing(a)}
                  className="group overflow-hidden rounded-lg border bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`View ${a.filename}`}
                >
                  <img
                    src={attachmentUrl(issue.id, a.id)}
                    alt={a.filename}
                    loading="lazy"
                    className="h-28 w-full object-cover transition-transform group-hover:scale-[1.02]"
                  />
                  <span className="block truncate px-2 py-1 text-[11px] text-muted-foreground" title={a.filename}>
                    {a.filename}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {files.length ? (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Files ({files.length})</h3>
            <ul className="divide-y rounded-lg border">
              {files.map((a) => (
                <li key={a.id} className="flex items-center gap-2.5 px-3 py-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm" title={a.filename}>{a.filename}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(a.byte_size)}</span>
                  <a
                    href={attachmentUrl(issue.id, a.id, true)}
                    download={a.filename}
                    aria-label={`Download ${a.filename}`}
                    className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
                  >
                    <Download />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Reporter and context</h3>
          <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            {issue.reporter ? (
              <>
                <dt className="text-muted-foreground">Reporter</dt>
                <dd className="min-w-0">
                  <a href={`mailto:${issue.reporter.email}`} className="inline-flex max-w-full items-center gap-1 text-brand hover:underline">
                    <Mail className="size-3.5 shrink-0" />
                    <span className="truncate">{issue.reporter.name} ({issue.reporter.email})</span>
                  </a>
                </dd>
              </>
            ) : null}
            {issue.page_url ? (
              <>
                <dt className="text-muted-foreground">Page</dt>
                <dd className="min-w-0">
                  <a
                    href={issue.page_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex max-w-full items-center gap-1 text-brand hover:underline"
                    title={issue.page_url}
                  >
                    <span className="truncate">{issue.page_title || hostOf(issue.page_url)}</span>
                    <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                </dd>
              </>
            ) : null}
            {context.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words text-xs leading-5">{String(issue.context[key])}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="space-y-2">
          <label htmlFor="issue-note" className="text-xs font-medium text-muted-foreground">
            Internal note
          </label>
          <Textarea
            id="issue-note"
            rows={4}
            maxLength={5000}
            placeholder="What you found, the fix, or who is on it. Only admins see this."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!noteChanged || save.isPending}
              onClick={() => save.mutate({ admin_note: note.trim() || null })}
            >
              Save note
            </Button>
          </div>
        </section>
      </div>

      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-h-[92dvh] w-auto max-w-[min(96vw,1400px)] gap-3 p-3 sm:max-w-[min(96vw,1400px)]">
          <DialogTitle className="truncate pr-10 text-sm">{viewing?.filename}</DialogTitle>
          {viewing ? (
            <>
              <img
                src={attachmentUrl(issue.id, viewing.id)}
                alt={viewing.filename}
                className="max-h-[78dvh] w-auto max-w-full rounded-md object-contain"
              />
              <div className="flex justify-end gap-2">
                <a
                  href={attachmentUrl(issue.id, viewing.id)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  <ExternalLink /> Open full size
                </a>
                <a
                  href={attachmentUrl(issue.id, viewing.id, true)}
                  download={viewing.filename}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  <Download /> Download
                </a>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
