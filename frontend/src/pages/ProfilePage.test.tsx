import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ProfilePage } from './ProfilePage';
import { NotificationToasts } from '../components/shared/NotificationToasts';
import { apiClient } from '../api/client';
import { useUIStore } from '../stores/uiStore';
import { axiosError, completeProfile, emptyProfile } from '../test/profileFixtures';

vi.mock('../api/client', () => ({
  apiClient: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockedClient = vi.mocked(apiClient);

function notificationMessages() {
  return useUIStore.getState().notifications.map((n) => n.message);
}

function mockGets(profile = completeProfile, documents: unknown[] = []) {
  mockedClient.get.mockImplementation(async (url: string) => {
    if (url === '/profile') return { data: profile };
    if (url === '/profile/source-documents') return { data: { documents } };
    throw new Error(`unexpected GET ${url}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ProfilePage user={{ id: 'user-1', email: 'jane@example.com', name: 'Jane' }} onLogout={() => {}} />
      <NotificationToasts />
    </MemoryRouter>,
  );
}

describe('Profile page workflows', () => {
  beforeEach(() => {
    mockedClient.get.mockReset();
    mockedClient.put.mockReset();
    mockedClient.post.mockReset();
    mockedClient.patch.mockReset();
    mockedClient.delete.mockReset();
    mockGets();
    mockedClient.put.mockResolvedValue({ data: completeProfile });
  });

  it('loads a saved profile and shows completion', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Your profile' })).toBeInTheDocument();
    expect(screen.getByText(/10 of 10 core areas/i)).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Staff Engineer')).toBeInTheDocument();
  });

  it('loads an empty profile without crashing', async () => {
    mockGets(emptyProfile);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Your profile' })).toBeInTheDocument();
    expect(screen.getByText(/0 of 10 core areas/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose PDF or DOCX/i })).toBeInTheDocument();
  });

  it('notifies when profile load fails', async () => {
    mockedClient.get.mockImplementation(async (url: string) => {
      if (url === '/profile') throw axiosError(500, 'database is on fire');
      if (url === '/profile/source-documents') return { data: { documents: [] } };
      throw new Error(`unexpected GET ${url}`);
    });
    renderPage();
    await waitFor(() => {
      expect(notificationMessages().join(' ')).toMatch(/database is on fire/i);
    });
    expect(screen.getAllByText(/database is on fire/i).length).toBeGreaterThan(0);
  });

  it('saves the contact section for a complete profile', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Jane Doe');

    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const firstName = screen.getByLabelText(/First name/i);
    await user.clear(firstName);
    await user.type(firstName, 'Janet');
    await user.click(screen.getByRole('button', { name: 'Save section' }));

    await waitFor(() => expect(mockedClient.put).toHaveBeenCalledTimes(1));
    const body = mockedClient.put.mock.calls[0][1] as { name_first: string };
    expect(body.name_first).toBe('Janet');
    await waitFor(() => {
      expect(notificationMessages().join(' ')).toMatch(/saved successfully/i);
    });
  });

  it('blocks an incomplete first save and notifies', async () => {
    mockGets(emptyProfile);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Your profile' });

    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await user.type(screen.getByLabelText(/First name/i), 'Jane');
    await user.type(screen.getByLabelText(/Last name/i), 'Doe');
    await user.click(screen.getAllByRole('button', { name: 'Save section' })[0]);

    expect(mockedClient.put).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(notificationMessages().join(' ')).toMatch(/remaining required fields/i);
    });
  });

  it('notifies when save returns unexpected field validation', async () => {
    mockedClient.put.mockRejectedValue(
      axiosError(422, [
        { loc: ['body', 'mystery_key'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' },
      ]),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Jane Doe');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await user.click(screen.getByRole('button', { name: 'Save section' }));

    await waitFor(() => {
      expect(notificationMessages().join(' ')).toMatch(/Unexpected field 'mystery_key'/i);
    });
  });

  it('notifies when resume parse fails with an invalid API key', async () => {
    mockedClient.post.mockRejectedValue(
      axiosError(
        503,
        "All LLM providers failed. openai: AuthenticationError: Error code: 401 - Incorrect API key provided",
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /Choose PDF or DOCX/i });

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const resumeInput = fileInputs[0] as HTMLInputElement;
    const file = new File(['%PDF-1.4 fake'], 'resume.pdf', { type: 'application/pdf' });
    await user.upload(resumeInput, file);

    await waitFor(() => {
      expect(notificationMessages().join(' ')).toMatch(/invalid or missing API key/i);
    });
  });

  it('notifies when resume parse returns a JSON parse error', async () => {
    mockedClient.post.mockRejectedValue(axiosError(503, 'Failed to parse extracted profile JSON'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /Choose PDF or DOCX/i });
    const resumeInput = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
    await user.upload(resumeInput, new File(['x'], 'resume.pdf', { type: 'application/pdf' }));
    await waitFor(() => {
      expect(notificationMessages().join(' ')).toMatch(/Could not parse the extracted résumé/i);
    });
  });

  it('applies a résumé draft when there are no conflicts', async () => {
    mockGets({ ...completeProfile, github_url: null });
    mockedClient.post.mockResolvedValue({
      data: {
        draft: {
          github_url: 'https://github.com/jane-new',
        },
        source_kind: 'pdf',
        warnings: [],
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Jane Doe');
    const resumeInput = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
    await user.upload(resumeInput, new File(['x'], 'resume.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(mockedClient.put).toHaveBeenCalled());
    const body = mockedClient.put.mock.calls[0][1] as { github_url: string | null };
    expect(body.github_url).toContain('github.com/jane-new');
  });

  it('opens the overlap modal when the résumé would replace saved fields', async () => {
    mockedClient.post.mockResolvedValue({
      data: {
        draft: {
          name_first: 'Janet',
          name_last: 'Doe',
          title: 'Principal Engineer',
        },
        source_kind: 'docx',
        warnings: [],
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Jane Doe');
    const resumeInput = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
    await user.upload(resumeInput, new File(['x'], 'cv.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/overlaps your saved profile/i)).toBeInTheDocument();
    expect(mockedClient.put).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /Fill empty fields only/i }));
    await waitFor(() => expect(mockedClient.put).toHaveBeenCalled());
  });

  it('rejects unsupported résumé file types without calling the API', async () => {
    renderPage();
    await screen.findByRole('button', { name: /Choose PDF or DOCX/i });
    const resumeInput = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
    fireEvent.change(resumeInput, {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    expect(mockedClient.post).not.toHaveBeenCalled();
    expect(await screen.findByText(/Please choose a PDF or DOCX file/i)).toBeInTheDocument();
  });

  it('notifies when source-document upload fails', async () => {
    mockedClient.post.mockRejectedValue(axiosError(503, 'Could not parse the AI response as JSON'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: /Add project doc/i });
    const sourceInput = document.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
    await user.upload(sourceInput, new File(['x'], 'projects.pdf', { type: 'application/pdf' }));
    await waitFor(() => {
      expect(notificationMessages().some((m) => /parse|JSON|upload/i.test(m))).toBe(true);
    });
  });

  it('does not crash when saved work rows include unknown keys', async () => {
    mockGets({
      ...completeProfile,
      work_experience: [
        {
          ...completeProfile.work_experience[0],
          mystery: 'nope',
          contributions: 'not-an-array' as unknown as string[],
        },
      ],
      extra: 'legacy blob' as unknown as string[],
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Your profile' })).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });
});
