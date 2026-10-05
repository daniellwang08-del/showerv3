import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AdminUser, SignupRequest } from '@/types/admin';
import {
  approveSignup,
  deleteAdminUser,
  fetchAdminUsers,
  fetchSignupRequests,
  issueSignupAccessKey,
  patchAdminUser,
  rejectSignup,
  resetAdminUserPassword,
} from '@/api/adminApi';
import { AdminUsersPage } from './AdminUsersPage';

vi.mock('@/api/adminApi', () => ({
  fetchAdminUsers: vi.fn(),
  patchAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
  resetAdminUserPassword: vi.fn(),
  fetchSignupRequests: vi.fn(),
  approveSignup: vi.fn(),
  rejectSignup: vi.fn(),
  issueSignupAccessKey: vi.fn(),
  revokeSignupAccessKey: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'me@nao.dev', is_admin: true } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchMock = vi.mocked(fetchAdminUsers);
const patchMock = vi.mocked(patchAdminUser);
const deleteMock = vi.mocked(deleteAdminUser);
const resetMock = vi.mocked(resetAdminUserPassword);
const requestsMock = vi.mocked(fetchSignupRequests);
const approveMock = vi.mocked(approveSignup);
const rejectMock = vi.mocked(rejectSignup);
const issueKeyMock = vi.mocked(issueSignupAccessKey);

const PENDING_REQUEST: SignupRequest = {
  id: 'u4',
  email: 'dana@new.io',
  approval_status: 'pending',
  requested_at: '2026-10-05T07:00:00Z',
  active_key: null,
};

function makeUser(over: Partial<AdminUser>): AdminUser {
  return {
    id: 'x',
    email: 'x@nao.dev',
    name: null,
    display_name: '',
    is_active: true,
    is_admin: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const ME = makeUser({ id: 'u1', email: 'me@nao.dev', display_name: 'Me Admin', is_admin: true, created_at: '2025-01-01T00:00:00Z' });
const BOB = makeUser({ id: 'u2', email: 'bob@acme.com', display_name: 'Bob Builder', created_at: '2026-03-01T00:00:00Z' });
const CAROL = makeUser({ id: 'u3', email: 'carol@corp.io', display_name: 'Carol', is_active: false, created_at: '2026-02-01T00:00:00Z' });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/admin/users']}>
          <AdminUsersPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const dataRows = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('data-user-id'));
const rowFor = (email: string) => screen.getByText(email).closest('tr') as HTMLElement;

async function openSheet(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.click(rowFor(email));
  return screen.findByRole('dialog');
}

describe('AdminUsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue([ME, BOB, CAROL]);
    requestsMock.mockResolvedValue([]);
  });

  it('shows skeletons, then renders every user with role, status and created date', async () => {
    renderPage();
    expect(screen.getAllByTestId('user-row-skeleton').length).toBeGreaterThan(0);
    await waitFor(() => expect(dataRows()).toHaveLength(3), { timeout: 5000 });
    // Default sort: newest first.
    expect(dataRows().map((r) => r.getAttribute('data-user-id'))).toEqual(['u2', 'u3', 'u1']);
    const me = rowFor('me@nao.dev');
    expect(within(me).getByText('You')).toBeInTheDocument();
    expect(within(me).getByText('Admin')).toBeInTheDocument();
    expect(within(rowFor('carol@corp.io')).getByText('Disabled')).toBeInTheDocument();
    expect(within(rowFor('bob@acme.com')).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('3 users')).toBeInTheDocument();
  });

  it('filters by search text and offers a reset when nothing matches', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'builder');
    expect(dataRows()).toHaveLength(1);
    expect(screen.getByText('1 of 3 users')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search users' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'zzz');
    expect(screen.getByText('No users match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(dataRows()).toHaveLength(3);
  });

  it('sorts by a column header', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'Email' }));
    expect(dataRows().map((r) => r.getAttribute('data-user-id'))).toEqual(['u2', 'u3', 'u1']);
    await user.click(screen.getByRole('button', { name: 'Email' }));
    expect(dataRows().map((r) => r.getAttribute('data-user-id'))).toEqual(['u1', 'u3', 'u2']);
  });

  it('opens the detail sheet and promotes a user after confirmation', async () => {
    const user = userEvent.setup();
    patchMock.mockImplementation(async () => {
      fetchMock.mockResolvedValue([ME, { ...BOB, is_admin: true }, CAROL]);
      return { ...BOB, is_admin: true };
    });
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    const sheet = await openSheet(user, 'bob@acme.com');
    expect(within(sheet).getByRole('heading', { name: 'Bob Builder' })).toBeInTheDocument();
    expect(within(sheet).getByText('u2')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Make admin' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Promote to admin?')).toBeInTheDocument();
    expect(patchMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('u2', { is_admin: true }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const bobRow = document.querySelector<HTMLElement>('tr[data-user-id="u2"]')!;
    expect(within(bobRow).getByText('Admin')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Remove admin' })).toBeInTheDocument();
  });

  it('disables an account and surfaces backend errors in the dialog', async () => {
    const user = userEvent.setup();
    patchMock.mockRejectedValue({ response: { data: { detail: 'Cannot disable the last remaining admin' } } });
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    const sheet = await openSheet(user, 'bob@acme.com');
    await user.click(within(sheet).getByRole('button', { name: 'Disable account' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }));
    expect(await within(dialog).findByText('Cannot disable the last remaining admin')).toBeInTheDocument();
    expect(patchMock).toHaveBeenCalledWith('u2', { is_active: false });
  });

  it('deletes only after confirming, and cancel does nothing', async () => {
    const user = userEvent.setup();
    deleteMock.mockImplementation(async () => {
      fetchMock.mockResolvedValue([ME, CAROL]);
    });
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    let sheet = await openSheet(user, 'bob@acme.com');
    await user.click(within(sheet).getByRole('button', { name: 'Delete user' }));
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(deleteMock).not.toHaveBeenCalled();

    sheet = screen.getByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: 'Delete user' }));
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete user?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('u2'));
    await waitFor(() => expect(screen.queryByText('bob@acme.com')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('prevents admins from demoting, disabling or deleting themselves', async () => {
    const user = userEvent.setup();
    deleteMock.mockResolvedValue(undefined);
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    const sheet = await openSheet(user, 'me@nao.dev');
    expect(within(sheet).getByRole('button', { name: 'Remove admin' })).toBeDisabled();
    expect(within(sheet).getByRole('button', { name: 'Disable account' })).toBeDisabled();
    expect(within(sheet).getByRole('button', { name: 'Delete user' })).toBeDisabled();
    expect(within(sheet).getByText("You can't delete your own account.")).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: 'Select all visible users' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('3 selected')).toBeInTheDocument();
    // Only the current admin is an admin, so bulk demote has no valid targets.
    expect(within(bar).getByRole('button', { name: /Demote/ })).toBeDisabled();
    await user.click(within(bar).getByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete 2 users?')).toBeInTheDocument();
    expect(within(dialog).queryByText('me@nao.dev')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
    expect(deleteMock.mock.calls.map((c) => c[0]).sort()).toEqual(['u2', 'u3']);
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).not.toBeInTheDocument());
  });

  it('bulk enables selected users and reports per-user failures', async () => {
    const user = userEvent.setup();
    patchMock.mockRejectedValue({ response: { data: { detail: 'boom' } } });
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    await user.click(screen.getByRole('checkbox', { name: 'Select carol@corp.io' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select bob@acme.com' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    await user.click(within(bar).getByRole('button', { name: /Enable/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Enable 1 account?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('u3', { is_active: true }));
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(await within(dialog).findByText('carol@corp.io: boom')).toBeInTheDocument();
  });

  it('validates the reset password form before confirming and sending', async () => {
    const user = userEvent.setup();
    resetMock.mockResolvedValue(undefined);
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    const sheet = await openSheet(user, 'bob@acme.com');
    const submit = within(sheet).getByRole('button', { name: 'Reset password' });
    await user.click(submit);
    expect(await within(sheet).findByText('Password must be at least 8 characters')).toBeInTheDocument();

    await user.type(within(sheet).getByLabelText('New password'), 'longenough1');
    await user.click(submit);
    expect(await within(sheet).findByText('Include an uppercase letter')).toBeInTheDocument();

    await user.clear(within(sheet).getByLabelText('New password'));
    await user.type(within(sheet).getByLabelText('New password'), 'Longenough1');
    await user.type(within(sheet).getByLabelText('Confirm password'), 'different1');
    await user.click(submit);
    expect(await within(sheet).findByText('Passwords do not match')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.clear(within(sheet).getByLabelText('Confirm password'));
    await user.type(within(sheet).getByLabelText('Confirm password'), 'Longenough1');
    await user.click(submit);
    const dialog = await screen.findByRole('alertdialog');
    expect(resetMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(resetMock).toHaveBeenCalledWith('u2', 'Longenough1'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(within(sheet).getByLabelText('New password')).toHaveValue('');
  });

  it('shows an inline error with Retry when loading fails', async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce({ response: { data: { detail: 'Database unavailable' } } });
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Database unavailable');
    expect(screen.getByText('Users could not be loaded.')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides the signup requests panel when nothing is pending', async () => {
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(3));
    expect(screen.queryByRole('region', { name: 'Signup requests' })).not.toBeInTheDocument();
  });

  it('approves a pending signup from the requests panel', async () => {
    const user = userEvent.setup();
    requestsMock.mockResolvedValueOnce([PENDING_REQUEST]).mockResolvedValue([]);
    approveMock.mockResolvedValue(makeUser({ id: 'u4', email: 'dana@new.io', approval_status: 'approved' }));
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Signup requests' });
    expect(within(panel).getByText('dana@new.io')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Approve dana@new.io' }));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('u4'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Signup requests' })).not.toBeInTheDocument());
  });

  it('generates an access key with the chosen expiry and shows it once', async () => {
    const user = userEvent.setup();
    requestsMock.mockResolvedValue([PENDING_REQUEST]);
    issueKeyMock.mockResolvedValue({ key: 'K7M2XP9QRT', expires_at: '2026-10-08T07:00:00Z' });
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Signup requests' });
    await user.click(within(panel).getByRole('button', { name: /Access key/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Generate access key')).toBeInTheDocument();
    const before = Date.now();
    await user.click(within(dialog).getByRole('button', { name: /Generate key/ }));
    await waitFor(() => expect(issueKeyMock).toHaveBeenCalledTimes(1));
    const [userId, expiresAt] = issueKeyMock.mock.calls[0];
    expect(userId).toBe('u4');
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(threeDays - 1000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(threeDays + 5000);
    expect(await within(dialog).findByTestId('issued-access-key')).toHaveTextContent('K7M2XP9QRT');
  });

  it('rejects a pending signup only after confirmation', async () => {
    const user = userEvent.setup();
    requestsMock.mockResolvedValue([PENDING_REQUEST]);
    rejectMock.mockResolvedValue(makeUser({ id: 'u4', email: 'dana@new.io', approval_status: 'rejected' }));
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Signup requests' });
    await user.click(within(panel).getByRole('button', { name: 'Reject dana@new.io' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(rejectMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(rejectMock).toHaveBeenCalledWith('u4'));
  });

  it('labels pending accounts in the table and approves them from the detail sheet', async () => {
    const user = userEvent.setup();
    const dana = makeUser({ id: 'u4', email: 'dana@new.io', approval_status: 'pending' });
    fetchMock.mockResolvedValue([ME, BOB, CAROL, dana]);
    approveMock.mockResolvedValue({ ...dana, approval_status: 'approved' });
    renderPage();
    await waitFor(() => expect(dataRows()).toHaveLength(4));
    expect(within(rowFor('dana@new.io')).getByText('Pending approval')).toBeInTheDocument();
    const sheet = await openSheet(user, 'dana@new.io');
    await user.click(within(sheet).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('u4'));
  });
});
