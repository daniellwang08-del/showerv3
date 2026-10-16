import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
        <ShareReportDialog open onOpenChange={() => undefined} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const writeText = vi.fn(async () => undefined);

beforeAll(() => {
  stubLayout();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchReportShares.mockResolvedValue({
    shares: [makeShare({ last_viewed_at: new Date(Date.now() - 3_600_000).toISOString(), view_count: 2 })],
    max_shares: 25,
    expiry_choices: [7, 30, 90],
  });
  mocked.createReportShares.mockResolvedValue({
    shares: [makeShare({ id: 's2', email: 'a@x.com', token: 't2' }), makeShare({ id: 's3', email: 'b@y.org', token: 't3' })],
  });
});

describe('ShareReportDialog', () => {
  it('lists people with access and how they used it', async () => {
    renderDialog();
    const people = await screen.findByRole('region', { name: 'People with access' });
    expect(await within(people).findByText('coach@example.com')).toBeInTheDocument();
    expect(people).toHaveTextContent('No end date');
    expect(people).toHaveTextContent('Opened 1 hour ago · 2 views');

    await userEvent.click(within(people).getByRole('button', { name: 'Copy link for coach@example.com' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/shared/tok-1`);
    expect(within(people).getByRole('link', { name: 'Email the link to coach@example.com' }).getAttribute('href')).toMatch(
      /^mailto:coach%40example\.com\?/,
    );
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
        expires_in_days: 30,
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
});
