import { useRef, useState } from 'react';
import { FileText, Loader2, Pencil } from 'lucide-react';
import { apiClient } from '../../api/client';
import { extractApiErrorMessage } from '../../utils/profileErrors';
import { FilenameTokenChips } from '../app/FilenameTokenChips';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export type JobDocumentNames = { resume: string; cover_letter: string };

export type JobFilenameResult = {
  filename_override: string | null;
  file_names: JobDocumentNames | null;
};

export async function saveJobFilename(validJobId: string, filename: string | null) {
  const { data } = await apiClient.put<JobFilenameResult>(`/jobs/valid/${validJobId}/resume-build/filename`, {
    filename,
  });
  return data;
}

/** Shows the names this job's files download and upload under, and lets the user rename them for this job only. */
export function JobFilenameEditor({
  validJobId,
  override,
  names,
  coverOnly,
  onSaved,
}: {
  validJobId: string;
  override: string | null | undefined;
  names: JobDocumentNames | null | undefined;
  coverOnly: boolean;
  onSaved: (result: JobFilenameResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (filename: string | null) => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveJobFilename(validJobId, filename));
      setEditing(false);
    } catch (e) {
      setError(extractApiErrorMessage(e, 'Could not rename these files.'));
    } finally {
      setSaving(false);
    }
  };

  if (!names) return null;
  const shown = coverOnly ? [names.cover_letter] : [names.resume, names.cover_letter];

  if (!editing) {
    return (
      <div className="relative mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-mono text-foreground" data-testid="job-file-names">
          {shown.join(', ')}
        </span>
        <span>{override ? '(named for this job)' : '(your file name rule)'}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-brand hover:bg-brand-soft"
          onClick={() => {
            setDraft(override || '');
            setError(null);
            setEditing(true);
          }}
        >
          <Pencil className="h-3 w-3" aria-hidden />
          Rename
        </button>
      </div>
    );
  }

  return (
    <div className="relative mb-4 space-y-2 rounded-lg border bg-card p-3">
      <label htmlFor={`job-filename-${validJobId}`} className="text-xs font-medium text-foreground">
        File name for this job
      </label>
      <Input
        id={`job-filename-${validJobId}`}
        ref={inputRef}
        value={draft}
        maxLength={200}
        spellCheck={false}
        placeholder={names.resume}
        className="h-8 font-mono text-xs"
        aria-invalid={error ? true : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) void submit(draft);
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <FilenameTokenChips value={draft} onChange={setDraft} inputRef={inputRef} disabled={saving} />
      <p className="text-[11px] text-muted-foreground">
        Type a name or use fields. The extension and downloads use it for this job only; .pdf and .docx are added for you.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {override && (
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void submit(null)}>
            Use my file name rule
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={saving || !draft.trim()} onClick={() => void submit(draft)}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
