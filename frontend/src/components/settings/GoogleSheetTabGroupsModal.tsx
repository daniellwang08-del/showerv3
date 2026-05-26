import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, Table2, Check, AlertCircle, Plus, RefreshCw } from 'lucide-react';
import { saveSheetsConfig, verifySpreadsheet } from '../../api/googleSheetsApi';
import type { SheetsConfigSaveResult } from '../../types/googleSheets';

const GROUP_COLORS = [
  { bg: 'bg-blue-100', border: 'border-blue-400', text: 'text-blue-800', dot: 'bg-blue-500' },
  { bg: 'bg-emerald-100', border: 'border-emerald-400', text: 'text-emerald-800', dot: 'bg-emerald-500' },
  { bg: 'bg-amber-100', border: 'border-amber-400', text: 'text-amber-800', dot: 'bg-amber-500' },
  { bg: 'bg-purple-100', border: 'border-purple-400', text: 'text-purple-800', dot: 'bg-purple-500' },
  { bg: 'bg-rose-100', border: 'border-rose-400', text: 'text-rose-800', dot: 'bg-rose-500' },
  { bg: 'bg-cyan-100', border: 'border-cyan-400', text: 'text-cyan-800', dot: 'bg-cyan-500' },
];

type Props = {
  spreadsheetUrl: string;
  tabs: string[];
  tabGroups: string[][];
  autoPostThreshold: number;
  onClose: () => void;
  onSaved: (result: SheetsConfigSaveResult) => void;
};

function buildAssignmentsFromGroups(
  tabs: string[],
  groups: string[][] | undefined,
): { assignments: Record<string, number>; groupCount: number } {
  const assignments: Record<string, number> = {};
  tabs.forEach((t) => {
    assignments[t] = -1;
  });
  const safeGroups = groups ?? [];
  safeGroups.forEach((group, gi) => {
    group.forEach((tabName) => {
      if (tabs.includes(tabName)) {
        assignments[tabName] = gi;
      }
    });
  });
  const groupCount = Math.max(safeGroups.length, 2, 1);
  return { assignments, groupCount: Math.min(groupCount, GROUP_COLORS.length) };
}

