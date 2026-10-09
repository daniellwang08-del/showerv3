import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import * as jobSitesApi from '@/api/jobSitesApi';
import * as bridge from '@/lib/extensionBridge';
import type { JobSiteCapturedSession } from '@/lib/extensionBridge';
import { makeConnection, makePlugin, renderPage, stubLayout } from './testUtils';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/api/jobSitesApi', () => ({
  fetchJobSites: vi.fn(),
  connectJobSite: vi.fn(),
  updateJobSite: vi.fn(),
  disconnectJobSite: vi.fn(),
  syncJobSiteNow: vi.fn(),
}));
vi.mock('@/api/googleSheetsApi', () => ({
  fetchSheetsStatus: vi.fn(async () => ({ server_configured: true, service_account_email: 'bot@sa.iam' })),
  fetchSheetsConfig: vi.fn(async () => ({ configured: false })),
}));
vi.mock('@/api/pumbleApi', () => ({
  fetchPumbleStatus: vi.fn(async () => ({ integration_available: true })),
  fetchPumbleConfig: vi.fn(async () => ({ configured: false, integrations: [] })),
}));
vi.mock('@/lib/extensionBridge', () => ({
  detectExtension: vi.fn(),
  startJobSiteConnect: vi.fn(),
  subscribeJobSiteConnect: vi.fn(),
  captureJobSiteNow: vi.fn(),
  focusJobSiteTab: vi.fn(),
  stopJobSiteConnect: vi.fn(),
}));

const api = vi.mocked(jobSitesApi);
const ext = vi.mocked(bridge);

const jobright = makePlugin({
  slug: 'jobright',
  name: 'Jobright',
  auth_type: 'account',
  login_url: 'https://jobright.example/login',
  credential_fields: [
    { key: 'email', label: 'Email', placeholder: '', help_url: null, secret: false },
    { key: 'password', label: 'Password', placeholder: '', help_url: null, secret: true },
  ],
  session_capture: {
    cookie_domains: ['jobright.example'],
    start_url: 'https://jobright.example/jobs',
    verify_url: 'https://jobright.example/jobs/recommend',
    signed_in_url_patterns: ['/jobs/recommend'],
    logged_out_url_patterns: ['/login'],
    session_cookie_names: ['sid'],
  },
});

const catalog = () => ({
  plugins: [
    makePlugin({ slug: 'remotive', name: 'Remotive', sort_order: 1 }),
    makePlugin({
      slug: 'adzuna',
      name: 'Adzuna',
      auth_type: 'api_key',
      sort_order: 2,
      credential_fields: [
        { key: 'app_id', label: 'App ID', placeholder: 'abc', help_url: 'https://adzuna.example/key', secret: false },
        { key: 'app_key', label: 'App key', placeholder: '', help_url: null, secret: true },
      ],
    }),
    makePlugin({ slug: 'jobicy', name: 'Jobicy', sort_order: 3 }),
    makePlugin({ slug: 'reed', name: 'Reed', auth_type: 'api_key', sort_order: 4 }),
    makePlugin({ slug: 'arbeitnow', name: 'Arbeitnow', sort_order: 5 }),
    makePlugin({
      slug: 'linkedin',
      name: 'LinkedIn',
      auth_type: 'unavailable',
      connectable: false,
      unavailable_reason: 'LinkedIn blocks automated access.',
      sort_order: 6,
    }),
    { ...jobright, sort_order: 7 },
  ],
  connections: [
    makeConnection({ plugin_slug: 'jobicy', last_listing_count: 120 }),
    makeConnection({ plugin_slug: 'reed', last_error: 'API key was rejected (401).' }),
    makeConnection({ plugin_slug: 'arbeitnow', enabled: false }),
  ],
});

const card = (name: string) => screen.getByRole('article', { name });

beforeAll(stubLayout);

let db: ReturnType<typeof catalog>;
const upsert = (row: jobSitesApi.JobSiteConnection) => {
  db.connections = [...db.connections.filter((c) => c.plugin_slug !== row.plugin_slug), row];
  return row;
};

beforeEach(() => {
  vi.clearAllMocks();
  db = catalog();
  api.fetchJobSites.mockImplementation(async () => structuredClone(db));
  api.connectJobSite.mockImplementation(async (slug) => upsert(makeConnection({ plugin_slug: slug })));
  api.updateJobSite.mockImplementation(async (slug, patch) => {
    const prev = db.connections.find((c) => c.plugin_slug === slug)!;
    return upsert({ ...prev, enabled: patch.enabled ?? prev.enabled });
  });
  api.disconnectJobSite.mockImplementation(async (slug) => {
    db.connections = db.connections.filter((c) => c.plugin_slug !== slug);
  });
  ext.subscribeJobSiteConnect.mockReturnValue(() => undefined);
  ext.detectExtension.mockResolvedValue({ installed: false });
  ext.startJobSiteConnect.mockResolvedValue({ ok: true, tabId: 1 });
});

