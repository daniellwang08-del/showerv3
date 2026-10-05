import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { APPROVAL_POLL_MS, PendingApprovalScreen } from './PendingApprovalScreen';

vi.mock('../../api/client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../landing/LandingHeader', () => ({ LandingHeader: () => null }));
vi.mock('../../hooks/usePublicViewport', () => ({ usePublicViewport: () => undefined }));

const getMock = vi.mocked(apiClient.get);
const postMock = vi.mocked(apiClient.post);

const pending = { email: 'dana@new.io', approval_status: 'pending', requested_at: '2026-10-05T07:00:00Z' };
const approved = { ...pending, approval_status: 'approved' };

function renderScreen() {
  const onResolved = vi.fn();
  const onSignOut = vi.fn();
  render(
    <MemoryRouter>
      <PendingApprovalScreen onResolved={onResolved} onSignOut={onSignOut} />
    </MemoryRouter>,
  );
  return { onResolved, onSignOut };
}

describe('PendingApprovalScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the account and opens the workspace once an admin approves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMock.mockResolvedValueOnce({ data: pending }).mockResolvedValue({ data: approved });
    const { onResolved } = renderScreen();
    expect(await screen.findByText('dana@new.io')).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS + 10);
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(getMock).toHaveBeenCalledWith('/auth/approval');
  });

  it('redeems a typed access key (case and dashes ignored) and resolves', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue({ data: pending });
    postMock.mockResolvedValue({ data: approved });
    const { onResolved } = renderScreen();
    const submit = screen.getByRole('button', { name: 'Unlock workspace' });
    await user.type(screen.getByLabelText('Have an access key?'), 'k7m2x-p9qr');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Have an access key?'), 't');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/auth/approval/redeem', { key: 'K7M2XP9QRT' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it('shows the server reason when a key is refused', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue({ data: pending });
    postMock.mockRejectedValue({ response: { status: 400, data: { detail: 'That access key is invalid or has expired.' } } });
    const { onResolved } = renderScreen();
    await user.type(screen.getByLabelText('Have an access key?'), 'AAAAAAAAA2');
    await user.click(screen.getByRole('button', { name: 'Unlock workspace' }));
    expect(await screen.findByText('That access key is invalid or has expired.')).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('signs out on request', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue({ data: pending });
    const { onSignOut } = renderScreen();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