export function GoogleSheetTabGroupsModal({
  spreadsheetUrl,
  tabs: initialTabs,
  tabGroups: initialTabGroups,
  autoPostThreshold,
  onClose,
  onSaved,
}: Props) {
  const [tabs, setTabs] = useState<string[]>(initialTabs);
  const [tabAssignments, setTabAssignments] = useState<Record<string, number>>(() =>
    buildAssignmentsFromGroups(initialTabs, initialTabGroups).assignments,
  );
  const [groupCount, setGroupCount] = useState(() =>
    buildAssignmentsFromGroups(initialTabs, initialTabGroups).groupCount,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const { assignments, groupCount: gc } = buildAssignmentsFromGroups(initialTabs, initialTabGroups);
    setTabs(initialTabs);
    setTabAssignments(assignments);
    setGroupCount(gc);
    setError('');
    setSuccess(false);
  }, [initialTabs, initialTabGroups, spreadsheetUrl]);

  const handleRefreshTabs = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const result = await verifySpreadsheet(spreadsheetUrl);
      const nextTabs = result.tabs || [];
      setTabs(nextTabs);
      setTabAssignments((prev) => {
        const updated: Record<string, number> = {};
        nextTabs.forEach((t) => {
          updated[t] = prev[t] ?? -1;
        });
        return updated;
      });
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setError(typeof msg === 'string' ? msg : 'Could not refresh tabs from the spreadsheet.');
    } finally {
      setRefreshing(false);
    }
  }, [spreadsheetUrl]);

  const assignTab = useCallback((tab: string, groupIdx: number) => {
    setTabAssignments((prev) => ({ ...prev, [tab]: groupIdx }));
  }, []);

  const addGroup = useCallback(() => {
    if (groupCount < GROUP_COLORS.length) setGroupCount((c) => c + 1);
  }, [groupCount]);

  const removeGroup = useCallback(
    (groupIdx: number) => {
      if (groupCount <= 1) return;
      setTabAssignments((prev) => {
        const updated = { ...prev };
        for (const tab of Object.keys(updated)) {
          if (updated[tab] === groupIdx) updated[tab] = -1;
          else if (updated[tab] > groupIdx) updated[tab] -= 1;
        }
        return updated;
      });
      setGroupCount((c) => c - 1);
    },
    [groupCount],
  );

  const buildTabGroups = useCallback((): string[][] => {
    const groups: string[][] = Array.from({ length: groupCount }, () => []);
    for (const [tab, gi] of Object.entries(tabAssignments)) {
      if (gi >= 0 && gi < groupCount) groups[gi].push(tab);
    }
    return groups.filter((g) => g.length > 0);
  }, [tabAssignments, groupCount]);

  const handleSave = useCallback(async () => {
    const groups = buildTabGroups();
    if (groups.length === 0) {
      setError('Assign at least one tab to a group');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await saveSheetsConfig({
        spreadsheet_url: spreadsheetUrl.trim(),
        tab_groups: groups,
        auto_post_threshold: autoPostThreshold,
      });
      setSuccess(true);
      onSaved(result);
      window.setTimeout(onClose, 900);
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : null;
      setError(typeof msg === 'string' ? msg : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }, [autoPostThreshold, buildTabGroups, onClose, onSaved, spreadsheetUrl]);

  const assignedCount = Object.values(tabAssignments).filter((v) => v >= 0).length;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-blue-950/30 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="google-sheet-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-blue-200/70 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-blue-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Table2 className="h-5 w-5 text-blue-600" />
            <h2 id="google-sheet-modal-title" className="text-lg font-semibold text-slate-800">
              Configure tab groups
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <p className="text-xs text-slate-500">
            Spreadsheet verified with <strong className="text-slate-700">{tabs.length}</strong> tab
            {tabs.length === 1 ? '' : 's'}. Auto-post threshold ({autoPostThreshold}) is set in Settings below.
          </p>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">Assign tabs to groups</label>
              <button
                type="button"
                onClick={() => void handleRefreshTabs()}
                disabled={refreshing}
                className="flex items-center gap-1 text-xs text-slate-500 transition hover:text-blue-600"
                title="Re-fetch tabs from the spreadsheet"
              >
                <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
            <p className="mb-3 text-xs text-slate-500">
              Jobs round-robin between groups. All tabs in the same group receive the same job URL.
            </p>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              {Array.from({ length: groupCount }).map((_, gi) => {
                const c = GROUP_COLORS[gi % GROUP_COLORS.length];
                const count = Object.values(tabAssignments).filter((v) => v === gi).length;
                return (
                  <div
                    key={gi}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${c.bg} ${c.border} ${c.text}`}
                  >
                    <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                    Group {gi + 1}
                    <span className="text-[10px] opacity-70">({count})</span>
                    {groupCount > 1 && (
                      <button
                        type="button"
                        onClick={() => removeGroup(gi)}
                        className="ml-0.5 rounded-full p-0.5 transition hover:bg-black/10"
                        title={`Remove group ${gi + 1}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                );
              })}
              {groupCount < GROUP_COLORS.length && (
                <button
                  type="button"
                  onClick={addGroup}
                  className="flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-500 transition hover:bg-slate-50"
                >
                  <Plus className="h-3 w-3" />
                  Add group
                </button>
              )}
            </div>

            <div className="max-h-52 space-y-1.5 overflow-y-auto">
              {tabs.map((tab) => {
                const gi = tabAssignments[tab] ?? -1;
                const c = gi >= 0 ? GROUP_COLORS[gi % GROUP_COLORS.length] : null;
                return (
                  <div
                    key={tab}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${
                      c ? `${c.bg} ${c.border} ${c.text}` : 'border-slate-200 bg-white text-slate-700'
                    }`}
                  >
                    <span className="font-medium">{tab}</span>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: groupCount }).map((_, idx) => {
                        const gc = GROUP_COLORS[idx % GROUP_COLORS.length];
                        const isActive = gi === idx;
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => assignTab(tab, isActive ? -1 : idx)}
                            className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-bold transition ${
                              isActive
                                ? `${gc.dot} border-transparent text-white shadow-sm`
                                : 'border-slate-300 bg-white text-slate-500 hover:border-slate-400'
                            }`}
                            title={
                              isActive ? `Remove from Group ${idx + 1}` : `Assign to Group ${idx + 1}`
                            }
                          >
                            {isActive ? <Check className="h-3 w-3" strokeWidth={3} /> : idx + 1}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              {assignedCount} of {tabs.length} tabs assigned
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || assignedCount === 0}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? 'Saving…' : success ? 'Saved!' : 'Save configuration'}
          </button>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              <Check className="h-4 w-4" />
              Google Sheet integration configured successfully!
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
