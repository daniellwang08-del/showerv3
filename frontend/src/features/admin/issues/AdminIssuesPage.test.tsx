import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAdminIssue, fetchAdminIssues, updateIssue } from '@/api/issuesApi';
import type { IssueReport } from '@/types/issues';
import { AdminIssuesPage } from './AdminIssuesPage';

vi.mock('@/api/issuesApi', async (orig) => ({
  ...(await orig<typeof import('@/api/issuesApi')>()),
  fetchAdminIssues: vi.fn(),
  fetchAdminIssue: vi.fn(),
  updateIssue: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const issue = (over: Partial<IssueReport> = {}): IssueReport => ({
  id: 'i1',
  number: 42,
  category: 'autofill',
  title: 'Resume did not upload on Workable',
  description: 'I clicked Autofill on the Workable form.\nThe resume field stayed empty.',
  status: 'open',
  source: 'extension',
  page_url: 'https://apply.workable.com/acme/j/123/apply',
  page_title: 'Backend Engineer - Acme',
  attachments: [
    { id: 'a1', kind: 'image', filename: 'Screenshot 2026-10-21.png', content_type: 'image/png', byte_size: 120_000 },
    { id: 'a2', kind: 'file', filename: 'My resume.pdf', content_type: 'application/pdf', byte_size: 2_400_000 },
  ],
  created_at: '2026-10-21T15:00:00Z',
  updated_at: '2026-10-21T15:00:00Z',
  status_changed_at: null,
  context: { extension_version: '2.4.2', panel_view: 'job', job_title: 'Backend Engineer', user_agent: 'Chrome/141' },
  admin_note: null,
  reporter: { id: 'u1', name: 'Pat Lee', email: 'pat@x.io' },
  status_changed_by: null,
  ...over,
});

const renderPage = (path = '/admin/issues') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <AdminIssuesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAdminIssues).mockResolvedValue({
    total: 1,
    counts: { open: 1, in_progress: 2, resolved: 3, closed: 0 },
    items: [issue()],
  });
  vi.mocked(fetchAdminIssue).mockResolvedValue(issue());
});

describe('AdminIssuesPage', () => {
  it('lists open issues with reporter, status, topic, and attachment count', async () => {
    renderPage();
    const row = await waitFor(() => {
      const el = document.querySelector('[data-issue-id="i1"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(row).getByText('#42')).toBeInTheDocument();
    expect(within(row).getByText('Resume did not upload on Workable')).toBeInTheDocument();
    expect(within(row).getByText('Pat Lee')).toBeInTheDocument();
    expect(within(row).getByText('Autofill or applying')).toBeInTheDocument();
    expect(within(row).getByLabelText('1 screenshot, 1 file')).toHaveTextContent('2');
    expect(fetchAdminIssues).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', offset: 0 }));
    expect(screen.getByRole('group', { name: 'Filter by status' })).toHaveTextContent('In progress2');
  });

  it('opens an issue with its screenshots, files, page, and diagnostics', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('Resume did not upload on Workable'));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText(/The resume field stayed empty/)).toBeInTheDocument();
    const shot = within(sheet).getByRole('img', { name: 'Screenshot 2026-10-21.png' });
    expect(shot).toHaveAttribute('src', '/api/v1/issues/i1/attachments/a1');
    const download = within(sheet).getByRole('link', { name: 'Download My resume.pdf' });
    expect(download).toHaveAttribute('href', '/api/v1/issues/i1/attachments/a2?download=true');
    expect(within(sheet).getByText('2.3 MB')).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: /Backend Engineer - Acme/ })).toHaveAttribute(
      'href',
      'https://apply.workable.com/acme/j/123/apply',
    );
    expect(within(sheet).getByText('2.4.2')).toBeInTheDocument();
    expect(within(sheet).getByText('Chrome/141')).toBeInTheDocument();
  });

  it('changes the status and saves an internal note', async () => {
    const user = userEvent.setup();
    vi.mocked(updateIssue).mockImplementation(async (_id, body) => issue({ ...body } as Partial<IssueReport>));
    renderPage('/admin/issues?issue=i1');

    const sheet = await screen.findByRole('dialog');
    const status = await within(sheet).findByRole('group', { name: 'Issue status' });
    await user.click(within(status).getByRole('button', { name: /In progress/ }));
    await waitFor(() => expect(updateIssue).toHaveBeenCalledWith('i1', { status: 'in_progress' }));

    const save = within(sheet).getByRole('button', { name: 'Save note' });
    expect(save).toBeDisabled();
    await user.type(within(sheet).getByLabelText('Internal note'), 'Workable changed the upload widget.');
    await user.click(save);
    await waitFor(() =>
      expect(updateIssue).toHaveBeenCalledWith('i1', { admin_note: 'Workable changed the upload widget.' }),
    );
  });

  it('shows all statuses when All is picked and explains an empty result', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Resume did not upload on Workable');
    vi.mocked(fetchAdminIssues).mockResolvedValue({ total: 0, counts: { open: 0, in_progress: 0, resolved: 0, closed: 0 }, items: [] });
    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() =>
      expect(fetchAdminIssues).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined })),
    );
    expect(await screen.findByText('No issues match these filters.')).toBeInTheDocument();
  });
});
