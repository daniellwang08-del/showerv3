import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import * as sheetsApi from '@/api/googleSheetsApi';
import * as pumbleApi from '@/api/pumbleApi';
import type { SheetsConfig } from '@/types/googleSheets';
import type { PumbleConfig, PumbleIntegration } from '@/types/pumble';
import { renderPage, stubLayout } from './testUtils';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/api/jobSitesApi', () => ({
  fetchJobSites: vi.fn(async () => ({ plugins: [], connections: [] })),
}));
vi.mock('@/lib/extensionBridge', () => ({}));
vi.mock('@/api/googleSheetsApi', () => ({
  fetchSheetsStatus: vi.fn(),
  fetchSheetsConfig: vi.fn(),
  verifySpreadsheet: vi.fn(),
  saveSheetsConfig: vi.fn(),
  saveSheetsAutoPostSettings: vi.fn(),
  setSheetsEnabled: vi.fn(),
  disconnectSheets: vi.fn(),
}));
vi.mock('@/api/pumbleApi', () => ({
  fetchPumbleStatus: vi.fn(),
  fetchPumbleConfig: vi.fn(),
  verifyPumbleApiKey: vi.fn(),
  fetchPumbleChannels: vi.fn(),
  savePumbleConfig: vi.fn(),
  savePumbleAutoPostSettings: vi.fn(),
  setPumbleAllEnabled: vi.fn(),
  setPumbleIntegrationEnabled: vi.fn(),
  deletePumbleIntegration: vi.fn(),
  disconnectPumble: vi.fn(),
}));

const sheets = vi.mocked(sheetsApi);
const pumble = vi.mocked(pumbleApi);
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/abc123/edit';

const connectedSheets: SheetsConfig = {
  configured: true,
  spreadsheet_url: SHEET_URL,
  tab_groups: [['Main'], ['Backup']],
  auto_post_threshold: 70,
  auto_post_filters: { work_modes: [], exclude_companies: [] },
  is_enabled: true,
  group_count: 2,
  assigned_tab_count: 2,
};

const destination = (overrides: Partial<PumbleIntegration> = {}): PumbleIntegration => ({
  id: 'p1',
  label: 'Team jobs',
  channel_id: 'c1',
  channel_name: 'general',
  api_key_hint: '…abcd',
  is_enabled: true,
  ...overrides,
});

let sheetsDb: SheetsConfig;
let pumbleDb: PumbleConfig;

beforeAll(stubLayout);

beforeEach(() => {
  vi.clearAllMocks();
  sheetsDb = { configured: false };
  pumbleDb = { configured: false, integrations: [] };
  sheets.fetchSheetsStatus.mockResolvedValue({ server_configured: true, service_account_email: 'bot@sa.iam' });
  sheets.fetchSheetsConfig.mockImplementation(async () => structuredClone(sheetsDb));
  pumble.fetchPumbleStatus.mockResolvedValue({ integration_available: true });
  pumble.fetchPumbleConfig.mockImplementation(async () => structuredClone(pumbleDb));
});

async function openCard(name: string) {
  const user = userEvent.setup();
  renderPage();
  const card = await screen.findByRole('article', { name });
  await user.click(within(card).getByRole('button'));
  return { user, sheet: await screen.findByRole('dialog') };
}

