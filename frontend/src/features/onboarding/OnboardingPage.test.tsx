import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeForm, completeProfile } from '@/test/profileFixtures';
import type { UserSettings } from '@/types/settings';
import { OnboardingPage } from './OnboardingPage';
import { readOnboarding, shouldOnboard, writeOnboarding } from './onboardingState';

const api = vi.hoisted(() => ({
  fetchUserProfile: vi.fn(),
  saveUserProfile: vi.fn(),
  fetchUserSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  post: vi.fn(),
  submitJobUrls: vi.fn(),
}));

vi.mock('@/api/profileApi', () => ({
  fetchUserProfile: api.fetchUserProfile,
  saveUserProfile: api.saveUserProfile,
}));
vi.mock('@/api/settingsApi', () => ({
  fetchUserSettings: api.fetchUserSettings,
  updateUserSettings: api.updateUserSettings,
}));
vi.mock('@/api/client', () => ({ apiClient: { post: api.post } }));
vi.mock('@/features/jobs/submitJobUrls', () => ({ submitJobUrls: api.submitJobUrls }));

const settings = {
  country_preferences: [],
  country_preferences_source: 'unset',
  available_countries: [
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
  ],
  job_match_preferences: '',
  job_match_preferences_max_length: 4000,
  auto_prepare_match: false,
} as unknown as UserSettings;

function renderPage(userId = 'u1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <Routes>
          <Route
            path="/onboarding"
            element={<OnboardingPage userId={userId} accountEmail="jordan@example.com" onProfileSaved={vi.fn()} />}
          />
          <Route path="/app" element={<p>home page</p>} />
          <Route path="/app/jobs" element={<p>jobs page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.fetchUserProfile.mockResolvedValue(null);
  api.fetchUserSettings.mockResolvedValue(settings);
});

describe('onboardingState', () => {
  it('onboards only accounts without a profile until finished or skipped', () => {
    expect(shouldOnboard('u1', false)).toBe(true);
    expect(shouldOnboard('u1', true)).toBe(false);
    writeOnboarding('u1', { status: 'skipped', step: 1 });
    expect(shouldOnboard('u1', false)).toBe(false);
    expect(readOnboarding('u1')).toEqual({ status: 'skipped', step: 1 });
  });
});

describe('OnboardingPage', () => {
  it('imports a résumé and pre-fills the essentials', async () => {
    api.post.mockResolvedValue({
      data: {
        draft: { name_first: 'Jordan', name_last: 'Preview', title: 'Backend Engineer', work_experience: [{ company_name: 'Acme', job_title: 'Engineer' }] },
        warnings: [],
      },
    });
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText('Résumé file');
    await user.upload(input, new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }));

    expect(await screen.findByRole('heading', { name: 'Confirm the essentials' })).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/profile/resume-parse', expect.any(FormData));
    expect(screen.getByLabelText('First name')).toHaveValue('Jordan');
    expect(screen.getByLabelText('Email')).toHaveValue('jordan@example.com');
    expect(screen.getByText(/We also found 1 role\./)).toBeInTheDocument();
    expect(readOnboarding('u1')?.step).toBe(1);
  });

  it('rejects unsupported résumé files without calling the parser', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    await user.upload(await screen.findByLabelText('Résumé file'), new File(['x'], 'cv.txt', { type: 'text/plain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF or DOCX');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('validates essentials, saves the profile, preferences, and first jobs', async () => {
    api.saveUserProfile.mockResolvedValue(completeProfile);
    api.updateUserSettings.mockResolvedValue({ ...settings, country_preferences: ['CA'] });
    api.submitJobUrls.mockResolvedValue(true);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /fill it in myself/i }));
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('First name is required')).toBeInTheDocument();
    expect(api.saveUserProfile).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('First name'), 'Jordan');
    await user.type(screen.getByLabelText('Last name'), 'Preview');
    await user.type(screen.getByLabelText('Professional title'), 'Engineer');
    await user.type(screen.getByLabelText('Phone'), '6102347936');
    await user.type(screen.getByLabelText('LinkedIn profile URL'), 'https://linkedin.com/in/jordan');
    await user.type(screen.getByLabelText('Professional summary'), 'Builds backend systems.');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => expect(api.saveUserProfile).toHaveBeenCalled());
    expect(api.saveUserProfile.mock.calls[0][0]).toMatchObject({
      name_first: 'Jordan',
      email: 'jordan@example.com',
      phone_country_code: '+1',
      linkedin_url: 'https://linkedin.com/in/jordan',
    });

    expect(await screen.findByRole('heading', { name: 'What are you looking for?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remote only' }));
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('radio', { name: 'Tailored resume per job' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'My original resume' }));
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() =>
      expect(api.updateUserSettings).toHaveBeenCalledWith({
        country_preferences: [],
        job_match_preferences: 'Remote only',
        auto_prepare_match: true,
        application_resume_source: 'original',
      }),
    );

    expect(await screen.findByRole('heading', { name: 'Add your first jobs' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Job links'), 'https://jobs.lever.co/acme/1 https://jobs.lever.co/acme/2');
    await user.click(screen.getByRole('button', { name: 'Add 2 jobs' }));
    expect(await screen.findByText('jobs page')).toBeInTheDocument();
    expect(readOnboarding('u1')?.status).toBe('done');
  });

  it('keeps Save and continue visible when the professional summary is long', async () => {
    writeOnboarding('u1', { status: 'active', step: 1 });
    sessionStorage.setItem(
      'nao.onboarding.form.v1.u1',
      JSON.stringify(completeForm({ profile_summary: 'Builds backend systems. '.repeat(80) })),
    );
    renderPage();

    const save = await screen.findByRole('button', { name: 'Save and continue' });
    expect(save).toBeVisible();
    expect(screen.getByLabelText('Professional summary')).toHaveClass('max-h-48', 'field-sizing-fixed');
    expect(save.closest('[data-slot="onboarding-step-actions"]')).toHaveClass(
      'pb-[max(1.5rem,calc(env(safe-area-inset-bottom,0px)+1.25rem))]',
    );
  });

  it('resumes at the saved step and can be skipped', async () => {
    writeOnboarding('u1', { status: 'active', step: 3 });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Add your first jobs' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText('home page')).toBeInTheDocument();
    expect(readOnboarding('u1')?.status).toBe('skipped');
  });
});
