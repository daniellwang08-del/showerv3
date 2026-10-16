import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StudioAiChat, StudioAiChatToggle } from './StudioAiChat';

const api = vi.hoisted(() => ({
  fetchResumeAiChatContext: vi.fn(),
  streamResumeAiChat: vi.fn(),
  clearResumeAiChat: vi.fn(),
  saveLibraryCoverLetter: vi.fn(),
}));

const store = vi.hoisted(() => ({
  design: {
    theme_id: 'classic',
    content: {
      name_first: 'Ada',
      name_middle: '',
      name_last: 'Lovelace',
      title: 'Engineer',
      email: 'ada@example.com',
      phone_country_code: '',
      phone_number: '',
      location: 'London',
      linkedin_url: '',
      github_url: '',
      profile_summary: 'Old summary',
      technical_skills: [{ category: 'Languages', skills: 'Python' }],
      work_experience: [],
      education: [],
      certificates: [],
    },
  },
  profile: { user_id: 'u1', name: 'Ada Lovelace', technical_skills: [], work_experience: [] },
  setContent: vi.fn(),
  setPanelTab: vi.fn(),
}));

vi.mock('@/api/resumeAiChatApi', () => ({
  fetchResumeAiChatContext: api.fetchResumeAiChatContext,
  streamResumeAiChat: api.streamResumeAiChat,
  clearResumeAiChat: api.clearResumeAiChat,
}));
vi.mock('@/api/documentsApi', () => ({
  saveLibraryCoverLetter: api.saveLibraryCoverLetter,
}));
vi.mock('@/stores/resumeBuilderStore', () => ({
  useResumeBuilderStore: (sel?: (s: typeof store) => unknown) => (sel ? sel(store) : store),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('StudioAiChat', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    store.setContent.mockReset();
    store.setPanelTab.mockReset();
    api.fetchResumeAiChatContext.mockResolvedValue({
      resume_id: 'r1',
      name: 'Acme resume',
      source: 'tailored',
      origin: 'documents',
      job_description: 'Build APIs with Python',
      job_title: 'Backend Engineer',
      company: 'Acme',
      match_score: 72,
      content: store.design.content,
      messages: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier reply' }],
      last_job_description: 'Build APIs with Python',
    });
    api.streamResumeAiChat.mockResolvedValue({
      reply: 'Updated your resume for Acme.',
      intent: 'tailor',
      action: 'tailored',
      job_description: 'Build APIs with Python',
      job_title: 'Backend Engineer',
      company: 'Acme',
      content: {
        profile_summary: 'Backend engineer focused on APIs',
        technical_skills: [{ category: 'Backend', skills: 'Python, FastAPI' }],
        work_experience: [],
      },
      cover_letter: 'Dear Acme…',
      match: { overall_score: 80, recommendation: '', summary: 'Strong fit', strengths: [], gaps: [], dimension_scores: {} },
    });
    api.saveLibraryCoverLetter.mockResolvedValue(undefined);
  });

  it('toggles the left-edge button pressed state', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(<StudioAiChatToggle open={false} onToggle={onToggle} />);
    const btn = screen.getByRole('button', { name: 'Open resume AI' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await user.click(btn);
    expect(onToggle).toHaveBeenCalled();
    rerender(<StudioAiChatToggle open onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'Close resume AI' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('loads job context and history when opened', async () => {
    render(<StudioAiChat open resumeId="r1" onClose={vi.fn()} />);
    expect(await screen.findByText('Earlier question')).toBeInTheDocument();
    expect(screen.getByText('Earlier reply')).toBeInTheDocument();
    expect(api.fetchResumeAiChatContext).toHaveBeenCalledWith('r1');
  });

  it('streams a tailor turn, applies content, and saves cover letter', async () => {
    const user = userEvent.setup();
    const onCover = vi.fn();
    render(<StudioAiChat open resumeId="r1" onClose={vi.fn()} onCoverLetter={onCover} />);
    await screen.findByText('Earlier question');

    await user.type(screen.getByRole('textbox'), 'Tailor this resume to the job');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.streamResumeAiChat).toHaveBeenCalled());
    expect(api.streamResumeAiChat.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        resume_id: 'r1',
        last_job_description: 'Build APIs with Python',
      }),
    );
    await waitFor(() => expect(store.setContent).toHaveBeenCalled());
    expect(store.setContent.mock.calls[0][0].profile_summary).toBe('Backend engineer focused on APIs');
    expect(store.setPanelTab).toHaveBeenCalledWith('content');
    expect(onCover).toHaveBeenCalledWith('Dear Acme…');
    expect(api.saveLibraryCoverLetter).toHaveBeenCalledWith('r1', 'Dear Acme…');
    expect(await screen.findByText('Updated your resume for Acme.')).toBeInTheDocument();
  });
});
