import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as adminApi from '@/api/adminApi';
import * as scraperApi from '@/api/scraperApi';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { LlmKeysResponse, OpsOverview, SystemSettingItem, SystemSettingsResponse } from '@/types/admin';
import { AdminSystemPage } from './AdminSystemPage';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/api/client', () => ({
  apiClient: { post: vi.fn(async () => ({ data: {} })), get: vi.fn(async () => ({ data: [] })) },
}));
vi.mock('@/api/adminApi', () => ({
  fetchSystemSettings: vi.fn(),
  updateSystemSettings: vi.fn(),
  clearSystemSetting: vi.fn(),
  fetchLlmKeys: vi.fn(),
  fetchLlmModelsForEnv: vi.fn(),
  fetchLlmModelsForKey: vi.fn(),
  saveLlmJobBindings: vi.fn(),
  validateLlmKey: vi.fn(),
  createLlmKey: vi.fn(),
  updateLlmKey: vi.fn(),
  deleteLlmKey: vi.fn(),
  fetchOpsOverview: vi.fn(),
  clearQueue: vi.fn(),
  interruptStaleScrapes: vi.fn(),
  fetchBlockedDomains: vi.fn(),
  addBlockedDomain: vi.fn(),
  removeBlockedDomain: vi.fn(),
  fetchMatchEngineShadowStats: vi.fn(),
  triggerMatchEngineBackfill: vi.fn(),
  diagnoseMatchEngine: vi.fn(),
  runLlmBenchmark: vi.fn(),
}));
vi.mock('@/api/scraperApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/scraperApi')>()),
  fetchSyncPlatforms: vi.fn(),
  fetchSyncCheckpoints: vi.fn(),
  fetchJobSyncSchedule: vi.fn(),
  saveJobSyncSchedule: vi.fn(),
  stopJobFetch: vi.fn(),
  fetchSpiders: vi.fn(async () => []),
  fetchSyncStatus: vi.fn(async () => ({ status: 'idle', spider_name: null, message: '' })),
}));

const api = vi.mocked(adminApi);
const scraper = vi.mocked(scraperApi);

const VALUES: Record<string, string | number | boolean> = {
  default_llm_provider: 'openai',
  openai_reasoning_effort: 'low',
  phase_a_max_tokens: 8192,
  phase_b_max_tokens: 16384,
  llm_circuit_breaker_threshold: 3,
  llm_circuit_breaker_cooldown_seconds: 60,
  auto_prepare_daily_cap_per_user: 0,
  auto_prepare_pending_cap_per_user: 20,
  llm_fallback_enabled: false,
  auto_generate_tailored_content: true,
  auto_prepare_enabled: true,
  openai_model: 'gpt-4.1-mini',
  anthropic_model: '',
  gemini_model: 'gemini-2.5-flash',
  openai_timeout_seconds: 60,
  anthropic_timeout_seconds: 60,
  gemini_timeout_seconds: 60,
  match_engine: 'vector',
  extraction_worker_max_jobs: 4,
  analysis_worker_max_jobs: 2,
  tailoring_worker_max_jobs: 2,
  save_worker_max_jobs: 4,
  autopost_worker_max_jobs: 2,
  resume_worker_max_jobs: 2,
  scraper_worker_max_jobs: 1,
  encoding_worker_max_jobs: 2,
  default_min_match_score: 0,
  default_dedup_recycle_days: 60,
  extension_token_expire_days: 30,
  auth_password: '',
  dedup_rule_applied_company_enabled: false,
  dedup_rule_score_comparison_enabled: false,
};

function makeSettings(overrides: Record<string, string | number | boolean> = {}): SystemSettingsResponse {
  const merged = { ...VALUES, ...overrides };
  const settings: SystemSettingItem[] = Object.entries(merged).map(([key, value]) => ({
    key,
    value,
    env_default: VALUES[key],
    overridden: key in overrides,
  }));
  return { settings, secrets_presence: { openai_api_key: true, anthropic_api_key: false, gemini_api_key: false, sentry_dsn: true } };
}

