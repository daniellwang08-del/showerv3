import type { IssueCategory, IssueStatus } from '@/types/issues';

export const ISSUES_KEY = ['admin', 'issues'] as const;
export const PAGE_SIZE = 50;

export const STATUS_ORDER: IssueStatus[] = ['open', 'in_progress', 'resolved', 'closed'];

export const STATUS_META: Record<IssueStatus, { label: string; dot: string; chip: string }> = {
  open: { label: 'Open', dot: 'bg-brand', chip: 'border-brand/30 bg-brand-soft text-brand' },
  in_progress: {
    label: 'In progress',
    dot: 'bg-status-preparing',
    chip: 'border-status-preparing/30 bg-status-preparing/10 text-status-preparing',
  },
  resolved: {
    label: 'Resolved',
    dot: 'bg-status-ready',
    chip: 'border-status-ready/30 bg-status-ready/10 text-status-ready',
  },
  closed: { label: 'Closed', dot: 'bg-muted-foreground/50', chip: 'border-border bg-muted text-muted-foreground' },
};

export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  bug: 'Something is broken',
  autofill: 'Autofill or applying',
  jobs: 'Jobs and matching',
  resume: 'Resume or cover letter',
  account: 'Account, credits, or billing',
  other: 'Something else',
};

export function categoryLabel(value: string): string {
  return CATEGORY_LABEL[value as IssueCategory] ?? value;
}

/** Diagnostics the extension sends, in the order an admin reads them. */
export const CONTEXT_LABELS: Array<[string, string]> = [
  ['extension_version', 'Extension version'],
  ['panel_view', 'Panel screen'],
  ['job_title', 'Job'],
  ['company', 'Company'],
  ['job_id', 'Job ID'],
  ['user_agent', 'Browser'],
  ['language', 'Language'],
  ['screen', 'Screen'],
  ['server', 'Server'],
];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
