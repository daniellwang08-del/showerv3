import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import { deleteProfileSourceDocument, listProfileSourceDocuments } from '@/api/profileSourceDocumentsApi';
import { completeProfile, emptyProfile } from '@/test/profileFixtures';
import type { UserProfile } from '@/types/profile';
import type { ProfileSourceDocument } from '@/types/profileSourceDocument';
import { ProfilePage } from './ProfilePage';

vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/api/profileSourceDocumentsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/profileSourceDocumentsApi')>()),
  listProfileSourceDocuments: vi.fn(),
  uploadProfileSourceDocument: vi.fn(),
  updateProfileSourceDocumentCompany: vi.fn(),
  reparseProfileSourceDocument: vi.fn(),
  deleteProfileSourceDocument: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn() }),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const api = apiClient as unknown as Record<'get' | 'put' | 'post' | 'patch' | 'delete', ReturnType<typeof vi.fn>>;

const doc: ProfileSourceDocument = {
  id: 'doc-1',
  filename: 'acme-projects.pdf',
  source_kind: 'pdf',
  company_name: 'Acme',
  char_count: 12_400,
  project_count: 3,
  parse_status: 'completed',
  parse_error: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function serveProfile(profile: UserProfile | null) {
  api.get.mockImplementation(async (url: string) => {
    if (url !== '/profile') throw new Error(`unexpected GET ${url}`);
    if (!profile) throw { response: { status: 404 } };
    return { data: profile };
  });
}

function echoPut() {
  api.put.mockImplementation(async (_url: string, body: Partial<UserProfile>) => ({
    data: { ...completeProfile, ...body, updated_at: '2024-07-01T00:00:00Z' },
  }));
}

function renderPage(props: Parameters<typeof ProfilePage>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProfilePage {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function section(name: string) {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listProfileSourceDocuments).mockResolvedValue([]);
  echoPut();
});

describe('ProfilePage', () => {
  it('shows skeletons while loading and an error with retry', async () => {
    api.get.mockReturnValueOnce(new Promise(() => {}));
    const { unmount } = renderPage();
    expect(screen.getByLabelText('Loading profile')).toBeInTheDocument();
    unmount();

    api.get.mockRejectedValueOnce({ response: { status: 500, data: { detail: 'Server exploded' } } });
    renderPage();
    expect(await screen.findByText('Server exploded')).toBeInTheDocument();
    serveProfile(completeProfile);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
  });

  it('renders the saved profile read-only with a full completeness meter', async () => {
    serveProfile(completeProfile);
    renderPage();
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    const meter = screen.getByLabelText('Profile completeness');
    expect(within(meter).getByText('100%')).toBeInTheDocument();
    expect(within(meter).getByText('Your profile is ready for tailoring')).toBeInTheDocument();
    expect(within(section('Experience')).getByText('Led backend rewrite')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^First name/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Preferences' })).toHaveAttribute('href', '/app/preferences');
  });

  it('completeness suggestions open the matching section in edit mode', async () => {
    serveProfile(emptyProfile);
    renderPage();
    const meter = await screen.findByLabelText('Profile completeness');
    expect(within(meter).getByText('0%')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Profile summary/)).not.toBeInTheDocument();
    await userEvent.click(within(meter).getByRole('button', { name: /Professional title/ }));
    expect(screen.getByLabelText(/^Professional title/)).toBeInTheDocument();
    expect(within(section('Basics')).getByRole('button', { name: 'Save Basics' })).toBeInTheDocument();
  });

  it('edits and saves Basics with the full PUT payload', async () => {
    const onProfileSaved = vi.fn();
    serveProfile(completeProfile);
    renderPage({ onProfileSaved });
    await screen.findByText('Jane Doe');

    await userEvent.click(screen.getByRole('button', { name: 'Edit Basics' }));
    const title = screen.getByLabelText(/^Professional title/);
    await userEvent.clear(title);
    await userEvent.type(title, 'Principal Engineer');
    await userEvent.click(screen.getByRole('button', { name: 'Save Basics' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/profile');
    expect(body).toMatchObject({
      name_first: 'Jane',
      name_last: 'Doe',
      title: 'Principal Engineer',
      email: 'jane@example.com',
      phone_country_code: '+1',
      phone_number: '6102347936',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      technical_skills: [{ category: 'Languages', skills: 'Python, TypeScript' }],
      certificates: [{ name: 'AWS SAP', issued_at: '2023-01', url: 'https://example.com/cert' }],
      address: { country: 'United States of America', local_preferences: [] },
    });
    expect(body.work_experience[0]).toMatchObject({ company_name: 'Acme', period_end: 'Present' });

    await waitFor(() => expect(onProfileSaved).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('Basics saved');
    expect(await screen.findByText('Principal Engineer')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Professional title/)).not.toBeInTheDocument();
  });

  it('shows inline errors for a bad LinkedIn URL and phone and blocks save', async () => {
    serveProfile(completeProfile);
    renderPage();
    await screen.findByText('Jane Doe');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Basics' }));

    const linkedin = screen.getByLabelText(/^LinkedIn URL/);
    await userEvent.clear(linkedin);
    await userEvent.type(linkedin, 'https://example.com/jane');
    await userEvent.tab();
    expect(await screen.findByText('Use a profile URL (linkedin.com/in/…)')).toBeInTheDocument();
    expect(linkedin).toHaveAttribute('aria-invalid', 'true');

    const phone = screen.getByLabelText(/^Phone number/);
    await userEvent.clear(phone);
    await userEvent.type(phone, '12345');
    await userEvent.click(screen.getByRole('button', { name: 'Save Basics' }));
    expect(await screen.findByText(/US\/Canada numbers need 10 digits/)).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Fix 2 fields in Basics/));
  });

  it('adds and removes work entries', async () => {
    serveProfile(completeProfile);
    renderPage();
    await screen.findByText('Jane Doe');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Experience' }));

    await userEvent.click(screen.getByRole('button', { name: 'Add role' }));
    const added = screen.getByTestId('work-entry-1');
    await userEvent.type(within(added).getByLabelText('Company'), 'Globex');
    await userEvent.type(within(added).getByLabelText('Job title'), 'CTO');
    await userEvent.type(within(added).getByLabelText('Start'), 'Jan 2019');
    await userEvent.tab();
    expect(within(added).getByLabelText('Start')).toHaveValue('2019-01');

    await userEvent.click(screen.getByRole('button', { name: 'Remove role 1' }));
    expect(screen.queryByTestId('work-entry-1')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('work-entry-0')).getByLabelText('Company')).toHaveValue('Globex');

    await userEvent.click(screen.getByRole('button', { name: 'Save Experience' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const body = api.put.mock.calls[0][1];
    expect(body.work_experience).toHaveLength(1);
    expect(body.work_experience[0]).toMatchObject({ company_name: 'Globex', job_title: 'CTO', period_start: '2019-01' });
  });

  it('new users see the résumé import card and every section in edit mode', async () => {
    serveProfile(null);
    renderPage();
    expect(await screen.findByRole('region', { name: 'Import from résumé' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^First name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Profile summary/)).toBeInTheDocument();
    for (const name of ['Basics', 'Summary', 'Skills', 'Experience', 'Education', 'Certifications', 'Additional']) {
      expect(screen.getByRole('button', { name: `Save ${name}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Edit Basics' })).not.toBeInTheDocument();
  });

  it('résumé import with conflicts asks first, then "Fill empty fields only" saves', async () => {
    serveProfile(completeProfile);
    api.post.mockResolvedValue({
      data: {
        draft: { name_first: 'Janet', name_middle: 'Q', title: 'Engineer', email: 'jane@example.com' },
        source_kind: 'pdf',
        warnings: ['Page 2 was blurry'],
      },
    });
    const onProfileSaved = vi.fn();
    renderPage({ onProfileSaved, accountEmail: 'jane@example.com' });
    await screen.findByText('Jane Doe');

    const file = new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Résumé file'), file);
    expect(api.post).toHaveBeenCalledWith('/profile/resume-parse', expect.any(FormData), expect.anything());

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Résumé overlaps your saved profile')).toBeInTheDocument();
    expect(within(dialog).getByText('First name')).toBeInTheDocument();
    expect(within(dialog).getByText('Page 2 was blurry')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Replace with résumé' })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Fill empty fields only' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const body = api.put.mock.calls[0][1];
    expect(body).toMatchObject({ name_first: 'Jane', name_middle: 'Q', title: 'Staff Engineer' });
    await waitFor(() => expect(onProfileSaved).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Profile imported from résumé');
  });

  it('résumé import that fails validation opens the form with errors instead of saving', async () => {
    serveProfile(null);
    api.post.mockResolvedValue({
      data: { draft: { name_first: 'Sam', name_last: 'Lee', title: 'Designer' }, source_kind: 'docx', warnings: [] },
    });
    renderPage({ accountEmail: 'sam@example.com' });
    await userEvent.upload(
      await screen.findByLabelText('Résumé file'),
      new File(['x'], 'cv.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    );

    expect(await screen.findByLabelText(/^First name/)).toHaveValue('Sam');
    expect(screen.getByLabelText(/^Email/)).toHaveValue('sam@example.com');
    expect(screen.getByText('Phone number is required')).toBeInTheDocument();
    expect(screen.getByText('LinkedIn URL is required')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('deletes a source document only after confirming', async () => {
    serveProfile(completeProfile);
    vi.mocked(listProfileSourceDocuments).mockResolvedValue([doc]);
    vi.mocked(deleteProfileSourceDocument).mockResolvedValue(undefined);
    renderPage();
    await screen.findByText('Jane Doe');

    const docs = section('Source documents');
    expect(await within(docs).findByText('acme-projects.pdf')).toBeInTheDocument();
    expect(within(docs).getByText('Ready')).toBeInTheDocument();
    expect(within(docs).getByText('· 12k chars')).toBeInTheDocument();

    await userEvent.click(within(docs).getByRole('button', { name: 'Delete acme-projects.pdf' }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(deleteProfileSourceDocument).not.toHaveBeenCalled();

    await userEvent.click(within(docs).getByRole('button', { name: 'Delete acme-projects.pdf' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteProfileSourceDocument).toHaveBeenCalledWith('doc-1'));
    await waitFor(() => expect(within(docs).queryByText('acme-projects.pdf')).not.toBeInTheDocument());
  });
});
