export type OnboardingStatus = 'active' | 'done' | 'skipped';

export type OnboardingState = {
  status: OnboardingStatus;
  step: number;
};

export const ONBOARDING_STEPS = ['resume', 'essentials', 'preferences', 'jobs'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const key = (userId: string) => `nao.onboarding.v1.${userId}`;

export function readOnboarding(userId: string | undefined): OnboardingState | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    const step = Math.min(Math.max(Number(parsed.step) || 0, 0), ONBOARDING_STEPS.length - 1);
    const status = parsed.status === 'done' || parsed.status === 'skipped' ? parsed.status : 'active';
    return { status, step };
  } catch {
    return null;
  }
}

export function writeOnboarding(userId: string | undefined, state: OnboardingState) {
  if (!userId) return;
  try {
    localStorage.setItem(key(userId), JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode); onboarding then simply restarts.
  }
}

/** New accounts without a saved profile go through onboarding once unless they finish or skip it. */
export function shouldOnboard(userId: string | undefined, hasProfile: boolean): boolean {
  if (!userId || hasProfile) return false;
  const state = readOnboarding(userId);
  return !state || state.status === 'active';
}
