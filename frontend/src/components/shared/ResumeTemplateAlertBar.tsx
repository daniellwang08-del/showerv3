import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchUserSettings } from '../../api/settingsApi';
import type { ResumeTemplateStatus } from '../../types/resumeTemplate';

const POLL_MS = 4000;

function statusMessage(status: ResumeTemplateStatus, error?: string | null): string {
  switch (status) {
    case 'missing':
      return 'Upload your résumé template in Settings. AI tailoring will still run, but resume documents may fail until a template is ready.';
    case 'processing':
      return 'Your résumé template is being analyzed. AI tailoring will still run, but resume documents may fail until analysis completes.';
    case 'stale':
      return 'Your profile work experience changed - re-analyze your template in Settings. AI tailoring will still run, but resume documents may fail.';
    case 'failed':
      return error
        ? `Résumé template is not ready: ${error}. AI tailoring will still run, but resume documents may fail.`
        : 'Résumé template validation failed. Fix it in Settings - AI tailoring will still run, but resume documents may fail.';
    default:
      return '';
  }
}

export function ResumeTemplateAlertBar() {
  const [status, setStatus] = useState<ResumeTemplateStatus>('missing');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchUserSettings();
      setStatus((data.resume_template_status as ResumeTemplateStatus) ?? 'missing');
      setError(data.resume_template_error ?? null);
      if (data.resume_template_ready) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    } catch {
      // Non-blocking banner - ignore fetch errors.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status !== 'processing') return;
    pollRef.current = setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status, refresh]);

  if (loading || status === 'ready') return null;

  const message = statusMessage(status, error);
  if (!message) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-start gap-2.5 min-w-0">
        {status === 'processing' ? (
          <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-amber-700" />
        ) : (
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-700" />
        )}
        <p className="text-sm text-amber-900 leading-relaxed">{message}</p>
      </div>
      <Link
        to="/settings/resume-template"
        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-900 transition shrink-0"
      >
        <Settings2 size={14} />
        Manage template
      </Link>
    </div>
  );
}
