import type { LucideIcon } from 'lucide-react';
import {
  Check,
  ClipboardCheck,
  ClipboardX,
  Copy,
  ExternalLink,
  MessageSquare,
  PanelRightOpen,
  RefreshCw,
  Rocket,
  Sheet,
  Trash2,
} from 'lucide-react';
import type { DashboardJob } from '@/types/scraper';
import { isApplied, isApplyReady } from './jobStatus';

export type JobActionId =
  | 'apply'
  | 'open'
  | 'open-url'
  | 'copy-url'
  | 'mark-applied'
  | 'unmark-applied'
  | 'post-sheet'
  | 'post-pumble'
  | 'prepare'
  | 'delete';

export interface JobMenuItem {
  id: JobActionId;
  label: string;
  icon: LucideIcon;
  /** Jobs the action applies to (may be a subset of the selection). */
  targets: DashboardJob[];
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: string;
}

export type JobMenuEntry = JobMenuItem | 'separator';

export interface JobMenuContext {
  sheetsConfigured: boolean;
  pumbleConfigured: boolean;
  postingToSheet?: boolean;
  postingToPumble?: boolean;
}

function isRunning(job: DashboardJob): boolean {
  return (
    job.match_overall_score == null &&
    (job.extraction_status === 'pending' || job.extraction_status === 'processing' || job.match_in_progress)
  );
}

export interface InlineAction {
  id: JobActionId;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  destructive?: boolean;
  /** Toggle actions (applied, posted) render highlighted while on. */
  active?: boolean;
}

export type InlineDensity = 'full' | 'medium' | 'compact';

/** Row actions shown as icon buttons on the table; the rest stay in the "…" menu. */
export function inlineJobActions(job: DashboardJob, ctx: JobMenuContext, density: InlineDensity): InlineAction[] {
  const applied = isApplied(job);
  const appliedToggle: InlineAction = {
    id: applied ? 'unmark-applied' : 'mark-applied',
    label: applied ? 'Applied, click to unmark' : 'Mark as applied',
    icon: Check,
    active: applied,
  };
  if (density === 'compact') return [appliedToggle];
  const openPosting: InlineAction = { id: 'open-url', label: 'Open posting', icon: ExternalLink, disabled: !job.source_url };
  if (density === 'medium') return [appliedToggle, openPosting];

  const ready = isApplyReady(job);
  const actions: InlineAction[] = [
    {
      id: 'apply',
      label: ready ? 'Apply with Assistant' : 'Apply with Assistant (needs a match score and documents)',
      icon: Rocket,
      disabled: !ready,
    },
    appliedToggle,
  ];
  if (ctx.sheetsConfigured) {
    actions.push({
      id: 'post-sheet',
      label: job.sheet_posted_at ? 'Posted to Google Sheet' : 'Post to Google Sheet',
      icon: Sheet,
      active: Boolean(job.sheet_posted_at),
      disabled: ctx.postingToSheet,
    });
  }
  if (ctx.pumbleConfigured) {
    actions.push({
      id: 'post-pumble',
      label: job.pumble_posted_at ? 'Posted to Pumble' : 'Post to Pumble',
      icon: MessageSquare,
      active: Boolean(job.pumble_posted_at),
      disabled: ctx.postingToPumble,
    });
  }
  actions.push(
    openPosting,
    { id: 'copy-url', label: 'Copy link', icon: Copy, disabled: !job.source_url },
    {
      id: 'prepare',
      label: job.extraction_id ? 'Re-analyze with saved JD' : 'Extract and analyze',
      icon: RefreshCw,
      disabled: isRunning(job),
    },
    { id: 'delete', label: 'Delete', icon: Trash2, destructive: true },
  );
  return actions;
}

/** Grid width for the actions column: 1.75rem buttons, 0.125rem gaps, cell padding. */
export function inlineActionsWidth(count: number): string {
  const rem = count * 1.75 + Math.max(0, count - 1) * 0.125 + 1.75;
  return `${rem}rem`;
}

/** Menu shared by the row "…" dropdown, the right-click menu, and the bulk bar. */
export function buildJobMenu(targets: DashboardJob[], ctx: JobMenuContext): JobMenuEntry[] {
  if (targets.length === 0) return [];
  const multi = targets.length > 1;
  const job = targets[0];
  const unapplied = targets.filter((t) => !isApplied(t));
  const applied = targets.filter((t) => isApplied(t));
  const entries: JobMenuEntry[] = [];

  if (!multi) {
    if (isApplyReady(job)) {
      entries.push({ id: 'apply', label: 'Apply with Assistant', icon: Rocket, targets });
    }
    entries.push({ id: 'open', label: 'Open details', icon: PanelRightOpen, targets, shortcut: '↵' });
  }
  entries.push({
    id: 'open-url',
    label: multi ? `Open ${targets.length} postings` : 'Open posting',
    icon: ExternalLink,
    targets,
  });
  if (!multi) entries.push({ id: 'copy-url', label: 'Copy link', icon: Copy, targets });

  entries.push('separator');
  if (unapplied.length > 0) {
    entries.push({
      id: 'mark-applied',
      label: multi ? `Mark applied (${unapplied.length})` : 'Mark as applied',
      icon: ClipboardCheck,
      targets: unapplied,
    });
  }
  if (applied.length > 0) {
    entries.push({
      id: 'unmark-applied',
      label: multi ? `Unmark applied (${applied.length})` : 'Unmark applied',
      icon: ClipboardX,
      targets: applied,
    });
  }

  if (ctx.sheetsConfigured || ctx.pumbleConfigured) entries.push('separator');
  if (ctx.sheetsConfigured) {
    entries.push({
      id: 'post-sheet',
      label: multi ? `Post ${targets.length} to Google Sheet` : 'Post to Google Sheet',
      icon: Sheet,
      targets,
      disabled: ctx.postingToSheet,
    });
  }
  if (ctx.pumbleConfigured) {
    entries.push({
      id: 'post-pumble',
      label: multi ? `Post ${targets.length} to Pumble` : 'Post to Pumble',
      icon: MessageSquare,
      targets,
      disabled: ctx.postingToPumble,
    });
  }

  entries.push('separator');
  entries.push({
    id: 'prepare',
    label: multi
      ? `Prepare ${targets.length} jobs`
      : job.extraction_id
        ? 'Re-analyze with saved JD'
        : 'Extract and analyze',
    icon: RefreshCw,
    targets,
    disabled: !multi && isRunning(job),
  });
  entries.push('separator');
  entries.push({
    id: 'delete',
    label: multi ? `Delete ${targets.length} jobs` : 'Delete',
    icon: Trash2,
    targets,
    destructive: true,
    shortcut: multi ? undefined : '⌫',
  });
  return entries;
}
