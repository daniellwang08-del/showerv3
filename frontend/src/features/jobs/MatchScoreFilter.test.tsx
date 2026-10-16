import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserSettings } from '@/types/settings';
import { MatchScoreFilter } from './MatchScoreFilter';

const applyMinMatchScore = vi.fn();
const refreshJobStores = vi.fn();

vi.mock('@/api/settingsApi', async () => {
  const actual = await vi.importActual<typeof import('@/api/settingsApi')>('@/api/settingsApi');
  return {
    ...actual,
    fetchUserSettings: vi.fn(async () =>
      ({
        min_match_score_mode: 'custom',
        min_match_score: 65,
        min_match_score_custom: 65,
        default_min_match_score: 0,
      }) as UserSettings,
    ),
    applyMinMatchScore: (...args: unknown[]) => applyMinMatchScore(...args),
  };
});

vi.mock('@/features/settings/queries', async () => {
  const actual = await vi.importActual<typeof import('@/features/settings/queries')>(
    '@/features/settings/queries',
  );
  return {
    ...actual,
    refreshJobStores: () => refreshJobStores(),
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderFilter(minScore = 0) {
  const onMinScore = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MatchScoreFilter minScore={minScore} onMinScore={onMinScore} />
    </QueryClientProvider>,
  );
  return { onMinScore };
}

describe('MatchScoreFilter', () => {
  beforeEach(() => {
    applyMinMatchScore.mockReset();
    refreshJobStores.mockReset();
    applyMinMatchScore.mockResolvedValue({
      success: true,
      min_match_score: 70,
      hidden: 2,
      restored: 0,
      settings: {
        min_match_score_mode: 'custom',
        min_match_score: 70,
        min_match_score_custom: 70,
        default_min_match_score: 0,
      },
    });
  });

  it('shows the saved preference on the trigger', async () => {
    renderFilter(0);
    expect(
      await screen.findByRole('button', { name: 'Match score filter and preference' }),
    ).toHaveTextContent('Any match · 65');
  });

  it('explains list presets and applies a list-only filter', async () => {
    const user = userEvent.setup();
    const { onMinScore } = renderFilter(0);
    await user.click(await screen.findByRole('button', { name: 'Match score filter and preference' }));
    expect(await screen.findByText(/These buttons hide low-scoring rows/)).toBeInTheDocument();
    expect(screen.getByText('Only rows scoring 65 or higher in this list.')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Good\+ \(65\)/ }));
    expect(onMinScore).toHaveBeenCalledWith(65);
  });

  it('opens the vertical slider from the limit number and saves preference', async () => {
    const user = userEvent.setup();
    renderFilter(0);
    await user.click(await screen.findByRole('button', { name: 'Match score filter and preference' }));
    await user.click(await screen.findByRole('button', { name: 'Adjust saved match limit' }));
    const slider = await screen.findByRole('slider', { name: 'Saved minimum match score' });
    expect(slider).toBeInTheDocument();

    // Keyboard change commits a new draft; debounce then apply.
    slider.focus();
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}');
    await waitFor(() =>
      expect(applyMinMatchScore).toHaveBeenCalledWith({
        min_match_score_mode: 'custom',
        min_match_score: 70,
      }),
    );
    await waitFor(() => expect(refreshJobStores).toHaveBeenCalled());
  });
});