describe('IntegrationsPage, Google Sheets', () => {
  it('shows Unavailable when the server has no Google credentials', async () => {
    sheets.fetchSheetsStatus.mockResolvedValue({ server_configured: false, service_account_email: null });
    const { sheet } = await openCard('Google Sheets');
    const card = screen.getByRole('article', { name: 'Google Sheets', hidden: true });
    expect(within(card).getByText('Unavailable')).toBeInTheDocument();
    expect(within(card).getByText("Google Sheets isn't configured on this server")).toBeInTheDocument();
    expect(within(sheet).getByText("Google Sheets isn't configured on this server")).toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Google Sheet URL')).not.toBeInTheDocument();
  });

  it('verifies a sheet, assigns tab groups, and saves the config', async () => {
    sheets.verifySpreadsheet.mockResolvedValue({ tabs: ['Main', 'Backup', 'Archive'], tab_count: 3, spreadsheet_id: 'abc123' });
    sheets.saveSheetsConfig.mockImplementation(async (body) => {
      sheetsDb = { ...connectedSheets, spreadsheet_url: body.spreadsheet_url, tab_groups: body.tab_groups };
      return { success: true, ...body, is_enabled: true, group_count: 2, assigned_tab_count: 2 };
    });
    const { user, sheet } = await openCard('Google Sheets');
    expect(within(sheet).getByText('bot@sa.iam')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Copy service account email' })).toBeInTheDocument();

    const url = within(sheet).getByLabelText('Google Sheet URL');
    await user.type(url, 'https://example.com/nope');
    await user.click(within(sheet).getByRole('button', { name: 'Verify' }));
    expect(within(sheet).getByText(/Enter a valid Google Sheets URL/)).toBeInTheDocument();
    expect(sheets.verifySpreadsheet).not.toHaveBeenCalled();

    await user.clear(url);
    await user.type(url, SHEET_URL);
    await user.click(within(sheet).getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(sheets.verifySpreadsheet).toHaveBeenCalledWith(SHEET_URL));
    expect(await within(sheet).findByText('Archive')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(within(sheet).getByText('Assign at least one tab to a group')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Assign Main to group 1' }));
    await user.click(within(sheet).getByRole('button', { name: 'Assign Backup to group 2' }));
    await user.click(within(sheet).getByRole('button', { name: 'Add group' }));
    await user.click(within(sheet).getByRole('button', { name: 'Assign Archive to group 3' }));
    await user.click(within(sheet).getByRole('button', { name: 'Remove group 3' }));
    expect(within(sheet).getByText('2 of 3 tabs assigned')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sheets.saveSheetsConfig).toHaveBeenCalledWith({
        spreadsheet_url: SHEET_URL,
        tab_groups: [['Main'], ['Backup']],
        auto_post_threshold: 75,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Google Sheets configuration saved');
    expect(await within(sheet).findByRole('switch', { name: 'Auto-post after job analysis' })).toBeChecked();
    expect(within(sheet).getByRole('link', { name: /Open spreadsheet/ })).toHaveAttribute('href', SHEET_URL);
  });

  it('invalidates the Jobs page integration targets after saving', async () => {
    sheetsDb = connectedSheets;
    sheets.setSheetsEnabled.mockImplementation(async (is_enabled) => {
      sheetsDb = { ...connectedSheets, is_enabled };
      return { success: true, configured: true, ...connectedSheets, spreadsheet_url: SHEET_URL, tab_groups: [], auto_post_threshold: 70, group_count: 2, assigned_tab_count: 2, is_enabled };
    });
    const user = userEvent.setup();
    const { qc } = renderPage();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await user.click(within(await screen.findByRole('article', { name: 'Google Sheets' })).getByRole('button'));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('switch', { name: 'Auto-post after job analysis' }));
    await waitFor(() => expect(sheets.setSheetsEnabled).toHaveBeenCalledWith(false));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['integrations', 'sheets-config'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['integrations', 'sheets'] });
    await waitFor(() => expect(screen.getByRole('article', { name: 'Google Sheets', hidden: true })).toHaveTextContent('Off'));
  });

  it('saves auto-post threshold and filters', async () => {
    sheetsDb = connectedSheets;
    sheets.saveSheetsAutoPostSettings.mockImplementation(async (body) => {
      sheetsDb = { ...connectedSheets, ...body };
      return { success: true, ...connectedSheets, spreadsheet_url: SHEET_URL, tab_groups: [], group_count: 2, assigned_tab_count: 2, ...body };
    });
    const { user, sheet } = await openCard('Google Sheets');
    expect(within(sheet).getByText('Saved: score ≥ 70')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: '80' }));
    await user.click(within(sheet).getByRole('button', { name: 'Remote' }));
    await user.type(within(sheet).getByLabelText('Exclude companies'), 'Acme{Enter}');
    expect(within(sheet).getByRole('button', { name: 'Remove Acme' })).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Exact score')).toHaveValue(80);

    await user.click(within(sheet).getByRole('button', { name: /Save auto-post settings/ }));
    await waitFor(() =>
      expect(sheets.saveSheetsAutoPostSettings).toHaveBeenCalledWith({
        auto_post_threshold: 80,
        auto_post_filters: { work_modes: ['remote'], exclude_companies: ['Acme'] },
      }),
    );
    await waitFor(() => expect(within(sheet).getByText('Saved: score ≥ 80')).toBeInTheDocument());
  });

  it('confirms before disconnecting the sheet', async () => {
    sheetsDb = connectedSheets;
    sheets.disconnectSheets.mockImplementation(async () => {
      sheetsDb = { configured: false };
      return { success: true, removed: true };
    });
    const { user, sheet } = await openCard('Google Sheets');
    await user.click(within(sheet).getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(sheets.disconnectSheets).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(sheets.disconnectSheets).toHaveBeenCalled());
    expect(await within(sheet).findByLabelText('Google Sheet URL')).toBeInTheDocument();
  });

  it('re-reads tabs for editing groups with the saved assignment', async () => {
    sheetsDb = connectedSheets;
    sheets.verifySpreadsheet.mockResolvedValue({ tabs: ['Main', 'Backup'], tab_count: 2, spreadsheet_id: 'abc123' });
    const { user, sheet } = await openCard('Google Sheets');
    await user.click(within(sheet).getByRole('button', { name: 'Edit tab groups' }));
    await waitFor(() => expect(sheets.verifySpreadsheet).toHaveBeenCalledWith(SHEET_URL));
    expect(await within(sheet).findByRole('button', { name: 'Assign Main to group 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('button', { name: 'Assign Backup to group 2' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('IntegrationsPage, Pumble', () => {
  it('shows Unavailable when the integration is disabled on the server', async () => {
    pumble.fetchPumbleStatus.mockResolvedValue({ integration_available: false });
    renderPage();
    const card = await screen.findByRole('article', { name: 'Pumble' });
    expect(within(card).getByText('Unavailable')).toBeInTheDocument();
  });

  it('verifies a key, picks a channel, and saves a destination', async () => {
    pumble.verifyPumbleApiKey.mockResolvedValue({ valid: true, workspace_id: 'w1' });
    pumble.fetchPumbleChannels.mockResolvedValue({
      channels: [
        { id: 'c1', name: 'general', channel_type: 'PUBLIC', is_private: false },
        { id: 'c2', name: 'jobs', channel_type: 'PRIVATE', is_private: true },
      ],
      channel_count: 2,
    });
    pumble.savePumbleConfig.mockImplementation(async (body) => {
      const integration = destination({ id: 'p9', label: body.label ?? 'jobs', channel_id: body.channel_id, channel_name: body.channel_name });
      pumbleDb = { configured: true, integrations: [integration], auto_post_threshold: 75 };
      return { success: true, integration };
    });
    const { user, sheet } = await openCard('Pumble');
    expect(within(sheet).getByText('Connect your first destination')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Verify & load channels' }));
    expect(within(sheet).getByText('Enter your Pumble API key.')).toBeInTheDocument();

    const key = within(sheet).getByLabelText('Pumble API key');
    expect(key).toHaveAttribute('type', 'password');
    await user.type(key, ' key-1 ');
    await user.click(within(sheet).getByRole('button', { name: 'Verify & load channels' }));
    await waitFor(() => expect(pumble.fetchPumbleChannels).toHaveBeenCalledWith('key-1'));
    expect(pumble.verifyPumbleApiKey).toHaveBeenCalledWith('key-1');

    await user.type(await within(sheet).findByLabelText('Label (optional)'), 'Recruiting');
    await user.click(within(sheet).getByRole('combobox', { name: 'Target channel' }));
    await user.click(await screen.findByRole('option', { name: 'jobs (private)' }));
    expect(within(sheet).getByText(/Private channel/)).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Save destination' }));
    await waitFor(() =>
      expect(pumble.savePumbleConfig).toHaveBeenCalledWith({
        api_key: 'key-1',
        channel_id: 'c2',
        channel_name: 'jobs',
        workspace_id: 'w1',
        label: 'Recruiting',
        auto_post_threshold: 75,
      }),
    );
    expect(await within(sheet).findByText('Destinations (1)')).toBeInTheDocument();
    expect(within(sheet).getByText('Recruiting')).toBeInTheDocument();
  });

  it('filters out channels that are already connected', async () => {
    pumbleDb = { configured: true, integrations: [destination()], auto_post_threshold: 70 };
    pumble.verifyPumbleApiKey.mockResolvedValue({ valid: true, workspace_id: 'w1' });
    pumble.fetchPumbleChannels.mockResolvedValue({
      channels: [{ id: 'c1', name: 'general', channel_type: 'PUBLIC', is_private: false }],
      channel_count: 1,
    });
    const { user, sheet } = await openCard('Pumble');
    await user.click(within(sheet).getByRole('button', { name: 'Add destination' }));
    await user.type(within(sheet).getByLabelText('Pumble API key'), 'k');
    await user.click(within(sheet).getByRole('button', { name: 'Verify & load channels' }));
    expect(await within(sheet).findByText(/All accessible channels are already connected/)).toBeInTheDocument();
  });

  it('toggles destinations and removes one after confirmation', async () => {
    pumbleDb = {
      configured: true,
      integrations: [destination(), destination({ id: 'p2', label: 'Second', channel_id: 'c2', channel_name: 'jobs' })],
      auto_post_threshold: 70,
    };
    pumble.setPumbleIntegrationEnabled.mockImplementation(async (id, is_enabled) => {
      const list = pumbleDb.integrations!.map((i) => (i.id === id ? { ...i, is_enabled } : i));
      pumbleDb = { ...pumbleDb, integrations: list };
      return { success: true, integration: list.find((i) => i.id === id)! };
    });
    pumble.setPumbleAllEnabled.mockImplementation(async (is_enabled) => {
      pumbleDb = { ...pumbleDb, integrations: pumbleDb.integrations!.map((i) => ({ ...i, is_enabled })) };
      return { ...structuredClone(pumbleDb), success: true, is_enabled };
    });
    pumble.deletePumbleIntegration.mockImplementation(async (id) => {
      pumbleDb = { ...pumbleDb, integrations: pumbleDb.integrations!.filter((i) => i.id !== id) };
      return { success: true, removed: true };
    });
    const { user, sheet } = await openCard('Pumble');

    await user.click(within(sheet).getByRole('switch', { name: 'Auto-post to Second' }));
    await waitFor(() => expect(pumble.setPumbleIntegrationEnabled).toHaveBeenCalledWith('p2', false));
    expect(await within(sheet).findByText('Paused')).toBeInTheDocument();

    await user.click(within(sheet).getByRole('switch', { name: 'Auto-post after job analysis' }));
    await waitFor(() => expect(pumble.setPumbleAllEnabled).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.getByRole('article', { name: 'Pumble', hidden: true })).toHaveTextContent('Off'));

    await user.click(within(sheet).getByRole('button', { name: 'Remove Second' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Remove Second?')).toBeInTheDocument();
    expect(pumble.deletePumbleIntegration).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(pumble.deletePumbleIntegration).toHaveBeenCalledWith('p2'));
    expect(await within(sheet).findByText('Destinations (1)')).toBeInTheDocument();
  });

  it('saves shared auto-post settings and disconnects all after confirmation', async () => {
    pumbleDb = { configured: true, integrations: [destination()], auto_post_threshold: 70 };
    pumble.savePumbleAutoPostSettings.mockImplementation(async (body) => {
      pumbleDb = { ...pumbleDb, ...body };
      return { success: true, integration_count: 1, ...body };
    });
    pumble.disconnectPumble.mockImplementation(async () => {
      pumbleDb = { configured: false, integrations: [] };
      return { success: true, removed: true };
    });
    const { user, sheet } = await openCard('Pumble');
    await user.click(within(sheet).getByRole('button', { name: 'Hybrid' }));
    await user.click(within(sheet).getByRole('button', { name: 'All (0)' }));
    await user.click(within(sheet).getByRole('button', { name: /Save auto-post settings/ }));
    await waitFor(() =>
      expect(pumble.savePumbleAutoPostSettings).toHaveBeenCalledWith({
        auto_post_threshold: 0,
        auto_post_filters: { work_modes: ['hybrid'], exclude_companies: [] },
      }),
    );

    await user.click(within(sheet).getByRole('button', { name: 'Disconnect all' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(pumble.disconnectPumble).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect all' }));
    await waitFor(() => expect(pumble.disconnectPumble).toHaveBeenCalled());
    expect(await within(sheet).findByText('Connect your first destination')).toBeInTheDocument();
  });
});
