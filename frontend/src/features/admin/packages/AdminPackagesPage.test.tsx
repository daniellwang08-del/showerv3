import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAdminUsers } from '@/api/adminApi';
import { adminBulkGrant, adminRevokePackage, fetchAdminPackages, fetchAdminStoreOverview } from '@/api/storeApi';
import type { AdminUser } from '@/types/admin';
import type { AdminPackage, AdminStoreOverview, CatalogEntry } from '@/types/store';
import { AdminPackagesPage } from './AdminPackagesPage';
import { bundleTotals, packageStatus, parseRecipients } from './packagesModel';

vi.mock('@/api/storeApi', () => ({
  fetchAdminStoreOverview: vi.fn(),
  fetchAdminPackages: vi.fn(),
  adminBulkGrant: vi.fn(),
  adminRevokePackage: vi.fn(),
}));
vi.mock('@/api/adminApi', () => ({ fetchAdminUsers: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const catalog: CatalogEntry[] = [
  { code: 'starter', kind: 'credits', name: 'Starter', credits: 250, price_cents: 2500 },
  { code: 'growth', kind: 'credits', name: 'Growth', credits: 500, price_cents: 4500 },
  { code: 'pro', kind: 'credits', name: 'Pro', credits: 1000, price_cents: 8000 },
  { code: 'scale', kind: 'credits', name: 'Scale', credits: 10000, price_cents: 50000 },
  { code: 'team', kind: 'team', name: 'TEAM', credits: 0, price_cents: 2000 },
];

const zero = { held: 0, waiting: 0, redeemed: 0, revoked: 0 };
const overview: AdminStoreOverview = {
  totals: { held: 7, waiting: 2, redeemed: 4, revoked: 1 },
  by_code: { starter: zero, growth: zero, pro: { held: 5, waiting: 2, redeemed: 3, revoked: 1 }, scale: zero, team: { ...zero, held: 2, redeemed: 1 } },
  unused_credits: 5000,
  granted_value_cents: 61000,
  credit_balance_total: 1200,
  users_with_credits: 3,
  holders: 4,
  team_spaces: 1,
  grant_trend: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(i + 7).padStart(2, '0')}`, count: i % 3 })),
  catalog,
};

const pkg = (over: Partial<AdminPackage>): AdminPackage => ({
  id: 'p1',
  code: 'pro',
  kind: 'credits',
  name: 'Pro',
  credits: 1000,
  price_cents: 8000,
  status: 'held',
  source: 'admin_grant',
  owner: { id: 'u1', name: 'Pat Lee', email: 'pat@x.io' },
  pending_email: null,
  gifted_from: null,
  note: null,
  redeemed_at: null,
  team_space: null,
  created_at: '2026-10-20T10:00:00Z',
  updated_at: '2026-10-20T10:00:00Z',
  granted_by: { id: 'a1', name: 'Ada Admin', email: 'ada@nao.dev' },
  revoked_at: null,
  revoked_by: null,
  revoke_reason: null,
  ...over,
});

const user = (over: Partial<AdminUser>): AdminUser => ({
  id: 'u1',
  email: 'pat@x.io',
  display_name: 'Pat Lee',
  is_active: true,
  is_admin: false,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/admin/packages']}>
        <AdminPackagesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

async function row(id: string): Promise<HTMLElement> {
  await screen.findAllByText('Pat Lee');
  return document.querySelector(`[data-package-id="${id}"]`) as HTMLElement;
}

beforeEach(() => {
  vi.mocked(fetchAdminStoreOverview).mockResolvedValue(overview);
  vi.mocked(fetchAdminPackages).mockResolvedValue({
    total: 3,
    items: [
      pkg({ note: 'Welcome to the beta' }),
      pkg({ id: 'p2', owner: null, pending_email: 'new@x.io' }),
      pkg({
        id: 'p3',
        code: 'team',
        kind: 'team',
        name: 'TEAM',
        credits: 0,
        status: 'redeemed',
        team_space: { id: 's1', public_id: 'nao-12345678', name: 'Backend squad' },
      }),
    ],
  });
  vi.mocked(fetchAdminUsers).mockResolvedValue([
    user({}),
    user({ id: 'u2', email: 'sam@x.io', display_name: 'Sam Park' }),
    user({ id: 'a1', email: 'ada@nao.dev', display_name: 'Ada Admin', is_admin: true }),
  ]);
});

describe('AdminPackagesPage', () => {
  it('shows store totals and every package with its holder and state', async () => {
    renderPage();
    const totals = await screen.findByRole('region', { name: 'Package totals' });
    const unused = within(totals).getByRole('button', { name: /Unused packages/ });
    expect(within(unused).getByText('7')).toBeInTheDocument();
    expect(within(unused).getByText('held by 4 people')).toBeInTheDocument();
    expect(within(totals).getByRole('button', { name: /Awaiting signup/ })).toHaveTextContent('2');

    const pat = await row('p1');
    expect(within(pat).getByText('Granted by Ada Admin')).toBeInTheDocument();
    expect(within(pat).getByLabelText('Note: Welcome to the beta')).toBeInTheDocument();
    const waiting = await row('p2');
    expect(within(waiting).getByText('No account yet')).toBeInTheDocument();
    expect(within(waiting).getByText('Awaiting signup')).toBeInTheDocument();
    const team = await row('p3');
    expect(within(team).getByText('Opened Backend squad (nao-12345678)')).toBeInTheDocument();
  });

  it('filters by status from the toolbar and from a stat tile', async () => {
    const u = userEvent.setup();
    renderPage();
    const totals = await screen.findByRole('region', { name: 'Package totals' });
    await u.click(within(totals).getByRole('button', { name: /Awaiting signup/ }));
    await waitFor(() =>
      expect(fetchAdminPackages).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'waiting', offset: 0 })),
    );
    const toolbar = screen.getByRole('group', { name: 'Filter by status' });
    await u.click(within(toolbar).getByRole('button', { name: /Used/ }));
    await waitFor(() => expect(fetchAdminPackages).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'redeemed' })));
  });

  it('grants a bundle to several people, skipping admins and keeping new emails', async () => {
    const u = userEvent.setup();
    vi.mocked(adminBulkGrant).mockResolvedValue({
      granted: [
        { email: 'sam@x.io', user: { id: 'u2', name: 'Sam Park', email: 'sam@x.io' }, pending: false, count: 3 },
        { email: 'new@x.io', user: null, pending: true, count: 3 },
      ],
      skipped: [],
      total_packages: 6,
    });
    renderPage();
    await screen.findByRole('region', { name: 'Package totals' });
    await u.click(screen.getByRole('button', { name: 'Grant packages' }));
    const dialog = await screen.findByRole('dialog');

    const field = within(dialog).getByRole('combobox', { name: 'Add recipients' });
    await u.type(field, 'sam');
    await u.click(await within(dialog).findByRole('option', { name: /Sam Park/ }));
    fireEvent.paste(field, { clipboardData: { getData: () => 'new@x.io, ada@nao.dev\nnope' } });

    expect(dialog.querySelector('[data-recipient="sam@x.io"]')).toHaveAttribute('data-state', 'account');
    expect(dialog.querySelector('[data-recipient="new@x.io"]')).toHaveAttribute('data-state', 'new');
    expect(dialog.querySelector('[data-recipient="ada@nao.dev"]')).toHaveAttribute('data-state', 'admin');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Not an email: nope');

    await u.click(within(dialog).getByRole('button', { name: 'More Pro' }));
    await u.click(within(dialog).getByRole('button', { name: 'More Pro' }));
    await u.click(within(dialog).getByRole('button', { name: 'Add TEAM' }));
    await u.type(within(dialog).getByLabelText(/Note to recipients/), 'Welcome aboard');

    expect(within(dialog).getByText(/2 team spaces/)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Grant 6 packages' }));

    await waitFor(() =>
      expect(adminBulkGrant).toHaveBeenCalledWith({
        recipients: ['sam@x.io', 'new@x.io'],
        items: [
          { code: 'pro', quantity: 2 },
          { code: 'team', quantity: 1 },
        ],
        note: 'Welcome aboard',
      }),
    );
    expect(await within(dialog).findByText('Granted 6 packages')).toBeInTheDocument();
    expect(within(dialog).getByText('Claims at signup')).toBeInTheDocument();
  });

  it('revokes an unused package with a reason', async () => {
    const u = userEvent.setup();
    vi.mocked(adminRevokePackage).mockResolvedValue(pkg({ status: 'revoked' }));
    renderPage();
    const pat = await row('p1');
    await u.click(within(pat).getByRole('button', { name: 'Actions for Pro package' }));
    await u.click(await screen.findByRole('menuitem', { name: /Revoke package/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Pat Lee (pat@x.io)');
    await u.type(within(dialog).getByLabelText(/Reason/), 'Wrong account');
    await u.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(adminRevokePackage).toHaveBeenCalledWith('p1', 'Wrong account'));
  });

  it('does not offer revoke for used packages', async () => {
    const u = userEvent.setup();
    renderPage();
    const team = await row('p3');
    await u.click(within(team).getByRole('button', { name: 'Actions for TEAM package' }));
    expect(await screen.findByRole('menuitem', { name: /Copy package ID/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Revoke package/ })).toBeNull();
  });
});

describe('packagesModel', () => {
  it('parses pasted recipient lists', () => {
    expect(parseRecipients(' A@x.io,b@x.io;\n<c@x.io> bad a@x.io', ['b@x.io'])).toEqual({
      emails: ['a@x.io', 'c@x.io'],
      invalid: ['bad'],
    });
  });

  it('totals a bundle per person and across everyone', () => {
    const t = bundleTotals({ pro: 2, team: 1 }, catalog, 3);
    expect(t.perPerson).toEqual({ packages: 3, credits: 2000, cents: 18000, teams: 1 });
    expect(t.all).toEqual({ packages: 9, credits: 6000, cents: 54000, teams: 3 });
  });

  it('reads a held package with no account as awaiting signup', () => {
    expect(packageStatus(pkg({ owner: null, pending_email: 'x@y.io' }))).toBe('waiting');
    expect(packageStatus(pkg({}))).toBe('held');
    expect(packageStatus(pkg({ status: 'revoked' }))).toBe('revoked');
  });
});
