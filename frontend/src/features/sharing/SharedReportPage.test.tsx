import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import * as api from '@/api/reportShareApi';
import { TooltipProvider } from '@/components/ui/tooltip';
import { stubLayout } from '../integrations/testUtils';
import { makeEvent, makeProcess } from '../interviews/interviewsFixtures';
import { makeApp, makeIncoming, makeReport } from './sharingFixtures';
import { SharedReportPage } from './SharedReportPage';
import { SharedWithMePage } from './SharedWithMePage';

vi.mock('@/api/reportShareApi', () => ({
  fetchSharedReport: vi.fn(),
  fetchReportPreview: vi.fn(),
  fetchIncomingShares: vi.fn(async () => ({ shares: [] })),
}));
vi.mock('../insights/InsightsCharts', () => ({
  ActivityChart: ({ data }: { data: unknown[] }) => <div data-testid="activity-chart" data-points={data.length} />,
}));
const mocked = vi.mocked(api);

function renderShared() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/app/shared/s1']}>
          <Routes>
            <Route path="/app/shared/:shareId" element={<SharedReportPage />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
const recently = new Date(Date.now() - 86_400_000).toISOString();

beforeAll(stubLayout);
beforeEach(() => vi.clearAllMocks());

describe('SharedReportPage', () => {
  it('shows the owner report read only, with applications and their status', async () => {
    const acme = makeProcess({
      id: 'p1',
      company: 'Acme',
      stage: 'interviewing',
      notes: 'Ask about the team size',
      events: [makeEvent({ id: 'e1', title: 'System design', scheduled_at: inTwoDays })],
      next_event: makeEvent({ id: 'e1', title: 'System design', scheduled_at: inTwoDays }),
    });
    const globex = makeProcess({ id: 'p2', company: 'Globex', stage: 'rejected', status: 'closed' });
    mocked.fetchSharedReport.mockResolvedValue(
      makeReport(
        [acme, globex],
        [
          makeApp({ id: 'a', company: 'Acme', process_id: 'p1', process_active: true, stage: 'interviewing', applied_at: recently, url: 'https://jobs.acme.com/1' }),
          makeApp({ id: 'b', company: 'Globex', process_id: 'p2', stage: 'rejected', applied_at: recently }),
          makeApp({ id: 'c', company: 'Initech', source: 'email', applied_at: recently, match_score: 82 }),
        ],
        { share: makeIncoming({ message: 'Thanks for helping me prep!' }) },
      ),
    );
    renderShared();

    expect(await screen.findByRole('heading', { name: "Sam Lee's job search" })).toBeInTheDocument();
    expect(mocked.fetchSharedReport).toHaveBeenCalledWith('s1');
    expect(screen.getByText('Thanks for helping me prep!')).toBeInTheDocument();
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Shared with me' })).toHaveAttribute('href', '/app/shared');
    expect(screen.getByText('Applied this week').nextElementSibling).toHaveTextContent('14');
    expect(within(screen.getByRole('region', { name: 'Interviewing column' })).getByText('Acme')).toBeInTheDocument();
    expect(await screen.findByTestId('activity-chart')).toHaveAttribute('data-points', '7');

    const list = screen.getByRole('list', { name: 'Applications list' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Applied, no reply yet')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Open the Acme, Engineer job posting' })).toHaveAttribute('href', 'https://jobs.acme.com/1');

    await userEvent.click(screen.getByRole('tab', { name: /Closed/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('Globex');

    await userEvent.click(screen.getByRole('tab', { name: /All/ }));
    await userEvent.click(within(list).getByRole('button', { name: 'Acme, Engineer. View interview details' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('System design')).toBeInTheDocument();
    expect(within(sheet).getByText('Ask about the team size')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Delete process/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Add step/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('combobox', { name: 'Stage' })).not.toBeInTheDocument();
  });

  it('explains when access was removed or ended', async () => {
    const res = { status: 404, statusText: 'Not Found', data: {}, headers: {}, config: { headers: new AxiosHeaders() } };
    mocked.fetchSharedReport.mockRejectedValue(new AxiosError('Not Found', '404', undefined, undefined, res));
    renderShared();
    expect(await screen.findByRole('heading', { name: 'This report is no longer shared with you' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Shared with me' })).toHaveAttribute('href', '/app/shared');
  });
});

describe('SharedWithMePage', () => {
  function renderList() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SharedWithMePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('lists everyone who shared a report, linking into the app', async () => {
    mocked.fetchIncomingShares.mockResolvedValue({
      shares: [makeIncoming({ message: 'Would love your eyes on this' }), makeIncoming({ id: 's2', owner_name: 'Alex Kim', owner_headline: null, last_viewed_at: recently })],
    });
    renderList();
    const list = await screen.findByRole('list', { name: 'Shared reports' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/app/shared/s1', '/app/shared/s2']);
    expect(links[0]).toHaveTextContent('Sam Lee');
    expect(links[0]).toHaveTextContent('Would love your eyes on this');
    expect(links[0]).toHaveTextContent('New');
    expect(links[1]).not.toHaveTextContent('New');
  });

  it('explains how sharing works when nothing is shared yet', async () => {
    mocked.fetchIncomingShares.mockResolvedValue({ shares: [] });
    renderList();
    expect(await screen.findByRole('heading', { name: 'Nothing shared with you yet' })).toBeInTheDocument();
  });
});