const LLM: LlmKeysResponse = {
  keys: [{ id: 'k1', provider: 'anthropic', label: 'claude-prod', key_hint: 'sk-ant…9f2c', is_enabled: true }],
  bindings: [
    { job_type: 'analysis', label: 'Analysis', description: 'Phase A match scoring', provider_key_id: null, provider: 'openai', model: null },
  ],
  job_types: {},
};

const OPS: OpsOverview = {
  health: { status: 'ok', version: '1', database_connected: true, redis_connected: true, browser_pool_available: 3 },
  scrape: { status: 'idle' },
  recent_scrape_runs: [{ id: 'r1', spider_name: 'dice', status: 'completed', items_scraped: 42, started_at: '2026-10-01T10:00:00Z' }],
  analysis_worker_max_jobs: 2,
  queues: [{ id: 'analysis', name: 'arq:analysis', label: 'Analysis', description: 'Phase A', pending: 17, reachable: true }],
};

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchSystemSettings.mockResolvedValue(makeSettings());
  api.fetchLlmKeys.mockResolvedValue(LLM);
  api.fetchLlmModelsForEnv.mockImplementation(async (provider = 'openai') => ({
    provider,
    models: [],
    chat_models:
      provider === 'openai'
        ? [
            { id: 'gpt-4.1-mini', usable_for_chat: true },
            { id: 'gemini-2.5-flash', usable_for_chat: true },
            { id: 'test-gpt-4o', usable_for_chat: true },
          ]
        : [],
    count: 0,
  }));
  api.fetchLlmModelsForKey.mockResolvedValue({ provider: 'anthropic', models: [], chat_models: [], count: 0 });
  api.fetchOpsOverview.mockResolvedValue(OPS);
  api.fetchBlockedDomains.mockResolvedValue([{ domain: 'spam.example', reason: 'Bot wall' }]);
  api.fetchMatchEngineShadowStats.mockResolvedValue({
    match_engine: 'vector',
    window_days: 30,
    comparisons: 0,
    mean_delta: null,
    mean_absolute_error: null,
    max_absolute_error: null,
    abs_delta_histogram: {},
    jobs_encoded: 1200,
    users_encoded: 8,
    recent: [],
  });
  scraper.fetchSyncPlatforms.mockResolvedValue([
    { name: 'dice', label: 'Dice', requires_auth: false },
    { name: 'rrs', label: 'RRS', requires_auth: false },
  ]);
  scraper.fetchSyncCheckpoints.mockResolvedValue([]);
  scraper.fetchJobSyncSchedule.mockResolvedValue({
    enabled: true,
    cadence: 'daily',
    interval_hours: 4,
    daily_time: '04:30',
    timezone: 'America/Los_Angeles',
    sync_mode: 'incremental',
    lookback_days: 2,
    spider_names: null,
    run_as_user_id: null,
    last_run_at: null,
    last_run_status: null,
    last_run_message: null,
    next_run_at: '2026-10-04T11:30:00Z',
    allowed_timezones: ['America/Los_Angeles', 'UTC'],
  });
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderPage(path = '/admin/settings') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <AdminSystemPage />
          <LocationProbe />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const saveBar = () => screen.getByRole('region', { name: 'Unsaved changes' });

