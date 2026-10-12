import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as scraperApi from '@/api/scraperApi';
import { useShellStore } from '@/stores/shellStore';
import { useNewJobsBadge } from './useNewJobsBadge';

vi.mock('@/api/scraperApi', () => ({ fetchNewJobsCount: vi.fn() }));
const api = vi.mocked(scraperApi);

function wrapper(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchNewJobsCount.mockResolvedValue({ count: 12, latest_added_at: null });
});

describe('useNewJobsBadge', () => {
  it('counts jobs added since the last visit to the Jobs page', async () => {
    useShellStore.setState({ jobsSeenAt: '2026-10-01T10:00:00.000Z' });
    const { result } = renderHook(() => useNewJobsBadge(true), { wrapper: wrapper('/app/resumes') });
    await waitFor(() => expect(result.current).toBe(12));
    expect(api.fetchNewJobsCount).toHaveBeenCalledWith('2026-10-01T10:00:00.000Z');
  });

  it('marks jobs seen and hides the badge on the Jobs page', () => {
    useShellStore.setState({ jobsSeenAt: '2026-10-01T10:00:00.000Z' });
    const { result } = renderHook(() => useNewJobsBadge(true), { wrapper: wrapper('/app/jobs') });
    expect(result.current).toBe(0);
    expect(useShellStore.getState().jobsSeenAt).not.toBe('2026-10-01T10:00:00.000Z');
    expect(api.fetchNewJobsCount).not.toHaveBeenCalled();
  });

  it('starts the clock on first use instead of counting the whole backlog', () => {
    useShellStore.setState({ jobsSeenAt: null });
    renderHook(() => useNewJobsBadge(true), { wrapper: wrapper('/app/resumes') });
    expect(useShellStore.getState().jobsSeenAt).not.toBeNull();
  });

  it('does nothing when disabled', () => {
    useShellStore.setState({ jobsSeenAt: null });
    const { result } = renderHook(() => useNewJobsBadge(false), { wrapper: wrapper('/app/resumes') });
    expect(result.current).toBe(0);
    expect(useShellStore.getState().jobsSeenAt).toBeNull();
    expect(api.fetchNewJobsCount).not.toHaveBeenCalled();
  });
});
