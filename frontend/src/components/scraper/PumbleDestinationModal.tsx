import { useEffect, useState } from 'react';
import { Loader2, MessageSquare, X } from 'lucide-react';
import type { PumbleIntegration } from '../../types/pumble';

interface PumbleDestinationModalProps {
  open: boolean;
  integrations: PumbleIntegration[];
  jobCount: number;
  posting: boolean;
  onClose: () => void;
  onConfirm: (integrationIds: string[]) => void;
}

export function PumbleDestinationModal({
  open,
  integrations,
  jobCount,
  posting,
  onClose,
  onConfirm,
}: PumbleDestinationModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const enabled = integrations.filter((i) => i.is_enabled !== false).map((i) => i.id);
    setSelectedIds(new Set(enabled));
  }, [open, integrations]);

  if (!open) return null;

  const enabledIntegrations = integrations.filter((i) => i.is_enabled !== false);
  const allSelected = enabledIntegrations.length > 0 && enabledIntegrations.every((i) => selectedIds.has(i.id));

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(enabledIntegrations.map((i) => i.id)));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/40 p-3 sm:p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pumble-dest-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
              <MessageSquare size={18} />
            </div>
            <div>
              <h3 id="pumble-dest-title" className="text-lg font-semibold text-slate-900">
                Post to Pumble
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                {jobCount === 1
                  ? 'Choose which Pumble destinations should receive this job.'
                  : `Choose which Pumble destinations should receive ${jobCount} jobs.`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={posting}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/80 p-3">
          <label className="flex cursor-pointer items-center gap-2 border-b border-slate-200 pb-2 text-sm font-semibold text-slate-800">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              disabled={posting || enabledIntegrations.length === 0}
              className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
            />
            Select all destinations
          </label>

          <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto">
            {enabledIntegrations.map((integration) => (
              <li key={integration.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-sm hover:bg-white">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(integration.id)}
                    onChange={() => toggle(integration.id)}
                    disabled={posting}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-slate-900">{integration.label}</span>
                    <span className="block text-xs text-slate-500">#{integration.channel_name}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={posting}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm([...selectedIds])}
            disabled={posting || selectedIds.size === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {posting ? <Loader2 size={14} className="animate-spin" /> : null}
            {posting
              ? 'Posting…'
              : `Post to ${selectedIds.size} destination${selectedIds.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
