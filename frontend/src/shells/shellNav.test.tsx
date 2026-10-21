import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { fetchIncomingShares } from '@/api/reportShareApi';
import { fetchTeamOverview } from '@/api/teamApi';
import { adminNav, applicantNav } from './nav';
import { UserMenu } from './UserMenu';
import { useVisibleNav } from './useVisibleNav';

vi.mock('@/api/reportShareApi', () => ({ fetchIncomingShares: vi.fn() }));
vi.mock('@/api/teamApi', () => ({ fetchTeamOverview: vi.fn() }));
vi.mock('@/api/storeApi', () => ({ fetchStore: vi.fn(async () => ({ balance: 0 })) }));

const shares = vi.mocked(fetchIncomingShares);
const overview = vi.mocked(fetchTeamOverview);

function wrapper(path = '/app') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const paths = (sections: ReturnType<typeof useVisibleNav>) => sections.flatMap((s) => s.items.map((i) => i.to));

describe('sidebar navigation', () => {
  beforeEach(() => {
    shares.mockReset();
    overview.mockReset();
  });

  it('puts Team in the applicant sidebar', () => {
    expect(paths(applicantNav)).toContain('/app/team');
  });

  it('hides Shared with me until someone shares a report', async () => {
    shares.mockResolvedValue({ shares: [] });
    const { result } = renderHook(() => useVisibleNav(applicantNav), { wrapper: wrapper() });
    await waitFor(() => expect(shares).toHaveBeenCalled());
    await waitFor(() => expect(paths(result.current)).not.toContain('/app/shared'));
    expect(paths(result.current)).toContain('/app/team');
  });

  it('shows Shared with me once there is a share, for admins too', async () => {
    shares.mockResolvedValue({ shares: [{ id: 'x' }] as never });
    const { result } = renderHook(() => useVisibleNav(adminNav), { wrapper: wrapper('/admin') });
    await waitFor(() => expect(paths(result.current)).toContain('/admin/shared'));
  });

  it('keeps the item while the user is on that page', () => {
    shares.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useVisibleNav(applicantNav), { wrapper: wrapper('/app/shared/abc') });
    expect(paths(result.current)).toContain('/app/shared');
  });
});

describe('account menu', () => {
  beforeEach(() => overview.mockReset());

  it('crowns a team lead', async () => {
    overview.mockResolvedValue({ owned: [{ id: 's1' }], memberships: [], invites: [], team_packages_held: 0 } as never);
    const Wrapper = wrapper();
    render(
      <Wrapper>
        <UserMenu user={{ name: 'Lee Lead', email: 'lead@example.com' }} onLogout={() => {}} variant="applicant" />
      </Wrapper>,
    );
    expect(await screen.findByRole('img', { name: 'Team lead' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu, team lead' })).toBeInTheDocument();
  });

  it('shows no crown for members and admins', async () => {
    overview.mockResolvedValue({ owned: [], memberships: [], invites: [], team_packages_held: 0 });
    const Wrapper = wrapper();
    render(
      <Wrapper>
        <UserMenu user={{ name: 'Pat', email: 'pat@example.com' }} onLogout={() => {}} variant="applicant" />
        <UserMenu user={{ name: 'Root', email: 'root@example.com' }} onLogout={() => {}} variant="admin" />
      </Wrapper>,
    );
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('img', { name: 'Team lead' })).not.toBeInTheDocument();
  });
});