describe('IntegrationsPage, job sites', () => {
  it('shows skeletons while loading', () => {
    api.fetchJobSites.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Remotive' })).not.toBeInTheDocument();
  });

  it('renders a card per plugin with the right status badge', async () => {
    renderPage();
    await screen.findByRole('article', { name: 'Remotive' });
    expect(within(card('Remotive')).getByText('Not connected')).toBeInTheDocument();
    expect(within(card('Remotive')).getByRole('button', { name: 'Connect Remotive' })).toBeInTheDocument();
    expect(within(card('Jobicy')).getByText('Connected')).toBeInTheDocument();
    expect(within(card('Jobicy')).getByText('Synced 5m ago · 120 listings')).toBeInTheDocument();
    expect(within(card('Reed')).getByText('Needs attention')).toBeInTheDocument();
    expect(within(card('Reed')).getByText('API key was rejected (401).')).toBeInTheDocument();
    expect(within(card('Arbeitnow')).getByText('Off')).toBeInTheDocument();
    expect(within(card('LinkedIn')).getByText('Unavailable')).toBeInTheDocument();
    expect(within(card('LinkedIn')).getByRole('button', { name: 'Why not? LinkedIn' })).toBeInTheDocument();
    expect(await screen.findByRole('article', { name: 'Google Sheets' })).toHaveTextContent('Not connected');
  });

  it('shows an inline error with retry when the catalog fails', async () => {
    const user = userEvent.setup();
    api.fetchJobSites.mockRejectedValueOnce({ response: { data: { detail: 'Server down' } } });
    renderPage();
    expect(await screen.findByText('Server down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('article', { name: 'Remotive' })).toBeInTheDocument();
  });

  it('explains why an unavailable site cannot connect', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Why not? LinkedIn' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('LinkedIn blocks automated access.')).toBeInTheDocument();
  });

  it('enables a public feed with empty credentials', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Connect Remotive' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(api.connectJobSite).toHaveBeenCalledWith('remotive', { credentials: {} }));
    expect(await within(sheet).findByRole('switch', { name: 'Auto-sync' })).toBeChecked();
    expect(toast.success).toHaveBeenCalledWith('Remotive connected', expect.anything());
  });

  it('validates and submits API key credentials', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Connect Adzuna' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByLabelText('App key')).toHaveAttribute('type', 'password');
    expect(within(sheet).getByRole('link', { name: /Get key/ })).toHaveAttribute('href', 'https://adzuna.example/key');

    await user.click(within(sheet).getByRole('button', { name: 'Verify & connect' }));
    expect(within(sheet).getByText('App ID is required.')).toBeInTheDocument();
    expect(api.connectJobSite).not.toHaveBeenCalled();

    await user.type(within(sheet).getByLabelText('App ID'), ' id-1 ');
    await user.type(within(sheet).getByLabelText('App key'), 'secret-1');
    await user.click(within(sheet).getByRole('button', { name: 'Verify & connect' }));
    await waitFor(() =>
      expect(api.connectJobSite).toHaveBeenCalledWith('adzuna', { credentials: { app_id: 'id-1', app_key: 'secret-1' } }),
    );
  });

  it('connects without an optional field and explains it', async () => {
    const user = userEvent.setup();
    db.plugins.push(
      makePlugin({
        slug: 'remoterocketship',
        name: 'RemoteRocketship',
        auth_type: 'api_key',
        sort_order: 0,
        credential_fields: [
          { key: 'api_key', label: 'API key', placeholder: '', help_url: null, secret: true },
          {
            key: 'search_url',
            label: 'Search link',
            placeholder: '',
            help_url: 'https://rrs.example/remote-jobs/',
            secret: false,
            required: false,
            help_text: 'Paste the address bar link.',
          },
        ],
      }),
    );
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Connect RemoteRocketship' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Optional')).toBeInTheDocument();
    expect(within(sheet).getByText('Paste the address bar link.')).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: /Open site/ })).toHaveAttribute('href', 'https://rrs.example/remote-jobs/');

    await user.click(within(sheet).getByRole('button', { name: 'Verify & connect' }));
    expect(within(sheet).getByText('API key is required.')).toBeInTheDocument();
    expect(within(sheet).queryByText('Search link is required.')).not.toBeInTheDocument();

    await user.type(within(sheet).getByLabelText('API key'), 'key-1');
    await user.click(within(sheet).getByRole('button', { name: 'Verify & connect' }));
    await waitFor(() =>
      expect(api.connectJobSite).toHaveBeenCalledWith('remoterocketship', { credentials: { api_key: 'key-1' } }),
    );
  });

  it('shows the API error when credentials are rejected', async () => {
    const user = userEvent.setup();
    api.connectJobSite.mockRejectedValue({ response: { data: { detail: 'Invalid Adzuna key' } } });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Connect Adzuna' }));
    const sheet = await screen.findByRole('dialog');
    await user.type(within(sheet).getByLabelText('App ID'), 'a');
    await user.type(within(sheet).getByLabelText('App key'), 'b');
    await user.click(within(sheet).getByRole('button', { name: 'Verify & connect' }));
    expect(await within(sheet).findByText('Invalid Adzuna key')).toBeInTheDocument();
  });

  it('toggles auto-sync and starts a sync for a connected site', async () => {
    const user = userEvent.setup();
    api.syncJobSiteNow.mockResolvedValue(undefined);
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Jobicy' }));
    const sheet = await screen.findByRole('dialog');

    await user.click(within(sheet).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(api.syncJobSiteNow).toHaveBeenCalledWith('jobicy'));
    expect(toast.success).toHaveBeenCalledWith('Sync started', expect.anything());

    await user.click(within(sheet).getByRole('switch', { name: 'Auto-sync' }));
    await waitFor(() => expect(api.updateJobSite).toHaveBeenCalledWith('jobicy', { enabled: false }));
    await waitFor(() => expect(within(sheet).getByRole('switch', { name: 'Auto-sync' })).not.toBeChecked());
    expect(within(sheet).getByRole('button', { name: 'Sync now' })).toBeDisabled();
  });

  it('shows the last error for a site that needs attention', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Reed' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('The last sync failed')).toBeInTheDocument();
    expect(within(sheet).getByText('API key was rejected (401).')).toBeInTheDocument();
  });

  it('asks the user to reconnect when the session expired and blocks manual sync', async () => {
    const user = userEvent.setup();
    db.connections.push(
      makeConnection({
        plugin_slug: 'jobright',
        status: 'needs_reauth',
        last_error: 'Your Jobright session expired.',
        next_sync_at: null,
      }),
    );
    renderPage();
    expect(await within(await screen.findByRole('article', { name: 'Jobright' })).findByText('Needs attention')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Manage Jobright' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Sign in to Jobright again')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await user.click(within(sheet).getAllByRole('button', { name: 'Reconnect' })[0]);
    expect(await within(sheet).findByText('Connect with your browser login')).toBeInTheDocument();
  });

  it('shows lifetime key usage for capped boards', async () => {
    const user = userEvent.setup();
    db.plugins.push(
      makePlugin({ slug: 'jooble', name: 'Jooble', auth_type: 'api_key', sort_order: 8, lifetime_request_cap: 500 }),
    );
    db.connections.push(makeConnection({ plugin_slug: 'jooble', request_count: 37 }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Jooble' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('37 of 500 lifetime requests')).toBeInTheDocument();
  });

  it('asks for confirmation before disconnecting', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage Jobicy' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Disconnect Jobicy?')).toBeInTheDocument();
    expect(api.disconnectJobSite).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.disconnectJobSite).toHaveBeenCalledWith('jobicy'));
    await waitFor(() => expect(within(card('Jobicy')).getByText('Not connected')).toBeInTheDocument());
  });

  it('shows install guidance when the extension is missing and stops the watch on close', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Connect Jobright' }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Install the NAO extension')).toBeInTheDocument();
    expect(within(sheet).getByRole('status')).toHaveTextContent('Install the NAO extension to detect your login automatically.');
    expect(ext.startJobSiteConnect).not.toHaveBeenCalled();
    expect(within(sheet).getByRole('button', { name: 'Enter credentials instead' })).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(ext.stopJobSiteConnect).toHaveBeenCalled());
  });

  it('connects a captured browser session through the extension', async () => {
    const user = userEvent.setup();
    let handlers: Parameters<typeof bridge.subscribeJobSiteConnect>[0] = {};
    ext.subscribeJobSiteConnect.mockImplementation((h) => {
      handlers = h;
      return () => undefined;
    });
    ext.detectExtension.mockResolvedValue({ installed: true });
    ext.captureJobSiteNow.mockResolvedValue({ ok: false, error: 'No session yet' });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Connect Jobright' }));
    const sheet = await screen.findByRole('dialog');

    await waitFor(() =>
      expect(ext.startJobSiteConnect).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'jobright', startUrl: 'https://jobright.example/jobs', sessionCookieNames: ['sid'] }),
      ),
    );
    act(() => handlers.onStatus?.({ slug: 'jobright', state: 'signed_out', url: 'https://jobright.example/login' }));
    expect(await within(sheet).findByText(/Sign in on the Jobright tab/)).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: /capture now/i }));
    expect(await within(sheet).findByText('No session yet')).toBeInTheDocument();

    const session: JobSiteCapturedSession = {
      slug: 'jobright',
      url: 'https://jobright.example/jobs/recommend',
      reason: 'signed_in',
      cookies: [{ name: 'sid', value: 'abc' }],
      cookieHeader: 'sid=abc',
      storage: { localStorage: {}, sessionStorage: {} },
    };
    act(() => handlers.onSession?.(session));
    await waitFor(() =>
      expect(api.connectJobSite).toHaveBeenCalledWith('jobright', {
        credentials: {},
        cookies: session.cookies,
        storage: session.storage,
      }),
    );
    expect(ext.stopJobSiteConnect).toHaveBeenCalledWith(false);
    expect(await within(sheet).findByRole('switch', { name: 'Auto-sync' })).toBeInTheDocument();
  });
});
