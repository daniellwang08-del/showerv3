import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import * as api from '@/api/reportShareApi';
import { TooltipProvider } from '@/components/ui/tooltip';
import { stubLayout } from '../integrations/testUtils';
import { ShareReportDialog } from './ShareReportDialog';
import { makeShare } from './sharingFixtures';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/api/reportShareApi', () => ({
  fetchReportShares: vi.fn(),
  createReportShares: vi.fn(),
  updateReportShare: vi.fn(async () => ({})),
  deleteReportShare: vi.fn(async () => undefined),
}));
const mocked = vi.mocked(api);

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter>
          <ShareReportDialog open onOpenChange={() => undefined} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeAll(stubLayout);

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchReportShares.mockResolvedValue({
    shares: [makeShare({ last_viewed_at: new Date(Date.now() - 3_600_000).toISOString(), view_count: 2 })],
    max_shares: 25,
    expiry_choices: [7, 30, 90],
  });
  mocked.createReportShares.mockResolvedValue({
    shares: [makeShare({ id: 's2', email: 'a@x.com', viewer_name: 'A' }), makeShare({ id: 's3', email: 'b@y.org', viewer_name: 'B' })],
  });
});

describe('ShareReportDialog', () => {
  it('lists people with access by account, with no links to send', async () => {
    renderDialog();
    const people = await screen.findByRole('region', { name: 'People with access' });
    expect(await within(people).findByText('Jordan Coach')).toBeInTheDocument();
    expect(people).toHaveTextContent('coach@example.com');
    expect(people).toHaveTextContent('No end date');
    expect(people).toHaveTextContent('Viewed 1 hour ago');
    expect(within(people).queryByRole('button', { name: /Copy link/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Email the link/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Preview what they see' })).toHaveAttribute('href', '/app/interviews/report-preview');
  });

  it('turns typed emails into chips and shares with each person', async () => {
    renderDialog();
    const input = screen.getByRole('textbox', { name: 'Email addresses' });
    await userEvent.type(input, 'a@x.com,b@y.org ');
    expect(screen.getByRole('button', { name: 'Remove a@x.com' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove b@y.org' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: 'Include my private notes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Share with 2 people' }));
    await waitFor(() =>
      expect(mocked.createReportShares).toHaveBeenCalledWith({
        emails: ['a@x.com', 'b@y.org'],
        expires_in_days: null,
        include_notes: true,
        message: null,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove a@x.com' })).not.toBeInTheDocument());
  });

  it('removes access from the row menu', async () => {
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Access options for coach@example.com' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove access' }));
    await waitFor(() => expect(mocked.deleteReportShare).toHaveBeenCalledWith('s1'));
  });

  it('shows why a share failed, such as an email without a NAO account', async () => {
    const { toast } = await import('sonner');
    const res = {
      status: 400,
      statusText: 'Bad Request',
      data: { detail: 'nobody@x.com does not have a NAO account yet. Ask them to sign up, then share again.' },
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
    mocked.createReportShares.mockRejectedValue(new AxiosError('Bad Request', '400', undefined, undefined, res));
    renderDialog();
    await userEvent.type(screen.getByRole('textbox', { name: 'Email addresses' }), 'nobody@x.com{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('does not have a NAO account')));
  });
});
