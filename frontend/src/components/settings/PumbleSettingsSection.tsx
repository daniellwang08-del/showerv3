import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Lock,
  MessageSquare,
  Plus,
  Trash2,
  Unplug,
  Zap,
} from 'lucide-react';
import {
  deletePumbleIntegration,
  disconnectPumble,
  fetchPumbleChannels,
  fetchPumbleConfig,
  fetchPumbleStatus,
  savePumbleAutoPostSettings,
  savePumbleConfig,
  setPumbleAllEnabled,
  setPumbleIntegrationEnabled,
  verifyPumbleApiKey,
} from '../../api/pumbleApi';
import type { PumbleChannel, PumbleIntegration } from '../../types/pumble';
import {
  autoPostFiltersEqual,
  DEFAULT_AUTO_POST_FILTERS,
  normalizeAutoPostFilters,
  type AutoPostFilters,
} from '../../types/autoPostFilters';
import { AutoPostFiltersEditor } from './AutoPostFiltersEditor';
import { BrandedLoader } from '../layout/BrandedLoader';

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

type PumbleSettingsSectionProps = {
  /** When `page`, hide the built-in icon header (Integrations page supplies logos). */
  variant?: 'standalone' | 'page';
};

export function PumbleSettingsSection({ variant = 'standalone' }: PumbleSettingsSectionProps) {
  const isPage = variant === 'page';
  const [integrationAvailable, setIntegrationAvailable] = useState(true);
  const [integrations, setIntegrations] = useState<PumbleIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [enabled, setEnabled] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [addingDestination, setAddingDestination] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [verifyState, setVerifyState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [verifyError, setVerifyError] = useState('');
  const [verifiedWorkspaceId, setVerifiedWorkspaceId] = useState<string | null>(null);
  const [channels, setChannels] = useState<PumbleChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [saving, setSaving] = useState(false);

  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState('');
  const [actionOk, setActionOk] = useState(false);

  const [autoPostThreshold, setAutoPostThreshold] = useState(DEFAULT_AUTO_POST_THRESHOLD);
  const [savedAutoPostThreshold, setSavedAutoPostThreshold] = useState(DEFAULT_AUTO_POST_THRESHOLD);
  const [autoPostFilters, setAutoPostFilters] = useState<AutoPostFilters>(DEFAULT_AUTO_POST_FILTERS);
  const [savedAutoPostFilters, setSavedAutoPostFilters] = useState<AutoPostFilters>(DEFAULT_AUTO_POST_FILTERS);
  const [autoPostSaving, setAutoPostSaving] = useState(false);
  const [autoPostSaveMsg, setAutoPostSaveMsg] = useState('');
  const [autoPostSaveOk, setAutoPostSaveOk] = useState(false);

  const configured = integrations.length > 0;
  const selectedChannel = channels.find((c) => c.id === selectedChannelId);
  const connectedChannelIds = new Set(integrations.map((i) => i.channel_id));

  const applyLoadedConfig = useCallback(
    (config: {
      configured?: boolean;
      integrations?: PumbleIntegration[];
      auto_post_threshold?: number;
      auto_post_filters?: AutoPostFilters | null;
    }) => {
      const list = config.integrations ?? [];
      setIntegrations(list);
      const threshold = config.auto_post_threshold ?? DEFAULT_AUTO_POST_THRESHOLD;
      setAutoPostThreshold(threshold);
      setSavedAutoPostThreshold(threshold);
      const filtersRaw =
        config.auto_post_filters ??
        list[0]?.auto_post_filters ??
        null;
      const filters = normalizeAutoPostFilters(filtersRaw);
      setAutoPostFilters(filters);
      setSavedAutoPostFilters(filters);
      // Global auto-post = any destination currently enabled (soft flags).
      setEnabled(list.length > 0 && list.some((i) => i.is_enabled !== false));
      if (list.length === 0) {
        setAddingDestination(false);
        resetAddForm();
        setAutoPostThreshold(DEFAULT_AUTO_POST_THRESHOLD);
        setSavedAutoPostThreshold(DEFAULT_AUTO_POST_THRESHOLD);
        setAutoPostFilters(DEFAULT_AUTO_POST_FILTERS);
        setSavedAutoPostFilters(DEFAULT_AUTO_POST_FILTERS);
      }
    },
    [],
  );

  const resetAddForm = () => {
    setApiKey('');
    setDestinationLabel('');
    setVerifyState('idle');
    setVerifyError('');
    setChannels([]);
    setSelectedChannelId('');
    setVerifiedWorkspaceId(null);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [status, config] = await Promise.all([fetchPumbleStatus(), fetchPumbleConfig()]);
      setIntegrationAvailable(status.integration_available !== false);
      applyLoadedConfig(config);
    } catch (err: unknown) {
      setLoadError(extractErrorMessage(err, 'Failed to load Pumble settings.'));
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

  const autoPostChanged =
    autoPostThreshold !== savedAutoPostThreshold ||
    !autoPostFiltersEqual(autoPostFilters, savedAutoPostFilters);

  const handleAutoPostChange = (value: number) => {
    setAutoPostThreshold(Math.max(0, Math.min(100, value)));
    setAutoPostSaveMsg('');
  };

  const handleToggleEnabled = async (next: boolean) => {
    setActionMsg('');
    if (!configured) {
      setEnabled(next);
      if (next) setAddingDestination(true);
      else {
        setAddingDestination(false);
        resetAddForm();
      }
      return;
    }

    setTogglingEnabled(true);
    try {
      const result = await setPumbleAllEnabled(next);
      applyLoadedConfig(result);
      setActionOk(true);
      setActionMsg(
        next
          ? 'Auto-post enabled for all Pumble destinations.'
          : 'Auto-post paused. Connected destinations were kept.',
      );
    } catch (err: unknown) {
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Failed to update auto-post setting.'));
    } finally {
      setTogglingEnabled(false);
    }
  };

  const handleToggleDestination = async (integration: PumbleIntegration, next: boolean) => {
    setTogglingId(integration.id);
    setActionMsg('');
    try {
      const result = await setPumbleIntegrationEnabled(integration.id, next);
      setIntegrations((prev) => {
        const nextList = prev.map((item) =>
          item.id === result.integration.id ? result.integration : item,
        );
        setEnabled(nextList.some((i) => i.is_enabled !== false));
        return nextList;
      });
      setActionOk(true);
      setActionMsg(
        next
          ? `Auto-post enabled for ${result.integration.label}.`
          : `Auto-post paused for ${result.integration.label}.`,
      );
    } catch (err: unknown) {
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Failed to update destination.'));
    } finally {
      setTogglingId(null);
    }
  };

  const handleDisconnectAll = async () => {
    setDisconnecting(true);
    setActionMsg('');
    try {
      await disconnectPumble();
      applyLoadedConfig({ configured: false, integrations: [] });
      setDisconnectConfirm(false);
      setEnabled(false);
      setAddingDestination(false);
      resetAddForm();
      setActionOk(true);
      setActionMsg('All Pumble destinations disconnected.');
    } catch (err: unknown) {
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Failed to disconnect Pumble.'));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleRemoveDestination = async (integrationId: string) => {
    setRemovingId(integrationId);
    setActionMsg('');
    try {
      await deletePumbleIntegration(integrationId);
      const config = await fetchPumbleConfig();
      applyLoadedConfig(config);
      setActionOk(true);
      setActionMsg('Pumble destination removed.');
    } catch (err: unknown) {
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Failed to remove destination.'));
    } finally {
      setRemovingId(null);
    }
  };

  const handleVerifyAndLoadChannels = async () => {
    const key = apiKey.trim();
    if (!key) {
      setVerifyState('error');
      setVerifyError('Enter your Pumble API key.');
      return;
    }

    setVerifyState('loading');
    setVerifyError('');
    setActionMsg('');
    setChannelsLoading(true);
    try {
      const verify = await verifyPumbleApiKey(key);
      setVerifiedWorkspaceId(verify.workspace_id ?? null);
      const channelResult = await fetchPumbleChannels(key);
      const available = channelResult.channels.filter((c) => !connectedChannelIds.has(c.id));
      setChannels(available);
      if (available.length === 0) {
        setVerifyState('error');
        setVerifyError(
          channelResult.channels.length === 0
            ? 'No channels found. Ensure the API addon is installed and you have channel access.'
            : 'All accessible channels are already connected. Use a different API key or workspace.',
        );
        return;
      }
      setSelectedChannelId(available[0].id);
      setVerifyState('ok');
    } catch (err: unknown) {
      setVerifyState('error');
      setVerifyError(extractErrorMessage(err, 'Could not verify API key or load channels.'));
    } finally {
      setChannelsLoading(false);
    }
  };

  const handleSaveDestination = async () => {
    const key = apiKey.trim();
    if (!key) {
      setVerifyError('Enter and verify your API key first.');
      return;
    }
    if (!selectedChannelId) {
      setVerifyError('Select a channel.');
      return;
    }
    const channel = channels.find((c) => c.id === selectedChannelId);
    if (!channel) {
      setVerifyError('Selected channel is no longer available.');
      return;
    }

    setSaving(true);
    setVerifyError('');
    setActionMsg('');
    try {
      await savePumbleConfig({
        api_key: key,
        channel_id: channel.id,
        channel_name: channel.name,
        workspace_id: verifiedWorkspaceId,
        label: destinationLabel.trim() || undefined,
        auto_post_threshold: autoPostThreshold,
      });
      const config = await fetchPumbleConfig();
      applyLoadedConfig(config);
      setAddingDestination(false);
      resetAddForm();
      setActionOk(true);
      setActionMsg('Pumble destination added.');
    } catch (err: unknown) {
      setActionOk(false);
      setActionMsg(extractErrorMessage(err, 'Failed to save Pumble destination.'));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAutoPostSettings = async () => {
    if (!configured || !autoPostChanged) return;
    setAutoPostSaving(true);
    setAutoPostSaveMsg('');
    try {
      const result = await savePumbleAutoPostSettings({
        auto_post_threshold: autoPostThreshold,
        auto_post_filters: normalizeAutoPostFilters(autoPostFilters),
      });
      setSavedAutoPostThreshold(result.auto_post_threshold);
      setAutoPostThreshold(result.auto_post_threshold);
      const filters = normalizeAutoPostFilters(result.auto_post_filters);
      setAutoPostFilters(filters);
      setSavedAutoPostFilters(filters);
      setAutoPostSaveOk(true);
      setAutoPostSaveMsg(
        `Auto-post settings saved (score ≥ ${result.auto_post_threshold}) for all destinations.`,
      );
    } catch (err: unknown) {
      setAutoPostSaveOk(false);
      setAutoPostSaveMsg(extractErrorMessage(err, 'Failed to save auto-post settings.'));
    } finally {
      setAutoPostSaving(false);
    }
  };

  return (
    <>
      <section
        className={
          isPage
            ? 'min-w-0 flex-1'
            : 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6'
        }
      >
        <div className={isPage ? 'min-w-0' : 'flex items-start gap-3'}>
          {!isPage ? (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white">
              <MessageSquare size={20} />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            {!isPage ? (
              <>
                <h2 className="text-base font-bold text-slate-900">Pumble integration</h2>
                <p className="mt-0.5 text-sm leading-snug text-slate-500">
                  Post job URLs to one or more Pumble channels as thread replies under a daily Atomspace
                  header message.
                </p>
              </>
            ) : null}

            {loading ? (
              <BrandedLoader compact label="Loading Pumble…" className="mt-2" />
            ) : loadError ? (
              <SectionMessage ok={false} text={loadError} />
            ) : (
              <>
                {!integrationAvailable && (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Pumble integration is currently unavailable.</span>
                  </div>
                )}

                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                  Install the <strong>API</strong> addon in Pumble, generate an API key, then add each
                  workspace/channel you want to post to. For private channels, ensure the API addon bot
                  is a member.
                </div>

                {!configured ? (
                  <label className="mt-4 flex cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={!integrationAvailable || disconnecting || togglingEnabled}
                      onChange={(e) => void handleToggleEnabled(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                    />
                    <span className="text-sm font-medium text-slate-800">Connect Pumble</span>
                  </label>
                ) : (
                  <label className="mt-4 flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={!integrationAvailable || disconnecting || togglingEnabled}
                      onChange={(e) => void handleToggleEnabled(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">
                        Auto-post after job analysis
                        {togglingEnabled ? (
                          <Loader2 size={14} className="ml-1.5 inline animate-spin text-slate-400" />
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        Turns auto-post on/off for all destinations without removing them. You can also
                        pause individual channels below.
                      </span>
                    </span>
                  </label>
                )}

                {configured && (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-bold text-slate-900">
                        Connected destinations ({integrations.length})
                      </h3>
                      {!addingDestination && (
                        <button
                          type="button"
                          onClick={() => {
                            setAddingDestination(true);
                            resetAddForm();
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-100"
                        >
                          <Plus size={13} />
                          Add destination
                        </button>
                      )}
                    </div>

                    <ul className="space-y-2">
                      {integrations.map((integration) => (
                        <li
                          key={integration.id}
                          className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 ${
                            integration.is_enabled
                              ? 'border-violet-100 bg-violet-50/70'
                              : 'border-slate-200 bg-slate-50'
                          }`}
                        >
                          <div className="min-w-0 text-sm text-violet-900">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="inline-flex items-center gap-1 font-semibold">
                                <CheckCircle2 size={14} />
                                {integration.label}
                              </span>
                              <span className={integration.is_enabled ? 'text-violet-800' : 'text-slate-600'}>
                                #{integration.channel_name}
                              </span>
                              {!integration.is_enabled && (
                                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                                  Paused
                                </span>
                              )}
                            </div>
                            {integration.api_key_hint && (
                              <p className="mt-0.5 text-xs text-violet-700">Key {integration.api_key_hint}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-slate-700">
                              <input
                                type="checkbox"
                                checked={integration.is_enabled !== false}
                                disabled={togglingId === integration.id}
                                onChange={(e) => void handleToggleDestination(integration, e.target.checked)}
                                className="h-3.5 w-3.5 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                              />
                              Auto
                              {togglingId === integration.id ? (
                                <Loader2 size={11} className="animate-spin text-slate-400" />
                              ) : null}
                            </label>
                            <button
                              type="button"
                              onClick={() => void handleRemoveDestination(integration.id)}
                              disabled={removingId === integration.id}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                              title="Remove destination"
                            >
                              {removingId === integration.id ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Trash2 size={12} />
                              )}
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>

                    <p className="text-xs text-violet-800">
                      Daily header format:{' '}
                      <code className="rounded bg-white/80 px-1">M/D/YYYY (Atomspace post)</code>
                    </p>

                    <button
                      type="button"
                      onClick={() => setDisconnectConfirm(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 transition hover:bg-rose-100"
                    >
                      <Unplug size={14} />
                      Disconnect all
                    </button>
                  </div>
                )}

                {configured && (
                  <div className={`mt-4 rounded-xl border p-4 ${enabled ? 'border-violet-100 bg-violet-50/40' : 'border-slate-200 bg-slate-50/60'}`}>
                    <h3 className="text-sm font-bold text-slate-900">Auto-post settings</h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600">
                      Shared by all destinations. After match analysis, jobs must meet the score threshold
                      and every active filter below before posting to enabled channels.
                    </p>

                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-700">
                          <label htmlFor="pumble-auto-post-slider">Minimum match score</label>
                          <span className="tabular-nums text-violet-800">{autoPostThreshold}</span>
                        </div>
                        <input
                          id="pumble-auto-post-slider"
                          type="range"
                          min={0}
                          max={100}
                          value={autoPostThreshold}
                          onChange={(e) => handleAutoPostChange(Number(e.target.value))}
                          disabled={autoPostSaving}
                          className="h-2 w-full cursor-pointer accent-violet-600"
                        />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {AUTO_POST_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => handleAutoPostChange(preset)}
                            disabled={autoPostSaving}
                            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                              autoPostThreshold === preset
                                ? 'border-violet-400 bg-violet-100 text-violet-900'
                                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                            }`}
                          >
                            {preset === 0 ? 'All (0)' : preset}
                          </button>
                        ))}
                      </div>

                      <div className="border-t border-violet-100/80 pt-4">
                        <AutoPostFiltersEditor
                          value={autoPostFilters}
                          onChange={(next) => {
                            setAutoPostFilters(next);
                            setAutoPostSaveMsg('');
                          }}
                          disabled={autoPostSaving}
                          accent="violet"
                        />
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleSaveAutoPostSettings()}
                        disabled={!autoPostChanged || autoPostSaving}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {autoPostSaving ? <Loader2 size={14} className="animate-spin" /> : null}
                        {autoPostSaving ? 'Saving…' : 'Save auto-post settings'}
                      </button>
                      {!autoPostChanged && (
                        <span className="text-xs text-slate-500">
                          Saved score ≥ <strong className="text-slate-700">{savedAutoPostThreshold}</strong>
                        </span>
                      )}
                    </div>

                    {autoPostSaveMsg && <SectionMessage ok={autoPostSaveOk} text={autoPostSaveMsg} />}
                  </div>
                )}

                {(addingDestination || (!configured && enabled)) && (
                  <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-bold text-slate-900">
                        {configured ? 'Add another destination' : 'Connect your first destination'}
                      </h3>
                      {configured && (
                        <button
                          type="button"
                          onClick={() => {
                            setAddingDestination(false);
                            resetAddForm();
                          }}
                          className="text-xs font-semibold text-slate-500 hover:text-slate-700"
                        >
                          Cancel
                        </button>
                      )}
                    </div>

                    <div>
                      <label htmlFor="pumble-api-key" className="text-xs font-semibold text-slate-700">
                        Pumble API key
                      </label>
                      <input
                        id="pumble-api-key"
                        type="password"
                        value={apiKey}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          setVerifyState('idle');
                          setVerifyError('');
                        }}
                        placeholder="Paste API key from Pumble → API → Add API key"
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-200"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleVerifyAndLoadChannels()}
                      disabled={verifyState === 'loading' || channelsLoading || !apiKey.trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-800 transition hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {verifyState === 'loading' || channelsLoading ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Zap size={14} />
                      )}
                      {verifyState === 'loading' || channelsLoading ? 'Verifying…' : 'Verify & load channels'}
                    </button>

                    {verifyState === 'ok' && channels.length > 0 && (
                      <>
                        <div>
                          <label htmlFor="pumble-dest-label" className="text-xs font-semibold text-slate-700">
                            Label (optional)
                          </label>
                          <input
                            id="pumble-dest-label"
                            type="text"
                            value={destinationLabel}
                            onChange={(e) => setDestinationLabel(e.target.value)}
                            placeholder="e.g. Team jobs, Recruiting workspace"
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-200"
                          />
                        </div>

                        <div>
                          <label htmlFor="pumble-channel" className="text-xs font-semibold text-slate-700">
                            Target channel
                          </label>
                          <select
                            id="pumble-channel"
                            value={selectedChannelId}
                            onChange={(e) => setSelectedChannelId(e.target.value)}
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-200"
                          >
                            {channels.map((ch) => (
                              <option key={ch.id} value={ch.id}>
                                {ch.is_private ? '🔒 ' : '# '}
                                {ch.name}
                                {ch.is_private ? ' (private)' : ''}
                              </option>
                            ))}
                          </select>
                          {selectedChannel?.is_private && (
                            <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-700">
                              <Lock size={12} />
                              Private channel - add the API addon bot to this channel in Pumble.
                            </p>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => void handleSaveDestination()}
                          disabled={saving || !selectedChannelId}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                          {saving ? 'Saving…' : 'Save destination'}
                        </button>
                      </>
                    )}

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
            <h3 className="text-lg font-semibold text-slate-900">Disconnect all Pumble destinations?</h3>
            <p className="mt-2 text-sm text-slate-600">
              Job posting to Pumble will stop for all {integrations.length} destination
              {integrations.length === 1 ? '' : 's'}. Messages already posted in Pumble are not removed.
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
                onClick={() => void handleDisconnectAll()}
                disabled={disconnecting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {disconnecting ? <Loader2 size={14} className="animate-spin" /> : null}
                {disconnecting ? 'Disconnecting…' : 'Disconnect all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
