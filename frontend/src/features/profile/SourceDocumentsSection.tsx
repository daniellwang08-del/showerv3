import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, FolderUp, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  deleteProfileSourceDocument,
  formatDocSize,
  listProfileSourceDocuments,
  parseStatusLabel,
  reparseProfileSourceDocument,
  updateProfileSourceDocumentCompany,
  uploadProfileSourceDocument,
} from '@/api/profileSourceDocumentsApi';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ProfileSourceDocument } from '@/types/profileSourceDocument';
import { profileErrorFromUnknown } from '@/utils/profileErrors';
import { SOURCE_DOCUMENT_ACCEPT, sourceDocumentFileError, sourceKindLabel } from '@/utils/sourceDocumentFile';

export const SOURCE_DOCS_QUERY_KEY = ['profile', 'source-documents'] as const;

const NO_COMPANY = '__none';

function statusTone(status: string): string {
  if (status === 'completed') return 'bg-status-ready';
  if (status === 'failed') return 'bg-status-failed';
  return 'bg-status-preparing';
}

function companyItems(companies: string[], current: string | null, emptyLabel: string) {
  const names = current && !companies.includes(current) ? [current, ...companies] : companies;
  return [{ value: NO_COMPANY, label: emptyLabel }, ...names.map((c) => ({ value: c, label: c }))];
}

