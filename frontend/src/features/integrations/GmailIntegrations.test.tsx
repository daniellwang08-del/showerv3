import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import * as gmailApi from '@/api/gmailApi';
import type { GmailConfig } from '@/types/gmail';
import { renderPage, stubLayout } from './testUtils';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }));
vi.mock('@/api/jobSitesApi', () => ({
  fetchJobSites: vi.fn(async () => ({ plugins: [], connections: [] })),
  fetchJobSiteActivity: vi.fn(async () => []),
}));
vi.mock('@/lib/extensionBridge', () => ({}));
vi.mock('@/api/googleSheetsApi', () => ({
  fetchSheetsStatus: vi.fn(async () => ({ server_configured: true, service_account_email: 'bot@sa.iam' })),
  fetchSheetsConfig: vi.fn(async () => ({ configured: false })),
}));
vi.mock('@/api/pumbleApi', () => ({
  fetchPumbleStatus: vi.fn(async () => ({ integration_available: true })),
  fetchPumbleConfig: vi.fn(async () => ({ configured: false, integrations: [] })),
}));
vi.mock('@/api/gmailApi', () => ({
  fetchGmailStatus: vi.fn(),
  fetchGmailConfig: vi.fn(),
  startGmailConnect: vi.fn(),
  setGmailEnabled: vi.fn(),
  disconnectGmail: vi.fn(),
  searchGmail: vi.fn(),
  fetchGmailMessage: vi.fn(),
}));

const gmail = vi.mocked(gmailApi);

const connected: GmailConfig = {
  configured: true,
  google_email: 'you@gmail.com',
  is_enabled: true,
  status: 'connected',
  last_error: null,
  connected_at: new Date(Date.now() - 60_000).toISOString(),
};

let configDb: GmailConfig;

beforeAll(stubLayout);

beforeEach(() => {
  vi.clearAllMocks();
  configDb = { configured: false };
  gmail.fetchGmailStatus.mockResolvedValue({
    server_configured: true,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  });
  gmail.fetchGmailConfig.mockImplementation(async () => structuredClone(configDb));
});

async function openGmail() {
  const user = userEvent.setup();
  renderPage('/app/integrations?tab=inbox');
  const card = await screen.findByRole('article', { name: 'Gmail' });
  await user.click(within(card).getByRole('button'));
  return { user, sheet: await screen.findByRole('dialog') };
}

describe('IntegrationsPage, Gmail', () => {
  it('shows the inbox tab with Gmail and coming-soon cards', async () => {
    renderPage('/app/integrations?tab=inbox');
    expect(await screen.findByRole('article', { name: 'Gmail' })).toHaveTextContent('Not connected');
    expect(screen.getByRole('article', { name: 'Outlook' })).toHaveTextContent('Unavailable');
    expect(screen.getByRole('article', { name: 'Slack' })).toHaveTextContent('Unavailable');
  });

  it('shows Unavailable when OAuth is not configured on the server', async () => {
    gmail.fetchGmailStatus.mockResolvedValue({ server_configured: false, scopes: [] });
    const { sheet } = await openGmail();
    expect(within(sheet).getByText(/Gmail is not configured on this server/i)).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Continue with Google/i })).not.toBeInTheDocument();
  });

  it('starts Google OAuth from the connect prompt', async () => {
    const { user, sheet } = await openGmail();
    await user.click(within(sheet).getByRole('button', { name: /Continue with Google/i }));
    expect(gmail.startGmailConnect).toHaveBeenCalled();
  });

  it('searches the inbox when connected', async () => {
    configDb = connected;
    gmail.searchGmail.mockResolvedValue({
      query: 'from:recruiter@acme.com',
      result_size_estimate: 1,
      messages: [
        {
          id: 'm1',
          thread_id: 't1',
          subject: 'Interview next week',
          from: 'Recruiter <recruiter@acme.com>',
          snippet: 'Are you free Thursday?',
          date: new Date().toISOString(),
        },
      ],
    });
    gmail.fetchGmailMessage.mockResolvedValue({
      id: 'm1',
      subject: 'Interview next week',
      from: 'Recruiter <recruiter@acme.com>',
      snippet: 'Are you free Thursday?',
      body_text: 'Are you free Thursday afternoon?',
    });

    const { user, sheet } = await openGmail();
    expect(within(sheet).getByText('you@gmail.com')).toBeInTheDocument();
    const input = within(sheet).getByLabelText('Search query');
    await user.clear(input);
    await user.type(input, 'from:recruiter@acme.com');
    await user.click(within(sheet).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(gmail.searchGmail).toHaveBeenCalledWith('from:recruiter@acme.com'));
    expect(await within(sheet).findByText('Interview next week')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: /Interview next week/i }));
    await waitFor(() => expect(gmail.fetchGmailMessage).toHaveBeenCalledWith('m1'));
    expect(await within(sheet).findByText('Are you free Thursday afternoon?')).toBeInTheDocument();
  });

  it('disconnects Gmail after confirmation', async () => {
    configDb = connected;
    gmail.disconnectGmail.mockResolvedValue({ success: true, disconnected: true });
    const { user, sheet } = await openGmail();
    await user.click(within(sheet).getByRole('button', { name: 'Disconnect Gmail' }));
    const dialogs = await screen.findAllByRole('alertdialog');
    const confirm = dialogs[dialogs.length - 1]!;
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(gmail.disconnectGmail).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Gmail disconnected');
  });

  it('toasts after a successful OAuth return', async () => {
    renderPage('/app/integrations?tab=inbox&gmail=connected');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Gmail connected'));
  });
});
