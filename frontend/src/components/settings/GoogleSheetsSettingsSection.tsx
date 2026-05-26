import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Table2,
  Unplug,
  Zap,
} from 'lucide-react';
import {
  disconnectSheets,
  fetchSheetsConfig,
  fetchSheetsStatus,
  saveAutoPostThreshold,
  verifySpreadsheet,
} from '../../api/googleSheetsApi';
import type { SheetsConfig, SheetsConfigSaveResult, SheetsStatus } from '../../types/googleSheets';
import { GoogleSheetTabGroupsModal } from './GoogleSheetTabGroupsModal';

const SHEETS_URL_RE = /docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+/;
const DEFAULT_AUTO_POST_THRESHOLD = 75;
const AUTO_POST_PRESETS = [0, 60, 70, 75, 80] as const;

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const detail = (err as { response?: { data?: { detail?: string } } }).response?.data?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  return fallback;
}

function SectionMessage({ ok, text }: { ok?: boolean; text: string }) {
  if (!text) return null;
  return (
    <p
      className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${
        ok ? 'text-emerald-700' : 'text-rose-700'
      }`}
    >
      {ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      {text}
    </p>
  );
}

export function GoogleSheetsSettingsSection() {
  const [serverStatus, setServerStatus] = useState<SheetsStatus | null>(null);
  const [savedConfig, setSavedConfig] = useState<SheetsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [enabled, setEnabled] = useState(false);
  const [spreadsheetUrl, setSpreadsheetUrl] = useState('');
  const [verifyState, setVerifyState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [verifyError, setVerifyError] = useState('');
  const [verifyTabCount, setVerifyTabCount] = useState<number | null>(null);
  const [verifiedTabs, setVerifiedTabs] = useState<string[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [isChangingSheet, setIsChangingSheet] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [actionOk, setActionOk] = useState(false);

  const [autoPostThreshold, setAutoPostThreshold] = useState(DEFAULT_AUTO_POST_THRESHOLD);
  const [savedAutoPostThreshold, setSavedAutoPostThreshold] = useState(DEFAULT_AUTO_POST_THRESHOLD);
  const [autoPostSaving, setAutoPostSaving] = useState(false);
  const [autoPostSaveMsg, setAutoPostSaveMsg] = useState('');
  const [autoPostSaveOk, setAutoPostSaveOk] = useState(false);

  const configured = Boolean(savedConfig?.configured);
  const serverReady = Boolean(serverStatus?.server_configured);
  const serviceAccountEmail = serverStatus?.service_account_email ?? null;

  const applyLoadedConfig = useCallback((config: SheetsConfig) => {
    setSavedConfig(config);
    const threshold = config.auto_post_threshold ?? DEFAULT_AUTO_POST_THRESHOLD;
    setAutoPostThreshold(threshold);
    setSavedAutoPostThreshold(threshold);
    if (config.configured) {
      setEnabled(true);
      setSpreadsheetUrl(config.spreadsheet_url ?? '');
      setVerifyState('ok');
      setVerifyTabCount(config.assigned_tab_count ?? null);
      setIsChangingSheet(false);
    } else {
      setEnabled(false);
      setSpreadsheetUrl('');
      setVerifyState('idle');
      setVerifyTabCount(null);
      setVerifiedTabs([]);
      setIsChangingSheet(false);
      setAutoPostThreshold(DEFAULT_AUTO_POST_THRESHOLD);
      setSavedAutoPostThreshold(DEFAULT_AUTO_POST_THRESHOLD);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [status, config] = await Promise.all([fetchSheetsStatus(), fetchSheetsConfig()]);
      setServerStatus(status);
      applyLoadedConfig(config);
    } catch (err: unknown) {
      setLoadError(extractErrorMessage(err, 'Failed to load Google Sheets settings.'));
    } finally {
      setLoading(false);
    }
  }, [applyLoadedConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!actionOk) return;
    const t = window.setTimeout(() => setActionOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [actionOk]);

  useEffect(() => {
    if (!autoPostSaveOk) return;
    const t = window.setTimeout(() => setAutoPostSaveOk(false), 3000);
    return () => window.clearTimeout(t);
  }, [autoPostSaveOk]);

  const autoPostChanged = autoPostThreshold !== savedAutoPostThreshold;
  const autoPostSaveEnabled = configured && autoPostChanged;

  const handleAutoPostChange = (value: number) => {
    setAutoPostThreshold(Math.max(0, Math.min(100, value)));
    setAutoPostSaveMsg('');
  };

  const handleSaveAutoPostThreshold = async () => {
    if (!configured || !autoPostChanged) return;
    setAutoPostSaving(true);
    setAutoPostSaveMsg('');
    try {
      const result = await saveAutoPostThreshold(autoPostThreshold);
      setSavedAutoPostThreshold(result.auto_post_threshold);
      setAutoPostThreshold(result.auto_post_threshold);
      applyLoadedConfig({
        configured: true,
        spreadsheet_url: result.spreadsheet_url,
        tab_groups: result.tab_groups,
        auto_post_threshold: result.auto_post_threshold,
        group_count: result.group_count,
        assigned_tab_count: result.assigned_tab_count,
      });
      setAutoPostSaveOk(true);
      setAutoPostSaveMsg(`Auto-post threshold saved at ${result.auto_post_threshold}.`);
    } catch (err: unknown) {
      setAutoPostSaveOk(false);
      setAutoPostSaveMsg(extractErrorMessage(err, 'Failed to save auto-post threshold.'));
    } finally {
      setAutoPostSaving(false);
    }
  };

  const handleToggleEnabled = (next: boolean) => {
    setActionMsg('');
    if (next) {
      setEnabled(true);
      if (configured && savedConfig?.spreadsheet_url) {
        setSpreadsheetUrl(savedConfig.spreadsheet_url);
      }
      return;
    }

    if (configured) {
      setDisconnectConfirm(true);
      return;
    }

    setEnabled(false);
    setSpreadsheetUrl('');
    setVerifyState('idle');
    setVerifyError('');
    setVerifyTabCount(null);
    setVerifiedTabs([]);
    setModalOpen(false);
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setActionMsg('');
    try {
      await disconnectSheets();
      applyLoadedConfig({ configured: false });
      setDisconnectConfirm(false);
      setEnabled(false);
      setSpreadsheetUrl('');
      setVerifyState('idle');
      setVerifyError('');
      setVerifyTabCount(null);
      setVerifiedTabs([]);
      setModalOpen(false);
      setActionOk(true);
      setActionMsg('Google Sheets integration disconnected.');
    } catch (err: unknown) {
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Failed to disconnect Google Sheets.'));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleVerifyAndConnect = async () => {
    const url = spreadsheetUrl.trim();
    if (!url) {
      setVerifyState('error');
      setVerifyError('Enter a Google Sheet URL.');
      return;
    }
    if (!SHEETS_URL_RE.test(url)) {
      setVerifyState('error');
      setVerifyError('Enter a valid Google Sheets URL (docs.google.com/spreadsheets/d/…).');
      return;
    }

    setVerifyState('loading');
    setVerifyError('');
    setActionMsg('');
    try {
      const result = await verifySpreadsheet(url);
      setVerifiedTabs(result.tabs);
      setVerifyTabCount(result.tab_count);
      setVerifyState('ok');
      setModalOpen(true);
    } catch (err: unknown) {
      setVerifyState('error');
      setVerifyError(extractErrorMessage(err, 'Could not access the spreadsheet.'));
    }
  };

  const handleEditGroups = async () => {
    const url = (savedConfig?.spreadsheet_url ?? spreadsheetUrl).trim();
    if (!url) return;

    setVerifyState('loading');
    setVerifyError('');
    try {
      const result = await verifySpreadsheet(url);
      setSpreadsheetUrl(url);
      setVerifiedTabs(result.tabs);
      setVerifyTabCount(result.tab_count);
      setVerifyState('ok');
      setModalOpen(true);
    } catch (err: unknown) {
      setVerifyState('error');
      setVerifyError(extractErrorMessage(err, 'Could not refresh spreadsheet tabs.'));
    }
  };

  const handleChangeSheet = () => {
    setIsChangingSheet(true);
    setSpreadsheetUrl('');
    setVerifyState('idle');
    setVerifyError('');
    setVerifyTabCount(null);
    setVerifiedTabs([]);
    setModalOpen(false);
  };

  const handleSaved = (result: SheetsConfigSaveResult) => {
    const threshold = result.auto_post_threshold ?? autoPostThreshold;
    setSavedAutoPostThreshold(threshold);
    setAutoPostThreshold(threshold);
    applyLoadedConfig({
      configured: true,
      spreadsheet_url: result.spreadsheet_url,
      tab_groups: result.tab_groups,
      auto_post_threshold: result.auto_post_threshold,
      group_count: result.group_count,
      assigned_tab_count: result.assigned_tab_count,
    });
    setSpreadsheetUrl(result.spreadsheet_url);
    setVerifyTabCount(result.assigned_tab_count);
    setActionOk(true);
    setActionMsg('Google Sheets configuration saved.');
    setModalOpen(false);
    setIsChangingSheet(false);
  };

  const showSetupForm = enabled && (!configured || isChangingSheet);
  const showConfiguredSummary = enabled && configured && !isChangingSheet;

  return (
    <>
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white">
            <Table2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-slate-900">Google Sheets integration</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              Post job URLs to shared spreadsheet tabs using round-robin groups. Verify access first,
              then assign tabs in the configuration modal.
            </p>

            {loading ? (
              <p className="mt-4 text-sm text-slate-500">Loading Google Sheets settings…</p>
            ) : loadError ? (
              <SectionMessage ok={false} text={loadError} />
            ) : (
              <>
                {!serverReady && (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Server Google credentials are not configured. Set{' '}
                      <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">GOOGLE_SHEETS_CREDENTIALS_PATH</code>{' '}
                      and place the service account JSON on the server before users can connect a sheet.
                    </span>
                  </div>
                )}

                {serverReady && serviceAccountEmail && (
                  <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                    Share your spreadsheet with{' '}
                    <code className="rounded bg-white px-1.5 py-0.5 text-xs font-mono text-slate-800">
                      {serviceAccountEmail}
                    </code>{' '}
                    (Editor access) before verifying.
                  </div>
                )}

                <label className="mt-4 flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={!serverReady || disconnecting}
                    onChange={(e) => handleToggleEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-sm font-medium text-slate-800">Enable Google Sheets integration</span>
                </label>

                {enabled && (
                  <div className="mt-4 rounded-xl border border-teal-100 bg-teal-50/40 p-4">
                    <h3 className="text-sm font-bold text-slate-900">Auto-post score threshold</h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600">
                      When auto-post runs after job analysis, only jobs with a match score at or above this
                      value are written to your sheet. Set to 0 to post all analyzed jobs.
                    </p>

                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
                          <label htmlFor="sheets-auto-post-slider">Minimum match score</label>
                          <span className="tabular-nums text-teal-800">{autoPostThreshold}</span>
                        </div>
                        <input
                          id="sheets-auto-post-slider"
                          type="range"
                          min={0}
                          max={100}
                          value={autoPostThreshold}
                          onChange={(e) => handleAutoPostChange(Number(e.target.value))}
                          disabled={autoPostSaving}
                          className="h-2 w-full cursor-pointer accent-teal-600"
                        />
                        <div className="mt-1 flex w-full justify-between text-[10px] text-slate-400">
                          <span>0 (all)</span>
                          <span>100</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <label htmlFor="sheets-auto-post-exact" className="text-xs font-semibold text-slate-700">
                            Exact score
                          </label>
                          <input
                            id="sheets-auto-post-exact"
                            type="number"
                            min={0}
                            max={100}
                            value={autoPostThreshold}
                            onChange={(e) => handleAutoPostChange(Number(e.target.value) || 0)}
                            disabled={autoPostSaving}
                            className="mt-1 w-24 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm focus:border-teal-400 focus:outline-none focus:ring-2 focus:ring-teal-200"
                          />
                        </div>
                        <div className="flex flex-wrap gap-2 pb-[2px]">
                          {AUTO_POST_PRESETS.map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => handleAutoPostChange(preset)}
                              disabled={autoPostSaving}
                              className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                                autoPostThreshold === preset
                                  ? 'border-teal-400 bg-teal-100 text-teal-900'
                                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                              }`}
                            >
                              {preset === 0 ? 'All (0)' : preset}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {configured ? (
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleSaveAutoPostThreshold()}
                          disabled={!autoPostSaveEnabled || autoPostSaving}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {autoPostSaving ? <Loader2 size={14} className="animate-spin" /> : null}
                          {autoPostSaving ? 'Saving…' : 'Save auto-post threshold'}
                        </button>
                        {!autoPostChanged && (
                          <span className="text-xs text-slate-500">
                            Saved threshold: <strong className="text-slate-700">{savedAutoPostThreshold}</strong>
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-slate-500">
                        This threshold is applied when you save tab groups after verifying your sheet.
                      </p>
                    )}

                    {autoPostSaveMsg && <SectionMessage ok={autoPostSaveOk} text={autoPostSaveMsg} />}
                  </div>
                )}

                {showSetupForm && (
                  <div className="mt-4 space-y-3">
                    <div>
                      <label htmlFor="google-sheet-url" className="text-xs font-semibold text-slate-700">
                        Google Sheet URL
                      </label>
                      <input
                        id="google-sheet-url"
                        type="url"
                        value={spreadsheetUrl}
                        onChange={(e) => {
                          setSpreadsheetUrl(e.target.value);
                          setVerifyState('idle');
                          setVerifyError('');
                        }}
                        placeholder="https://docs.google.com/spreadsheets/d/..."
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleVerifyAndConnect();
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleVerifyAndConnect()}
                      disabled={verifyState === 'loading' || !spreadsheetUrl.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {verifyState === 'loading' ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Zap size={14} />
                      )}
                      {verifyState === 'loading' ? 'Verifying…' : 'Verify & connect'}
                    </button>
                    {verifyState === 'ok' && verifyTabCount != null && !modalOpen && (
                      <p className="text-sm text-emerald-700">
                        Connected — {verifyTabCount} tab{verifyTabCount === 1 ? '' : 's'} found. Open the
                        configuration modal to assign groups.
                      </p>
                    )}
                    {verifyError && <SectionMessage ok={false} text={verifyError} />}
                  </div>
                )}

                {showConfiguredSummary && savedConfig && (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2.5 text-sm text-emerald-900">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="inline-flex items-center gap-1 font-semibold">
                          <CheckCircle2 size={15} />
                          Connected
                        </span>
                        <span>
                          {savedConfig.assigned_tab_count ?? 0} tab
                          {(savedConfig.assigned_tab_count ?? 0) === 1 ? '' : 's'} in{' '}
                          {savedConfig.group_count ?? 0} group
                          {(savedConfig.group_count ?? 0) === 1 ? '' : 's'}
                        </span>
                        <span>Auto-post ≥ {savedAutoPostThreshold}</span>
                      </div>
                      <a
                        href={savedConfig.spreadsheet_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-800 underline-offset-2 hover:underline"
                      >
                        Open spreadsheet
                        <ExternalLink size={12} />
                      </a>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleEditGroups()}
                        disabled={verifyState === 'loading'}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-50"
                      >
                        {verifyState === 'loading' ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : null}
                        Edit tab groups
                      </button>
                      <button
                        type="button"
                        onClick={handleChangeSheet}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
                      >
                        Change sheet URL
                      </button>
                      <button
                        type="button"
                        onClick={() => setDisconnectConfirm(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 transition hover:bg-rose-100"
                      >
                        <Unplug size={14} />
                        Disconnect
                      </button>
                    </div>
                    {verifyError && <SectionMessage ok={false} text={verifyError} />}
                  </div>
                )}

                {actionMsg && <SectionMessage ok={actionOk} text={actionMsg} />}
              </>
            )}
          </div>
        </div>
      </section>

      {disconnectConfirm && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-900">Disconnect Google Sheets?</h3>
            <p className="mt-2 text-sm text-slate-600">
              Job posting to the sheet will stop. URLs already written to the spreadsheet are not removed.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDisconnectConfirm(false)}
                disabled={disconnecting}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={disconnecting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {disconnecting ? <Loader2 size={14} className="animate-spin" /> : null}
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalOpen && verifiedTabs.length > 0 && (
        <GoogleSheetTabGroupsModal
          spreadsheetUrl={spreadsheetUrl.trim()}
          tabs={verifiedTabs}
          tabGroups={isChangingSheet ? [] : (savedConfig?.tab_groups ?? [])}
          autoPostThreshold={autoPostThreshold}
          onClose={() => setModalOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