export function SourceDocumentsSection({ companies, disabled }: { companies: string[]; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadCompany, setUploadCompany] = useState('');
  const [fileError, setFileError] = useState('');
  const [toDelete, setToDelete] = useState<ProfileSourceDocument | null>(null);

  const docs = useQuery({ queryKey: SOURCE_DOCS_QUERY_KEY, queryFn: listProfileSourceDocuments });

  const replaceDoc = (doc: ProfileSourceDocument) =>
    queryClient.setQueryData<ProfileSourceDocument[]>(SOURCE_DOCS_QUERY_KEY, (prev) =>
      (prev ?? []).map((d) => (d.id === doc.id ? doc : d)),
    );

  const upload = useMutation({
    mutationFn: (file: File) => uploadProfileSourceDocument(file, uploadCompany || undefined),
    onSuccess: (res) => {
      queryClient.setQueryData<ProfileSourceDocument[]>(SOURCE_DOCS_QUERY_KEY, (prev) => [
        res.document,
        ...(prev ?? []).filter((d) => d.id !== res.document.id),
      ]);
      toast.success(`Uploaded ${res.document.filename}`);
      for (const w of res.warnings ?? []) toast.warning(w);
    },
    onError: (err) => toast.error(profileErrorFromUnknown(err, 'Could not upload project source document.')),
    onSettled: () => {
      if (inputRef.current) inputRef.current.value = '';
    },
  });

  const changeCompany = useMutation({
    mutationFn: ({ id, company }: { id: string; company: string }) => updateProfileSourceDocumentCompany(id, company),
    onSuccess: replaceDoc,
    onError: (err) => toast.error(profileErrorFromUnknown(err, 'Could not update company link.')),
  });

  const reparse = useMutation({
    mutationFn: reparseProfileSourceDocument,
    onSuccess: (doc) => {
      replaceDoc(doc);
      toast.success(`Re-parsed ${doc.filename}`);
    },
    onError: (err) => toast.error(profileErrorFromUnknown(err, 'Re-parse failed.')),
  });

  const remove = useMutation({
    mutationFn: (doc: ProfileSourceDocument) => deleteProfileSourceDocument(doc.id),
    onSuccess: (_, doc) => {
      queryClient.setQueryData<ProfileSourceDocument[]>(SOURCE_DOCS_QUERY_KEY, (prev) =>
        (prev ?? []).filter((d) => d.id !== doc.id),
      );
      toast.success(`Deleted ${doc.filename}`);
    },
    onError: (err) => toast.error(profileErrorFromUnknown(err, 'Could not delete document.')),
  });

  const rowBusy = (id: string) =>
    (changeCompany.isPending && changeCompany.variables?.id === id) ||
    (reparse.isPending && reparse.variables === id) ||
    (remove.isPending && remove.variables?.id === id);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const err = sourceDocumentFileError(file);
    setFileError(err ?? '');
    if (err) {
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    upload.mutate(file);
  };

  const uploadItems = companyItems(companies, null, 'No company');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Detailed per-company project write-ups (PDF, DOCX or Markdown, up to 10 MB). They’re parsed once and used when
        tailoring résumés for each job — stronger bullets with real metrics and project depth.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-col gap-1.5 sm:w-64">
          <label htmlFor="source-doc-company" className="text-sm font-medium">
            Company (optional)
          </label>
          <Select
            items={uploadItems}
            value={uploadCompany || NO_COMPANY}
            onValueChange={(v) => setUploadCompany(!v || v === NO_COMPANY ? '' : String(v))}
          >
            <SelectTrigger id="source-doc-company" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {uploadItems.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={SOURCE_DOCUMENT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label="Project source document file"
          disabled={disabled || upload.isPending}
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || upload.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? <Loader2 className="animate-spin" /> : <FolderUp />}
          {upload.isPending ? 'Uploading…' : 'Add project document'}
        </Button>
      </div>
      {fileError ? (
        <p role="alert" className="text-sm text-destructive">
          {fileError}
        </p>
      ) : null}

      {docs.isPending ? (
        <div className="flex flex-col gap-2" aria-label="Loading documents">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : docs.isError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
          <span className="text-destructive">Could not load project source documents.</span>
          <Button variant="outline" size="sm" onClick={() => void docs.refetch()}>
            Retry
          </Button>
        </div>
      ) : docs.data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No project source documents yet. Upload one per company for richer tailored résumés.
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {docs.data.map((doc) => {
            const busy = rowBusy(doc.id);
            const items = companyItems(
              companies,
              doc.company_name,
              companies.length ? 'Select company…' : 'Add work history first',
            );
            return (
              <li key={doc.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium" title={doc.filename}>
                        {doc.filename}
                      </span>
                      <Badge variant="outline">{sourceKindLabel(doc.source_kind)}</Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
                      <span className="inline-flex items-center gap-1.5" title={doc.parse_error ?? undefined}>
                        <span className={cn('size-1.5 rounded-full', statusTone(doc.parse_status))} aria-hidden />
                        {parseStatusLabel(doc.parse_status)}
                      </span>
                      <span>· {formatDocSize(doc.char_count)}</span>
                      <span>
                        · {doc.project_count} project{doc.project_count === 1 ? '' : 's'}
                      </span>
                    </div>
                    {doc.parse_status === 'failed' && doc.parse_error ? (
                      <p className="mt-1 text-xs text-destructive">{doc.parse_error}</p>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Select
                    items={items}
                    value={doc.company_name || NO_COMPANY}
                    disabled={busy || disabled || (companies.length === 0 && !doc.company_name)}
                    onValueChange={(v) => {
                      if (!v || v === NO_COMPANY) return;
                      changeCompany.mutate({ id: doc.id, company: String(v) });
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-48" aria-label={`Company for ${doc.filename}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {items.map((o) => (
                        <SelectItem key={o.value} value={o.value} disabled={o.value === NO_COMPANY}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Re-parse ${doc.filename}`}
                    disabled={busy || disabled}
                    onClick={() => reparse.mutate(doc.id)}
                  >
                    <RefreshCw className={cn(reparse.isPending && reparse.variables === doc.id && 'animate-spin')} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${doc.filename}`}
                    disabled={busy || disabled}
                    onClick={() => setToDelete(doc)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              “{toDelete?.filename}” and its parsed projects will no longer be used when tailoring résumés.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (toDelete) remove.mutate(toDelete);
                setToDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
