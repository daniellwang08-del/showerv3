import { useEffect, useRef, useState, useCallback } from 'react';
import { LogOut, Menu, Table2, Trash2, User, Loader2 } from 'lucide-react';
import { apiClient } from '../../api/client';
import { useJobsStore } from '../../stores/jobsStore';
import { useUIStore } from '../../stores/uiStore';

type OldJobsState =
  | { phase: 'idle' }
  | { phase: 'counting'; }
  | { phase: 'counted'; total: number; valid: number; invalid: number }
  | { phase: 'deleting' }
  | { phase: 'done'; deleted: number };

type Props = {
  onToggleDrawer: () => void;
  onLogout: () => void;
  onMyProfile?: () => void;
  onIntegrateSheet?: () => void;
  userEmail?: string | null;
  userName?: string | null;
};

function computeInitials(name?: string | null, email?: string | null) {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
  }
  if (!email) return 'U';
  const local = email.split('@')[0];
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return local.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + (parts[1][0] || '')).toUpperCase();
}

function colorFromString(s?: string | null) {
  const colors = ['bg-indigo-500', 'bg-rose-500', 'bg-emerald-500', 'bg-yellow-500', 'bg-sky-500', 'bg-violet-500'];
  if (!s) return colors[0];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  const idx = Math.abs(h) % colors.length;
  return colors[idx];
}

export function Header({ onToggleDrawer, onLogout, onMyProfile, onIntegrateSheet, userEmail, userName }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const [oldJobs, setOldJobs] = useState<OldJobsState>({ phase: 'idle' });

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    if (!open) {
      setOldJobs((prev) => (prev.phase === 'deleting' || prev.phase === 'counting' ? prev : { phase: 'idle' }));
    }
  }, [open]);

  const handleOldJobsClick = useCallback(async () => {
    const { phase } = oldJobs;

    if (phase === 'idle' || phase === 'done') {
      setOldJobs({ phase: 'counting' });
      try {
        const { data } = await apiClient.get<{ valid_old: number; invalid_old: number; total_old: number }>(
          '/jobs/old-jobs/count',
        );
        setOldJobs({ phase: 'counted', total: data.total_old, valid: data.valid_old, invalid: data.invalid_old });
      } catch {
        useUIStore.getState().notify('error', 'Failed to check old jobs');
        setOldJobs({ phase: 'idle' });
      }
      return;
    }

    if (phase === 'counted') {
      if (oldJobs.total === 0) {
        useUIStore.getState().notify('info', 'No old jobs to remove');
        setOldJobs({ phase: 'idle' });
        return;
      }
      setOldJobs({ phase: 'deleting' });
      try {
        const { data } = await apiClient.delete<{ total_deleted: number }>('/jobs/old-jobs');
        setOldJobs({ phase: 'done', deleted: data.total_deleted });
        useUIStore.getState().notify('success', `Removed ${data.total_deleted} old job${data.total_deleted === 1 ? '' : 's'}`);
        await useJobsStore.getState().refreshLists({ showLoading: false, reset: true });
      } catch {
        useUIStore.getState().notify('error', 'Failed to delete old jobs');
        setOldJobs({ phase: 'idle' });
      }
    }
  }, [oldJobs]);

  const initials = computeInitials(userName, userEmail);
  const colorClass = colorFromString(userEmail ?? userName);

  return (
    <>
      <header className="relative z-20 w-full border-b border-blue-200/60 bg-white/55 backdrop-blur-xl">
        <button
          onClick={onToggleDrawer}
          aria-label="Toggle navigation"
          className="fixed top-2 left-4 z-50 rounded-xl border border-blue-200/70 bg-white/90 p-2 text-blue-800 shadow-lg transition hover:-translate-y-0.5 hover:bg-white"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="max-w-7xl mx-auto flex items-center justify-center px-4 py-3">
          <div className="text-lg font-semibold tracking-wide bg-gradient-to-r from-blue-700 via-indigo-600 to-sky-500 bg-clip-text text-transparent">
            Job Scraper
          </div>
        </div>

        <div className="fixed top-2 right-4 z-50" ref={ref}>
          <button
            onClick={() => setOpen((s) => !s)}
            className={`flex items-center justify-center rounded-full shadow-md hover:opacity-90 transition text-white font-semibold text-sm ${colorClass}`}
            style={{ width: 40, height: 40 }}
            aria-haspopup="true"
            aria-expanded={open}
          >
            {initials}
          </button>

          {open && (
            <div className="glass-card absolute right-0 mt-2 w-56 rounded-xl border border-blue-200/70 bg-white/90 shadow-xl">
              {onMyProfile && (
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-blue-50"
                  onClick={() => {
                    setOpen(false);
                    onMyProfile();
                  }}
                >
                  <User className="h-4 w-4 text-blue-600" />
                  My profile
                </button>
              )}
              {onIntegrateSheet && (
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-blue-50"
                  onClick={() => {
                    setOpen(false);
                    onIntegrateSheet();
                  }}
                >
                  <Table2 className="h-4 w-4 text-emerald-600" />
                  Integrate Google Sheet
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-amber-50 transition-colors"
                onClick={handleOldJobsClick}
                disabled={oldJobs.phase === 'counting' || oldJobs.phase === 'deleting'}
              >
                {oldJobs.phase === 'counting' || oldJobs.phase === 'deleting' ? (
                  <Loader2 className="h-4 w-4 text-amber-600 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 text-amber-600" />
                )}
                <span className="flex-1 text-left">
                  {oldJobs.phase === 'idle' && 'Clean old jobs'}
                  {oldJobs.phase === 'counting' && 'Checking\u2026'}
                  {oldJobs.phase === 'counted' && (
                    oldJobs.total > 0
                      ? `Remove ${oldJobs.total} old job${oldJobs.total === 1 ? '' : 's'}?`
                      : 'No old jobs found'
                  )}
                  {oldJobs.phase === 'deleting' && 'Removing\u2026'}
                  {oldJobs.phase === 'done' && `Removed ${oldJobs.deleted}`}
                </span>
              </button>
              <div className="border-t border-blue-100/60" />
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-blue-50"
                onClick={onLogout}
              >
                <LogOut className="h-4 w-4 text-rose-600" />
                Logout
              </button>
            </div>
          )}
        </div>
      </header>
    </>
  );
}

export default Header;
