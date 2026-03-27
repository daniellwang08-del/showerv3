/** Top-level authenticated shell: job dashboard vs profile editor. */
export type MainView = 'dashboard' | 'profiles';

/** Hash paths that open the profile page (first segment, case-insensitive). */
const PROFILE_SEGMENTS = new Set(['profile', 'profiles']);

function firstHashSegment(): string | undefined {
  const raw = window.location.hash.replace(/^#/, '').trim();
  const path = raw.startsWith('/') ? raw.slice(1) : raw;
  return path
    .toLowerCase()
    .split('/')
    .filter(Boolean)[0];
}

export function mainViewFromHash(): MainView {
  const seg = firstHashSegment();
  if (seg && PROFILE_SEGMENTS.has(seg)) return 'profiles';
  return 'dashboard';
}

export function hashForMainView(view: MainView): string {
  return view === 'profiles' ? '#/profile' : '#/';
}

export function navigateMainView(view: MainView): void {
  const next = hashForMainView(view);
  if (window.location.hash !== next) {
    window.location.hash = next;
  }
}
