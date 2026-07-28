export type AutoPostWorkMode = 'remote' | 'hybrid' | 'onsite';

export interface AutoPostFilters {
  /** Empty = any work mode. Non-empty = job must resolve to one of these. */
  work_modes: AutoPostWorkMode[];
  /** Block-list (e.g. prior employers). Match = case-insensitive substring. */
  exclude_companies: string[];
}

export const DEFAULT_AUTO_POST_FILTERS: AutoPostFilters = {
  work_modes: [],
  exclude_companies: [],
};

export const AUTO_POST_WORK_MODE_OPTIONS: { value: AutoPostWorkMode; label: string }[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'Onsite' },
];

const KNOWN_MODES = new Set<string>(['remote', 'hybrid', 'onsite']);

function cleanStringList(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.trim()) {
    raw = raw.split(',').map((s) => s.trim());
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const name = String(item || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function cleanWorkModes(raw: unknown): AutoPostWorkMode[] {
  if (typeof raw === 'string' && raw.trim()) raw = [raw];
  if (!Array.isArray(raw)) return [];
  const out: AutoPostWorkMode[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let mode = String(item || '').trim().toLowerCase();
    if (mode === 'on-site') mode = 'onsite';
    if (!KNOWN_MODES.has(mode) || seen.has(mode)) continue;
    seen.add(mode);
    out.push(mode as AutoPostWorkMode);
  }
  return out;
}

/** Coerce API/persisted payload (including legacy keys) into current shape. */
export function normalizeAutoPostFilters(
  raw?: Partial<AutoPostFilters> | Record<string, unknown> | null,
): AutoPostFilters {
  if (!raw || typeof raw !== 'object') {
    return { work_modes: [], exclude_companies: [] };
  }

  const rec = raw as Record<string, unknown>;

  let work_modes = cleanWorkModes(rec.work_modes);
  if (work_modes.length === 0 && Boolean(rec.remote_only)) {
    work_modes = ['remote'];
  }

  const exclude_companies = cleanStringList(
    rec.exclude_companies ?? rec.companies_exclude,
  );

  return { work_modes, exclude_companies };
}

export function autoPostFiltersEqual(a: AutoPostFilters, b: AutoPostFilters): boolean {
  if (a.work_modes.length !== b.work_modes.length) return false;
  if (a.exclude_companies.length !== b.exclude_companies.length) return false;
  const modesA = [...a.work_modes].sort();
  const modesB = [...b.work_modes].sort();
  if (!modesA.every((v, i) => v === modesB[i])) return false;
  const exA = a.exclude_companies.map((c) => c.toLowerCase()).sort();
  const exB = b.exclude_companies.map((c) => c.toLowerCase()).sort();
  return exA.every((v, i) => v === exB[i]);
}
