import { useRef, useState, type DragEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import { saveUserProfile } from '@/api/profileApi';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { ProfileFormData, UserProfile } from '@/types/profile';
import { profileErrorFromUnknown } from '@/utils/profileErrors';
import { profileToForm } from '@/utils/profileFormData';
import { formatProfileValidationSummary } from '@/utils/profileValidation';
import {
  detectResumeConflicts,
  draftToFormPartial,
  mergeResumeImport,
  type ResumeConflict,
  type ResumeDraft,
} from '@/utils/resumeMerge';
import { validateProfile } from './profileSections';

export const PROFILE_QUERY_KEY = ['profile'] as const;

const MAX_RESUME_BYTES = 6 * 1024 * 1024;
const RESUME_ACCEPT =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type ParseResponse = { draft: ResumeDraft; source_kind: string; warnings: string[] };

type Phase = { kind: 'idle' } | { kind: 'uploading'; pct: number } | { kind: 'parsing' } | { kind: 'saving' };

export type ResumeImportCardProps = {
  /** Saved server profile used as the merge base (null for a brand-new user). */
  profile: UserProfile | null;
  /** Fallback email when the résumé has none (the signed-in account email). */
  accountEmail?: string;
  /** Import merged + validated + saved via PUT /profile. The ['profile'] query cache is already updated. */
  onApplied?: (saved: UserProfile) => void;
  /** Merged data failed validation; nothing was saved. Push it into a form so the user can fix `errors`. */
  onNeedsReview?: (merged: ProfileFormData, errors: Record<string, string>) => void;
  /** Smaller single-row layout (e.g. inside another section). */
  compact?: boolean;
  disabled?: boolean;
  className?: string;
};

function resumeFileError(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) return 'Please choose a PDF or DOCX file.';
  if (file.size > MAX_RESUME_BYTES) return 'File must be 6 MB or smaller.';
  return null;
}

