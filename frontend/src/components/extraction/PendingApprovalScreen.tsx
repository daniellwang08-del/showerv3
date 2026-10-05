import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Hourglass, KeyRound, LogOut } from 'lucide-react';
import { apiClient } from '../../api/client';
import { AuthBackdrop } from './AuthShell';
import { errorBoxClass, fieldIconClass, glassInputClass, glassLabelClass, primaryButtonClass } from './authStyles';
import { LANDING_CONTAINER } from '../landing/landingUi';

export const APPROVAL_POLL_MS = 5000;
const KEY_LENGTH = 10;

type ApprovalState = { email: string; approval_status: string; requested_at: string };

interface PendingApprovalScreenProps {
  /** Called once the account is approved (or the session ended); re-reads /auth/me. */
  onResolved: () => void | Promise<unknown>;
  onSignOut: () => void | Promise<unknown>;
}

function normalizeKey(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function errorDetail(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

/**
 * Shown to a signed-in account whose signup still waits for an admin. Polls the
 * approval state so the workspace opens on its own once an admin approves, and
 * accepts the one-time access key an admin may hand out instead.
 */
export function PendingApprovalScreen({ onResolved, onSignOut }: PendingApprovalScreenProps) {
  const [state, setState] = useState<ApprovalState | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const resolvedRef = useRef(false);

  const resolve = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    void onResolved();
  }, [onResolved]);

  const check = useCallback(async () => {
    try {
      const { data } = await apiClient.get<ApprovalState>('/auth/approval');
      setState(data);
      if (data.approval_status !== 'pending') resolve();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) resolve();
    }
  }, [resolve]);

  useEffect(() => {
    void check();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void check();
    }, APPROVAL_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [check]);

  const cleanKey = normalizeKey(key);
  const canRedeem = cleanKey.length === KEY_LENGTH && !redeeming;

  const redeem = async (e: FormEvent) => {
    e.preventDefault();
    if (!canRedeem) return;
    setRedeeming(true);
    setError('');
    try {
      const { data } = await apiClient.post<ApprovalState>('/auth/approval/redeem', { key: cleanKey });
      setState(data);
      if (data.approval_status === 'approved') resolve();
    } catch (err) {
      setError(errorDetail(err, 'Could not check that key. Please try again.'));
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <AuthBackdrop>
      <div className={`${LANDING_CONTAINER} flex flex-1 items-center justify-center py-10`}>
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#070B1C]/95 p-5 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.95)] sm:p-7">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#6F9BFF]/25 bg-[#3D74FF]/10 text-[#9DB9FF]">
            <Hourglass size={20} strokeWidth={2.25} aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-xl font-bold tracking-tight text-white sm:text-2xl">Waiting for approval</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-white/65">
            Your signup request{state?.email ? (
              <>
                {' '}for <span className="font-semibold text-white">{state.email}</span>
              </>
            ) : null}{' '}
            is with an admin. Keep this page open: your workspace opens on its own as soon as it is approved.
          </p>

          <p className="mt-4 flex items-center gap-2 text-xs font-medium text-white/55" role="status" aria-live="polite">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#6F9BFF]/60" />
              <span className="relative inline-flex size-2 rounded-full bg-[#6F9BFF]" />
            </span>
            Checking for approval
          </p>

          <form onSubmit={redeem} className="mt-6 space-y-3 border-t border-white/10 pt-5" noValidate>
            <label className={glassLabelClass} htmlFor="access-key">
              Have an access key?
            </label>
            <div className="group relative">
              <KeyRound size={18} className={fieldIconClass} aria-hidden="true" />
              <input
                id="access-key"
                className={`${glassInputClass} font-mono tracking-[0.25em] uppercase placeholder:font-sans placeholder:tracking-normal placeholder:normal-case`}
                placeholder="10-character key"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={16}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setError('');
                }}
              />
            </div>
            {error && <p className={errorBoxClass}>{error}</p>}
            <button className={primaryButtonClass} type="submit" disabled={!canRedeem}>
              <span className="relative">{redeeming ? 'Checking key…' : 'Unlock workspace'}</span>
            </button>
          </form>

          <button
            type="button"
            onClick={() => void onSignOut()}
            className="mt-5 inline-flex items-center gap-1.5 rounded text-sm font-semibold text-white/60 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6F9BFF]/70"
          >
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
      </div>
    </AuthBackdrop>
  );
}
