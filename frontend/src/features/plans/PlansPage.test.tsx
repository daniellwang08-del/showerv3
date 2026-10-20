import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStore, giftPackage, redeemPackage } from '@/api/storeApi';
import { createTeamSpace } from '@/api/teamApi';
import type { StorePackage, StoreResponse } from '@/types/store';
import { PlansPage } from './PlansPage';

vi.mock('@/api/storeApi', () => ({
  fetchStore: vi.fn(),
  fetchLedger: vi.fn().mockResolvedValue({ balance: 50, entries: [] }),
  redeemPackage: vi.fn(),
  giftPackage: vi.fn(),
  cancelGift: vi.fn(),
}));
vi.mock('@/api/teamApi', () => ({ createTeamSpace: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

const pkg = (over: Partial<StorePackage>): StorePackage => ({
  id: 'p1',
  code: 'pro',
  kind: 'credits',
  name: 'Pro',
  credits: 1000,
  price_cents: 8000,
  status: 'held',
  source: 'admin_grant',
  owner: null,
  pending_email: null,
  gifted_from: null,
  redeemed_at: null,
  team_space: null,
  created_at: null,
  updated_at: null,
  ...over,
});

const store = (over: Partial<StoreResponse> = {}): StoreResponse => ({
  balance: 50,
  held: [],
  used: [],
  given: [],
  catalog: [],
  ...over,
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PlansPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.mocked(fetchStore).mockResolvedValue(store());
});

describe('PlansPage', () => {
  it('lists the four credit packages with their prices', () => {
    renderPage();
    const pro = screen.getByRole('article', { name: 'Pro package' });
    expect(within(pro).getByText('Most popular')).toBeInTheDocument();
    expect(within(pro).getByText('$80')).toBeInTheDocument();
    expect(within(pro).getByText('Save 20%')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Starter package' })).getByText('Base rate')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Scale package' })).getByText('$500')).toBeInTheDocument();
    expect(screen.getByText('50 credits')).toBeInTheDocument();
  });

  it('marks the package that fits the default pace', () => {
    renderPage();
    const starter = screen.getByRole('article', { name: 'Starter package' });
    expect(within(starter).getByText('Fits your pace')).toBeInTheDocument();
    expect(screen.getByText('Starter, 250 credits for $25')).toBeInTheDocument();
  });

  it('previews the order without charging', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Buy 1,000 credits' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Buy Pro credits')).toBeInTheDocument();
    expect(within(dialog).getByText('-$20')).toBeInTheDocument();
    expect(within(dialog).getByText('Checkout opens soon')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
  });

  it('offers the TEAM package at $20', async () => {
    const user = userEvent.setup();
    renderPage();
    const team = screen.getByRole('article', { name: 'TEAM package' });
    expect(within(team).getByText('$20')).toBeInTheDocument();
    await user.click(within(team).getByRole('button', { name: 'Buy TEAM' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Buy a TEAM package')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
  });

  it('shows the balance and groups identical held packages', async () => {
    vi.mocked(fetchStore).mockResolvedValue(
      store({ balance: 320, held: [pkg({ id: 'a' }), pkg({ id: 'b' }), pkg({ id: 't', code: 'team', kind: 'team', name: 'TEAM', credits: 0 })] }),
    );
    renderPage();
    expect(await screen.findByLabelText('320 credits')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Pro package, 2 held' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'TEAM package' })).toBeInTheDocument();
  });

  it('adds a credit package to the balance', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchStore).mockResolvedValue(store({ held: [pkg({})] }));
    vi.mocked(redeemPackage).mockResolvedValue({ balance: 1050, package: pkg({ status: 'redeemed' }) });
    renderPage();
    const card = await screen.findByRole('listitem', { name: 'Pro package' });
    await user.click(within(card).getByRole('button', { name: /Add to balance/ }));
    await waitFor(() => expect(redeemPackage).toHaveBeenCalledWith('p1'));
  });

  it('gives a package by email', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchStore).mockResolvedValue(store({ held: [pkg({})] }));
    vi.mocked(giftPackage).mockResolvedValue(pkg({ pending_email: 'new@x.io' }));
    renderPage();
    const card = await screen.findByRole('listitem', { name: 'Pro package' });
    await user.click(within(card).getByRole('button', { name: /Give/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Their email'), 'new@x.io');
    await user.click(within(dialog).getByRole('button', { name: 'Give package' }));
    await waitFor(() => expect(giftPackage).toHaveBeenCalledWith('p1', 'new@x.io'));
  });

  it('opens a team space from a TEAM package', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchStore).mockResolvedValue(
      store({ held: [pkg({ id: 't1', code: 'team', kind: 'team', name: 'TEAM', credits: 0 })] }),
    );
    vi.mocked(createTeamSpace).mockResolvedValue({
      id: 's1',
      public_id: 'nao-12345678',
      name: 'Backend squad',
      lead: null,
      member_count: 0,
      pending_invites: 0,
      default_share_scope: null,
      default_share_locked: false,
      created_at: null,
    });
    renderPage();
    const card = await screen.findByRole('listitem', { name: 'TEAM package' });
    await user.click(within(card).getByRole('button', { name: /Create team space/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Team name'), 'Backend squad');
    await user.click(within(dialog).getByRole('button', { name: 'Create team space' }));
    await waitFor(() => expect(createTeamSpace).toHaveBeenCalledWith('t1', 'Backend squad'));
  });

  it('lets the sender take back a gift nobody claimed', async () => {
    vi.mocked(fetchStore).mockResolvedValue(store({ given: [pkg({ id: 'g1', pending_email: 'later@x.io' })] }));
    renderPage();
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Given away/ }));
    expect(await screen.findByText('Waiting for later@x.io to sign up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take back/ })).toBeInTheDocument();
  });
});