export function ResumeImportCard({
  profile,
  accountEmail,
  onApplied,
  onNeedsReview,
  compact,
  disabled,
  className,
}: ResumeImportCardProps) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<{ draft: ResumeDraft; source: string; conflicts: ResumeConflict[] } | null>(
    null,
  );
  const [agreedReplace, setAgreedReplace] = useState(false);

  const save = useMutation({
    mutationFn: saveUserProfile,
    onSuccess: (saved) => {
      queryClient.setQueryData(PROFILE_QUERY_KEY, saved);
      void queryClient.invalidateQueries({ queryKey: [...PROFILE_QUERY_KEY, 'form'] });
      toast.success('Profile imported from résumé');
      onApplied?.(saved);
    },
    onError: (err) => {
      const msg = profileErrorFromUnknown(err, 'Could not save imported profile.');
      setError(msg);
      toast.error(msg);
    },
  });

  const busy = phase.kind !== 'idle' || save.isPending;

  const resetInput = () => {
    if (inputRef.current) inputRef.current.value = '';
  };

  const apply = async (draft: ResumeDraft, mode: 'empty_only' | 'replace') => {
    setPending(null);
    setAgreedReplace(false);
    const merged = mergeResumeImport(profile, draft, accountEmail, mode);
    const errors = validateProfile(merged);
    if (Object.keys(errors).length > 0) {
      const msg = formatProfileValidationSummary(errors).replace('Profile details below', 'the highlighted sections');
      setError(msg);
      toast.error('Résumé imported, but a few fields need your attention before saving.', { description: msg });
      onNeedsReview?.(merged, errors);
      return;
    }
    setPhase({ kind: 'saving' });
    try {
      await save.mutateAsync(merged);
    } catch {
      /* surfaced by onError */
    } finally {
      setPhase({ kind: 'idle' });
    }
  };

  const onFile = async (file: File | null | undefined) => {
    if (!file || disabled || busy) return;
    const fileError = resumeFileError(file);
    if (fileError) {
      setError(fileError);
      resetInput();
      return;
    }
    setError('');
    setWarnings([]);
    setPhase({ kind: 'uploading', pct: 0 });
    let data: ParseResponse | undefined;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post<ParseResponse>('/profile/resume-parse', fd, {
        onUploadProgress: (e) => {
          const pct = e.total ? Math.round((100 * e.loaded) / e.total) : 0;
          setPhase(pct >= 100 ? { kind: 'parsing' } : { kind: 'uploading', pct });
        },
      });
      data = res.data;
    } catch (err) {
      const msg = profileErrorFromUnknown(err, 'Could not parse résumé.');
      setError(msg);
      toast.error(msg);
      setPhase({ kind: 'idle' });
      resetInput();
      return;
    }
    setPhase({ kind: 'idle' });
    resetInput();
    if (!data?.draft) {
      setError('No data returned from parser.');
      return;
    }
    setWarnings(data.warnings ?? []);
    const conflicts = detectResumeConflicts(profileToForm(profile), draftToFormPartial(data.draft, accountEmail));
    if (conflicts.length === 0) {
      await apply(data.draft, 'empty_only');
      return;
    }
    setAgreedReplace(false);
    setPending({ draft: data.draft, source: data.source_kind ?? 'unknown', conflicts });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void onFile(e.dataTransfer.files?.[0]);
  };

  const statusText =
    phase.kind === 'uploading'
      ? `Uploading… ${phase.pct}%`
      : phase.kind === 'parsing'
        ? 'Reading your résumé with AI…'
        : phase.kind === 'saving' || save.isPending
          ? 'Saving profile…'
          : '';

  return (
    <section
      aria-label="Import from résumé"
      className={cn('rounded-xl border bg-card', compact ? 'p-4' : 'p-5', className)}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col gap-4 rounded-lg border border-dashed transition-colors sm:flex-row sm:items-center',
          compact ? 'p-3' : 'p-5',
          dragging ? 'border-brand bg-brand-soft' : 'border-border',
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <FileUp className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{compact ? 'Re-import from résumé' : 'Import from résumé'}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Drop a PDF or DOCX (max 6 MB) and we’ll fill your profile with AI. Empty fields are filled automatically;
              you’ll confirm before anything is replaced.
            </p>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={RESUME_ACCEPT}
          className="sr-only"
          aria-label="Résumé file"
          tabIndex={-1}
          disabled={disabled || busy}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant={compact ? 'outline' : 'default'}
          className="shrink-0"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <FileUp />}
          {busy ? 'Working…' : 'Choose file'}
        </Button>
      </div>

      {statusText ? (
        <div className="mt-3 flex flex-col gap-1.5" aria-live="polite">
          <Progress value={phase.kind === 'uploading' ? phase.pct : null} aria-label="Résumé import progress" />
          <p className="text-xs text-muted-foreground">{statusText}</p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {warnings.length && !pending ? <WarningList warnings={warnings} className="mt-3" /> : null}

      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setAgreedReplace(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-brand" />
              <DialogTitle>Résumé overlaps your saved profile</DialogTitle>
            </div>
            <DialogDescription>
              {pending?.source === 'pdf' ? 'Parsed from PDF.' : pending?.source === 'docx' ? 'Parsed from DOCX.' : null}{' '}
              Some fields already have values. Choose how to apply the extracted data.
            </DialogDescription>
          </DialogHeader>
          {warnings.length ? <WarningList warnings={warnings} /> : null}
          <div className="max-h-56 overflow-y-auto rounded-lg border bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">Would change</p>
            <ul className="mt-2 flex flex-col gap-2.5">
              {pending?.conflicts.map((c) => (
                <li key={c.id} className="text-sm">
                  <p className="font-medium">{c.label}</p>
                  <p className="text-muted-foreground">
                    <span className="text-foreground">Current:</span> {c.currentPreview}
                  </p>
                  <p className="text-muted-foreground">
                    <span className="text-foreground">From résumé:</span> {c.proposedPreview}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={agreedReplace}
              onCheckedChange={(v) => setAgreedReplace(v === true)}
            />
            <span>I agree to replace my existing values in the fields above when I choose “Replace with résumé”.</span>
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPending(null);
                setAgreedReplace(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => pending && void apply(pending.draft, 'empty_only')}>
              Fill empty fields only
            </Button>
            <Button disabled={!agreedReplace} onClick={() => pending && void apply(pending.draft, 'replace')}>
              Replace with résumé
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function WarningList({ warnings, className }: { warnings: string[]; className?: string }) {
  return (
    <div className={cn('rounded-lg border p-3 text-sm', className)}>
      <p className="flex items-center gap-1.5 font-medium">
        <TriangleAlert className="size-4 text-muted-foreground" />
        Parser notes
      </p>
      <ul className="mt-1.5 list-disc pl-5 text-muted-foreground">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}