describe('AdminSystemPage', () => {
  it('shows a loading state, then renders the LLM, keys, and sync tabs', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByLabelText('Loading system settings')).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: 'LLM defaults' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Job → model bindings' })).toHaveTextContent('Analysis');

    await user.click(screen.getByRole('tab', { name: 'Keys' }));
    const anthropic = screen.getByRole('region', { name: 'Anthropic' });
    expect(within(anthropic).getByText('claude-prod')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'OpenAI' })).getByText('.env key ready')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Server secrets' })).toHaveTextContent('sentry dsn');

    await user.click(screen.getByRole('tab', { name: 'Job sync' }));
    expect(await screen.findByRole('region', { name: 'Scheduled sync' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Manual date-range sync' })).toBeInTheDocument();
  });

  it('renders the ops, benchmark, and platform tabs', async () => {
    const user = userEvent.setup();
    renderPage('/admin/settings?tab=match');
    expect(await screen.findByRole('region', { name: 'Scoring engine' })).toBeInTheDocument();
    expect(await screen.findByText('1,200')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Workers & queues' }));
    expect(screen.getByRole('region', { name: 'Worker concurrency' })).toBeInTheDocument();
    const queues = await screen.findByRole('table', { name: 'Queues' });
    expect(within(queues).getByText('17')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Benchmark' }));
    const models = screen.getByRole('list', { name: 'Benchmark models' });
    expect(within(models).getByText('gpt-4.1-mini')).toBeInTheDocument();
    expect(within(models).queryByText('test-gpt-4o')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Platform' }));
    expect(await screen.findByText('spam.example')).toBeInTheDocument();
  });

  it('shows an error with retry when settings fail to load', async () => {
    api.fetchSystemSettings.mockRejectedValueOnce({ response: { data: { detail: 'Admin API down' } } });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Admin API down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'LLM defaults' })).toBeInTheDocument();
  });

  it('syncs the active tab with the ?tab= search param', async () => {
    const user = userEvent.setup();
    renderPage('/admin/settings?tab=workers');
    expect(await screen.findByRole('tab', { name: 'Workers & queues' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Keys' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/settings?tab=keys');

    await user.click(screen.getByRole('tab', { name: 'LLM & models' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/settings$/);
  });

  it('keeps a worker draft across tabs, validates it, and saves only changed keys with Ctrl+S', async () => {
    api.updateSystemSettings.mockResolvedValue(makeSettings({ extraction_worker_max_jobs: 6 }));
    const user = userEvent.setup();
    renderPage('/admin/settings?tab=workers');
    const input = await screen.findByLabelText('Extraction');

    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByText('Must be at least 1.')).toBeInTheDocument();
    expect(within(saveBar()).getByRole('button', { name: /Save changes/ })).toBeDisabled();

    fireEvent.change(input, { target: { value: '6' } });
    await user.click(screen.getByRole('tab', { name: 'Platform' }));
    expect(screen.getByRole('tab', { name: /Workers & queues.*unsaved changes/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Workers & queues/ }));
    expect(screen.getByLabelText('Extraction')).toHaveValue(6);
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => expect(api.updateSystemSettings).toHaveBeenCalledWith({ extraction_worker_max_jobs: 6 }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Workers & queues' })).toBeInTheDocument();
  });

  it('saves an immediate toggle optimistically and rolls back on error', async () => {
    let reject: (err: unknown) => void = () => {};
    api.updateSystemSettings.mockImplementation(() => new Promise((_res, rej) => (reject = rej)));
    const user = userEvent.setup();
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Provider fallback' });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(api.updateSystemSettings).toHaveBeenCalledWith({ llm_fallback_enabled: true });
    expect(screen.getByRole('switch', { name: 'Provider fallback' })).toBeChecked();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();

    reject({ response: { data: { detail: 'Read-only replica' } } });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Provider fallback' })).not.toBeChecked());
    expect(toast.error).toHaveBeenCalledWith('Read-only replica');
  });

  it('requires confirmation before starting an encoding backfill', async () => {
    api.triggerMatchEngineBackfill.mockResolvedValue({ enqueued: true, already_running: false });
    const user = userEvent.setup();
    renderPage('/admin/settings?tab=match');
    await user.click(await screen.findByRole('button', { name: 'Backfill encodings' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/every job and user profile/)).toBeInTheDocument();
    expect(api.triggerMatchEngineBackfill).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Start backfill' }));
    await waitFor(() => expect(api.triggerMatchEngineBackfill).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Backfill running/)).toBeInTheDocument();
  });

  it('confirms before clearing a queue and states how many jobs are deleted', async () => {
    api.clearQueue.mockResolvedValue({ keys_deleted: 17 });
    const user = userEvent.setup();
    renderPage('/admin/settings?tab=workers');
    await user.click(await screen.findByRole('button', { name: 'Clear Analysis queue' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Deletes all 17 pending job(s)');
    await user.click(within(dialog).getByRole('button', { name: 'Clear queue' }));
    await waitFor(() => expect(api.clearQueue).toHaveBeenCalledWith('analysis'));
    await waitFor(() => expect(api.fetchOpsOverview).toHaveBeenCalledTimes(2));
  });
});
