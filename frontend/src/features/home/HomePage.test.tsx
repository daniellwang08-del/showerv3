import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { completeProfile, emptyProfile } from '@/test/profileFixtures';
import { makeJob } from '@/test/jobFixtures';
import { writeOnboarding } from '@/features/onboarding/onboardingState';
import { HomePage } from './HomePage';

const api = vi.hoisted(() => ({
  fetchUserProfile: vi.fn(),
  fetchUserSettings: vi.fn(),
  fetchScraperStats: vi.fn(),
  fetchDashboardJobs: vi.fn(),
  applyAgentDashboard: vi.fn(),
}));

vi.mock('@/api/profileApi', () => ({ fetchUserProfile: api.fetchUserProfile }));
vi.mock('@/api/settingsApi', () => ({ fetchUserSettings: api.fetchUserSettings }));
vi.mock('@/api/scraperApi', () => ({
  fetchScraperStats: api.fetchScraperStats,
  fetchDashboardJobs: api.fetchDashboardJobs,
}));
vi.mock('@/features/assistant/Composer', () => ({
  Composer: () => <textarea aria-label="Composer" />,
}));
vi.mock('@/features/assistant/useAssistantDraft', () => ({
  ASSISTANT_SUGGESTIONS: [],
  useAssistantDraft: () => ({ draft: '', setDraft: vi.fn(), block: null, setBlock: vi.fn(), submit: vi.fn(), busy: false }),
}));
vi.mock('@/api/agentApi', () => ({ fetchAgentTools: vi.fn().mockResolvedValue([]) }));
vi.mock('@/stores/scraperStore', () => ({
  useScraperStore: { getState: () => ({ applyAgentDashboard: api.applyAgentDashboard }) },
}));

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/app']}>
          <Routes>
            <Route path="/app" element={<HomePage firstName="Jordan" userId="u1" />} />
            <Route path="/app/jobs" element={<p>jobs page</p>} />
            <Route path="/app/profile" element={<p>profile page</p>} />
            <Route path="/onboarding" element={<p>onboarding page</p>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const stats = {
  total_jobs: 8,
  today_scraped: 8,
  ready_jobs: 3,
  available_jobs: 2,
  applied_jobs: 0,
  sources: [],
  recent_runs: [],
};

beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.fetchUserSettings.mockResolvedValue({ country_preferences: [], job_match_preferences: '' });
  api.fetchScraperStats.mockResolvedValue(stats);
  api.fetchDashboardJobs.mockImplementation(async (params: { view?: string }) => ({
    items:
      params.view === 'applied'
        ? [makeJob({ id: 'x', applied_at: new Date().toISOString() })]
        : [makeJob({ id: 'top', title: 'Platform Engineer', match_overall_score: 81 })],
    total: 1,
    page: 1,
    per_page: 6,
    pages: 1,
  }));
});

describe('HomePage', () => {
  it('sends a new account without a profile to onboarding', async () => {
    api.fetchUserProfile.mockResolvedValue(null);
    renderHome();
    expect(await screen.findByText('onboarding page')).toBeInTheDocument();
  });

  it('stays on Home once onboarding was skipped and offers to finish setup', async () => {
    writeOnboarding('u1', { status: 'skipped', step: 0 });
    api.fetchUserProfile.mockResolvedValue(emptyProfile);
    const user = userEvent.setup();
    renderHome();
    const next = await screen.findByRole('button', { name: /Finish your profile/ });
    expect(screen.getByRole('region', { name: 'Getting started' })).toHaveTextContent('1 of 4 done');
    await user.click(next);
    expect(await screen.findByText('profile page')).toBeInTheDocument();
  });

  it('shows live tiles and routes the next step to ready jobs', async () => {
    api.fetchUserProfile.mockResolvedValue(completeProfile);
    const user = userEvent.setup();
    renderHome();
    const next = await screen.findByRole('button', { name: /Review 3 jobs ready to apply/ });
    expect(screen.getByRole('button', { name: /Applied this week/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /In progress/ })).toHaveTextContent('2');
    expect(await screen.findByText('Platform Engineer')).toBeInTheDocument();
    await user.click(next);
    expect(api.applyAgentDashboard).toHaveBeenCalledWith(expect.objectContaining({ view: 'ready', reset: true }));
    expect(await screen.findByText('jobs page')).toBeInTheDocument();
  });
});
