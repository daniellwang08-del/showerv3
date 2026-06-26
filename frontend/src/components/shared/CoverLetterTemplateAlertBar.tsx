import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchUserSettings } from '../../api/settingsApi';
import type { CoverLetterTemplateStatus } from '../../types/settings';

const POLL_MS = 4000;

function statusMessage(status: CoverLetterTemplateStatus, error?: string | null): string {
  switch (status) {
    case 'missing':
      return 'Upload your cover letter template in Settings. AI tailoring will still run, but cover letter documents may fail until a template is ready.';
    case 'processing':
      return 'Your cover letter template is being validated. AI tailoring will still run, but cover letter documents may fail until validation completes.';
    case 'failed':
      return error
        ? `Cover letter template is not ready: ${error}. AI tailoring will still run, but cover letter documents may fail.`
        : 'Cover letter template validation failed. Fix it in Settings - AI tailoring will still run, but cover letter documents may fail.';
    default:
      return '';
  }
}

export function CoverLetterTemplateAlertBar() {
  const [status, setStatus] = useState<CoverLetterTemplateStatus>('missing');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchUserSettings();
      setStatus((data.cover_letter_template_status as CoverLetterTemplateStatus) ?? 'missing');
      setError(data.cover_letter_template_error ?? null);
      if (data.cover_letter_template_ready) {
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
        to="/settings#cover-letter-template"
        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-900 transition shrink-0"
      >
        <Settings2 size={14} />
        Manage template
      </Link>
    </div>
  );
}
