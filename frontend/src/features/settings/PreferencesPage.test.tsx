import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as settingsApi from '@/api/settingsApi';
import * as profileApi from '@/api/profileApi';
import { useJobsStore } from '@/stores/jobsStore';
import { useScraperStore } from '@/stores/scraperStore';
import { completeForm } from '@/test/profileFixtures';
import type { UserSettings } from '@/types/settings';
import { PreferencesPage } from './PreferencesPage';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/api/client', () => ({
  apiClient: { post: vi.fn(async () => ({ data: {} })), get: vi.fn(async () => ({ data: {} })) },
}));
vi.mock('@/api/settingsApi', () => ({
  fetchUserSettings: vi.fn(),
  updateUserSettings: vi.fn(),
  saveCountryPreferences: vi.fn(),
  saveJobMatchPreferences: vi.fn(),
  saveMinMatchScoreSettings: vi.fn(),
  saveDedupSettings: vi.fn(),
  saveAutoPrepareSettings: vi.fn(),
  saveManualSubmitPipelineSettings: vi.fn(),
  saveApplicationResumeSource: vi.fn(),
  saveMatchQualityCheckSettings: vi.fn(),
  saveJobShareDefaultSettings: vi.fn(),
  saveResumeTailoringPromptSettings: vi.fn(),
  saveCoverLetterPromptSettings: vi.fn(),
  saveOpenAiSettings: vi.fn(),
  saveProviderKeySettings: vi.fn(),
  testOpenAiKey: vi.fn(),
  testProviderKey: vi.fn(),
  previewMinMatchScore: vi.fn(),
  applyMinMatchScore: vi.fn(),
  previewDedupRules: vi.fn(),
  applyDedupRules: vi.fn(),
  fetchCoverLetterPromptDefaults: vi.fn(async () => ({ default_instructions: '', max_length: 12000, min_length: 50 })),
}));
vi.mock('@/api/profileApi', () => ({
  fetchProfileForm: vi.fn(),
  saveAddressPreferences: vi.fn(async () => ({})),
  saveEeoPreferences: vi.fn(async () => ({})),
}));

const api = vi.mocked(settingsApi);
const profile = vi.mocked(profileApi);

const LONG_PROMPT = 'Write a concise, achievement-focused resume tailored to the job description.';

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    openai_key_mode: 'default',
    openai_key_configured: false,
    openai_key_hint: null,
    system_openai_available: true,
    llm_provider: 'openai',
    default_llm_provider: 'openai',
    available_providers: ['openai', 'anthropic', 'gemini'],
    llm_model: null,
    default_llm_model: 'gpt',
    anthropic_key_mode: 'custom',
    anthropic_key_configured: true,
    anthropic_key_hint: 'sk-ant-…9f2c',
    system_anthropic_available: true,
    gemini_key_mode: 'default',
    gemini_key_configured: false,
    gemini_key_hint: null,
    system_gemini_available: false,
    dedup_recycle_mode: 'custom',
    dedup_recycle_days: 60,
    dedup_recycle_days_custom: 60,
    default_dedup_recycle_days: 60,
    min_match_score_mode: 'custom',
    min_match_score: 40,
    min_match_score_custom: 40,
    default_min_match_score: 0,
    dedup_applied_company_mode: 'custom',
    dedup_applied_company_enabled: false,
    dedup_applied_company_enabled_custom: false,
    default_dedup_applied_company_enabled: false,
    dedup_score_comparison_mode: 'custom',
    dedup_score_comparison_enabled: false,
    dedup_score_comparison_enabled_custom: false,
    default_dedup_score_comparison_enabled: false,
    auto_prepare_match: false,
    auto_prepare_full: false,
    manual_submit_pipeline: 'full',
    application_resume_source: 'tailored',
    match_quality_check: 'rescore',
    match_quality_check_min_score: 70,
    job_share_default: 'private',
    resume_filename_mode: 'pattern',
    resume_filename_value: '{firstname}_{lastname}_{kind}',
    resume_tailoring_prompt_mode: 'custom',
    resume_tailoring_prompt_instructions: LONG_PROMPT,
    resume_tailoring_prompt_instructions_custom: LONG_PROMPT,
    default_resume_tailoring_prompt_instructions: 'Default resume instructions that are long enough to be valid.',
    resume_tailoring_output_contract: '',
    resume_tailoring_prompt_max_length: 12000,
    cover_letter_prompt_mode: 'default',
    cover_letter_prompt_instructions: 'Default cover letter instructions that are long enough to pass.',
    cover_letter_prompt_instructions_custom: '',
    default_cover_letter_prompt_instructions: 'Default cover letter instructions that are long enough to pass.',
    cover_letter_prompt_max_length: 12000,
    job_match_preferences: '',
    job_match_preferences_max_length: 4000,
    country_preferences: ['US'],
    country_preferences_source: 'manual',
    available_countries: [
      { code: 'US', name: 'United States' },
      { code: 'CA', name: 'Canada' },
      { code: 'DE', name: 'Germany' },
    ],
    resume_template_status: 'missing',
    resume_template_source_filename: null,
    resume_template_error: null,
    resume_template_profile_work_count: null,
    resume_template_analyzed_at: null,
    resume_template_ready: false,
    cover_letter_template_status: 'missing',
    cover_letter_template_source_filename: null,
    cover_letter_template_error: null,
    cover_letter_template_analyzed_at: null,
    cover_letter_template_ready: false,
    profile_work_count: 1,
    validation_errors: [],
    ...overrides,
  };
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

let refreshLists: ReturnType<typeof vi.fn>;
let loadJobs: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchUserSettings.mockResolvedValue(makeSettings());
  profile.fetchProfileForm.mockResolvedValue(completeForm());
  refreshLists = vi.fn(async () => {});
  loadJobs = vi.fn(async () => {});
  useJobsStore.setState({ refreshLists } as never);
  useScraperStore.setState({ loadJobs } as never);
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderPage(path = '/app/preferences') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <PreferencesPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const saveBar = () => screen.getByRole('region', { name: 'Unsaved changes' });
const saveButton = () => within(saveBar()).getByRole('button', { name: /Save changes/ });

describe('PreferencesPage', () => {
  it('shows a loading state, then renders every tab', { timeout: 15000 }, async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByLabelText('Loading preferences')).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: 'Job countries' })).toBeInTheDocument();
    expect(screen.getByText('United States')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Matching' }));
    expect(screen.getByRole('region', { name: 'Minimum match score' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Duplicate handling' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Application details' }));
    expect(await screen.findByRole('region', { name: 'Address and location' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'EEO and work eligibility' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'AI & keys' }));
    const anthropic = screen.getByRole('region', { name: 'Anthropic' });
    expect(within(anthropic).getByText('Your key ••••9f2c')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'OpenAI' })).getByText('Using NAO default')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Gemini' })).getByText('Default unavailable')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Prompts/ }));
    expect(screen.getByRole('region', { name: 'Resume tailoring prompt' })).toBeInTheDocument();
    expect(screen.getByText(/Re-run jobs to regenerate documents/)).toBeInTheDocument();
  });

  it('shows an error with retry when settings fail to load', async () => {
    api.fetchUserSettings.mockRejectedValueOnce({ response: { data: { detail: 'Server down' } } });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Server down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Job countries' })).toBeInTheDocument();
  });

  it('syncs the active tab with the ?tab= search param', async () => {
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=matching');
    const matching = await screen.findByRole('tab', { name: 'Matching' });
    expect(matching).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'AI & keys' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/app/preferences?tab=ai');

    await user.click(screen.getByRole('tab', { name: 'Job search' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/app\/preferences$/);
  });

  it('saves job countries and match preferences from the Job search tab', async () => {
    api.saveCountryPreferences.mockResolvedValue(makeSettings({ country_preferences: ['CA'] }));
    api.saveJobMatchPreferences.mockResolvedValue(
      makeSettings({ country_preferences: ['CA'], job_match_preferences: 'Remote staff roles' }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Remove United States' }));
    expect(screen.getByText('No filter: worldwide')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add a country' }));
    await user.click(await screen.findByRole('option', { name: /Canada/ }));
    await user.type(screen.getByLabelText("What you're looking for"), 'Remote staff roles');

    await user.click(saveButton());
    await waitFor(() => expect(api.saveCountryPreferences).toHaveBeenCalledWith(['CA']));
    await waitFor(() =>
      expect(api.saveJobMatchPreferences).toHaveBeenCalledWith({ job_match_preferences: 'Remote staff roles' }),
    );
    await waitFor(() => expect(refreshLists).toHaveBeenCalledWith({ showLoading: false, reset: true }), {
      timeout: 2500,
    });
    expect(loadJobs).toHaveBeenCalled();
  });

  it('saves the default job-sharing choice immediately', async () => {
    api.saveJobShareDefaultSettings.mockResolvedValue(makeSettings({ job_share_default: 'ask' }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('radio', { name: 'Ask me each time' }));
    await waitFor(() =>
      expect(api.saveJobShareDefaultSettings).toHaveBeenCalledWith({ job_share_default: 'ask' }),
    );
  });

  it('keeps a tab draft when switching tabs', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText("What you're looking for"), 'Keep me');
    await user.click(screen.getByRole('tab', { name: 'Matching' }));
    expect(screen.getByRole('tab', { name: /Job search.*unsaved changes/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Job search/ }));
    expect(screen.getByLabelText("What you're looking for")).toHaveValue('Keep me');
    expect(saveBar()).toBeInTheDocument();
  });

  it('saves a custom minimum match score from the save bar', async () => {
    api.saveMinMatchScoreSettings.mockResolvedValue(makeSettings({ min_match_score_custom: 72, min_match_score: 72 }));
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=matching');
    const input = await screen.findByRole('spinbutton', { name: 'Minimum match score' });
    fireEvent.change(input, { target: { value: '72' } });
    // jsdom has no layout, so Base UI keeps the thumb visibility:hidden.
    const slider = screen.getAllByRole('slider', { hidden: true })[0];
    expect(slider).toHaveAttribute('aria-labelledby', 'min-score-label');
    expect(slider).toHaveValue('72');

    await user.click(saveButton());
    await waitFor(() =>
      expect(api.saveMinMatchScoreSettings).toHaveBeenCalledWith({ min_match_score_mode: 'custom', min_match_score: 72 }),
    );
    expect(api.saveDedupSettings).not.toHaveBeenCalled();
  });

  it('saves dedup settings with custom modes', async () => {
    api.saveDedupSettings.mockResolvedValue(makeSettings({ dedup_recycle_days: 90, dedup_applied_company_enabled: true }));
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=matching');
    await user.click(await screen.findByRole('button', { name: '90 days' }));
    await user.click(screen.getByRole('switch', { name: 'Hide applied companies' }));
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();

    await user.click(saveButton());
    await waitFor(() =>
      expect(api.saveDedupSettings).toHaveBeenCalledWith({
        dedup_recycle_mode: 'custom',
        dedup_recycle_days: 90,
        dedup_applied_company_mode: 'custom',
        dedup_applied_company_enabled: true,
        dedup_score_comparison_mode: 'custom',
        dedup_score_comparison_enabled: false,
      }),
    );
  });

  it('saves auto-prepare immediately; turning on documents turns on scoring', async () => {
    let resolve: (s: UserSettings) => void = () => {};
    api.saveAutoPrepareSettings.mockImplementation(() => new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=matching');
    await user.click(await screen.findByRole('switch', { name: 'Prepare documents automatically' }));

    expect(api.saveAutoPrepareSettings).toHaveBeenCalledWith({ auto_prepare_match: true, auto_prepare_full: true });
    expect(screen.getByRole('switch', { name: 'Score new jobs automatically' })).toBeChecked();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();

    resolve(makeSettings({ auto_prepare_match: true, auto_prepare_full: true }));
    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('saves the resume for applications and locks document prep in original mode', async () => {
    api.saveApplicationResumeSource.mockResolvedValue(
      makeSettings({ application_resume_source: 'original', auto_prepare_full: false }),
    );
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=matching');
    expect(await screen.findByRole('radio', { name: 'Tailored resume per job' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Prepare documents automatically' })).not.toHaveAttribute('data-disabled');

    await user.click(screen.getByRole('radio', { name: 'My original resume' }));
    await waitFor(() =>
      expect(api.saveApplicationResumeSource).toHaveBeenCalledWith({ application_resume_source: 'original' }),
    );
    await waitFor(() => expect(screen.getByRole('radio', { name: 'My original resume' })).toBeChecked());
    const docs = screen.getByRole('switch', { name: 'Prepare documents automatically' });
    await waitFor(() => expect(docs).toHaveAttribute('data-disabled'));
    expect(docs).not.toBeChecked();
  });

  it('saves the AI quality check mode and its auto threshold', async () => {
    api.saveMatchQualityCheckSettings.mockImplementation(async (body) => makeSettings({ ...body, match_quality_check: 'auto' }));
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=matching');
    expect(await screen.findByRole('radio', { name: 'When I re-run a job' })).toBeChecked();
    expect(screen.queryByLabelText('Check new matches scoring at least')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Also for strong new matches' }));
    await waitFor(() =>
      expect(api.saveMatchQualityCheckSettings).toHaveBeenCalledWith({ match_quality_check: 'auto' }),
    );
    const threshold = await screen.findByLabelText('Check new matches scoring at least');
    await user.clear(threshold);
    await user.type(threshold, '150{Enter}');
    await waitFor(() =>
      expect(api.saveMatchQualityCheckSettings).toHaveBeenCalledWith({ match_quality_check_min_score: 100 }),
    );
  });

  it('saves the paste-link pipeline immediately', async () => {
    api.saveManualSubmitPipelineSettings.mockResolvedValue(makeSettings({ manual_submit_pipeline: 'match' }));
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=matching');
    await user.click(await screen.findByRole('radio', { name: 'Up to analysis' }));
    await waitFor(() =>
      expect(api.saveManualSubmitPipelineSettings).toHaveBeenCalledWith({ manual_submit_pipeline: 'match' }),
    );
  });

  it('previews min-score counts and confirms before hiding jobs', async () => {
    api.previewMinMatchScore.mockResolvedValue({
      threshold: 40,
      threshold_mode: 'custom',
      analyzed_visible_count: 12,
      would_hide_count: 3,
      meeting_threshold_count: 9,
      already_hidden_count: 5,
      would_restore_count: 1,
      samples: [],
    });
    api.applyMinMatchScore.mockResolvedValue({
      success: true,
      min_match_score: 40,
      hidden: 3,
      restored: 1,
      settings: makeSettings(),
    });
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=matching');
    await user.click(await screen.findByRole('button', { name: 'Check jobs' }));
    expect(api.previewMinMatchScore).toHaveBeenCalledWith({ min_match_score_mode: 'custom', min_match_score: 40 });

    const tiles = await screen.findByLabelText('Match score preview');
    const value = (label: string) => within(tiles).getByText(label).nextElementSibling?.textContent;
    expect(value('Visible')).toBe('12');
    expect(value('Will hide')).toBe('3');
    expect(value('Hidden')).toBe('5');
    expect(value('Will restore')).toBe('1');

    await user.click(screen.getByRole('button', { name: 'Hide from dashboard' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Hide low-scoring jobs?')).toBeInTheDocument();
    expect(api.applyMinMatchScore).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Hide jobs' }));
    await waitFor(() =>
      expect(api.applyMinMatchScore).toHaveBeenCalledWith({ min_match_score_mode: 'custom', min_match_score: 40 }),
    );
    await waitFor(() => expect(refreshLists).toHaveBeenCalled());
  });

  it('requires a passing key test before saving a new custom key', async () => {
    api.testOpenAiKey.mockResolvedValue({ ok: true, message: 'Key works.' });
    api.saveOpenAiSettings.mockResolvedValue(
      makeSettings({ openai_key_mode: 'custom', openai_key_configured: true, openai_key_hint: 'sk-…abcd' }),
    );
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=ai');
    const card = await screen.findByRole('region', { name: 'OpenAI' });
    await user.click(within(within(card).getByRole('group', { name: 'OpenAI key mode' })).getByRole('button', { name: 'Custom' }));
    await user.type(within(card).getByLabelText('OpenAI API key'), 'sk-new');
    const save = within(card).getByRole('button', { name: 'Save key' });
    expect(save).toBeDisabled();

    await user.click(within(card).getByRole('button', { name: 'Test key' }));
    expect(api.testOpenAiKey).toHaveBeenCalledWith('sk-new');
    expect(await within(card).findByText('Key works.')).toBeInTheDocument();
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() =>
      expect(api.saveOpenAiSettings).toHaveBeenCalledWith({ openai_key_mode: 'custom', openai_api_key: 'sk-new' }),
    );
  });

  it('confirms before switching a configured key back to the default', async () => {
    api.saveProviderKeySettings.mockResolvedValue(
      makeSettings({ anthropic_key_mode: 'default', anthropic_key_configured: false, anthropic_key_hint: null }),
    );
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=ai');
    const card = await screen.findByRole('region', { name: 'Anthropic' });
    await user.click(within(within(card).getByRole('group', { name: 'Anthropic key mode' })).getByRole('button', { name: 'Default' }));
    await user.click(within(card).getByRole('button', { name: 'Use NAO default' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(api.saveProviderKeySettings).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    await waitFor(() =>
      expect(api.saveProviderKeySettings).toHaveBeenCalledWith('anthropic', { mode: 'default', clear: true }),
    );
  });

  it('blocks saving a prompt shorter than the minimum length', async () => {
    api.saveResumeTailoringPromptSettings.mockResolvedValue(makeSettings());
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=prompts');
    const editor = await screen.findByLabelText('Resume tailoring prompt instructions');
    fireEvent.change(editor, { target: { value: 'too short' } });

    expect(screen.getByText('Must be 50–12,000 characters.')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.change(editor, { target: { value: `${LONG_PROMPT} Keep it to one page.` } });
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());
    await waitFor(() =>
      expect(api.saveResumeTailoringPromptSettings).toHaveBeenCalledWith({
        resume_tailoring_prompt_mode: 'custom',
        resume_tailoring_prompt_custom: `${LONG_PROMPT} Keep it to one page.`,
      }),
    );
  });

  it('saves address and EEO answers together from Application details', async () => {
    const user = userEvent.setup();
    renderPage('/app/preferences?tab=application');
    await user.type(await screen.findByLabelText('City'), 'Austin');
    await user.type(screen.getByLabelText('Local preferences'), 'Remote US{Enter}');
    expect(screen.getByRole('button', { name: 'Remove Remote US' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Local preferences'), 'remote us{Enter}');
    expect(screen.getByText('That location is already in your list.')).toBeInTheDocument();

    await user.click(within(screen.getByRole('group', { name: 'Protected veteran' })).getByRole('button', { name: 'I am a veteran' }));

    await user.click(saveButton());
    await waitFor(() =>
      expect(profile.saveAddressPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ city: 'Austin', local_preferences: ['Remote US'] }),
      ),
    );
    expect(profile.saveEeoPreferences).toHaveBeenCalledWith(expect.objectContaining({ veteran_status: true }));
    await waitFor(() => expect(profile.fetchProfileForm).toHaveBeenCalledTimes(2));
  });
});
