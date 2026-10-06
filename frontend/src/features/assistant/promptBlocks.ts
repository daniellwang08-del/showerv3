import {
  BarChart3,
  Blocks,
  Briefcase,
  CheckCircle2,
  FileText,
  Mails,
  type LucideIcon,
} from 'lucide-react';
import type { AgentToolInfo, ConfirmedAction } from '@/api/agentApi';

/**
 * A prompt block pins a task to the composer, like a ChatGPT plugin: the user
 * picks it, types or pastes their request, and the turn is handled by that
 * tool instead of relying on the planner to guess the intent. `tool` runs the
 * tool directly; `selectedTool` asks the planner to act with that tool and
 * fill its arguments from the message.
 */
export type PromptBlock = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  placeholder: string;
  /** First line of the sent message, so the saved chat reads naturally. Empty sends the draft as is. */
  lead: string;
  /** Shortest draft worth sending (tailoring needs a full posting). */
  minChars: number;
  tool?: ConfirmedAction;
  selectedTool?: string;
};

export const PROMPT_BLOCKS: PromptBlock[] = [
  {
    id: 'tailor-resume',
    label: 'Tailor resume',
    description: 'Paste a job description and get a tailored resume saved to Documents.',
    icon: FileText,
    placeholder: 'Paste the full job description…',
    lead: 'Tailor my resume to this job description.',
    minChars: 200,
    tool: { tool: 'tailor_resume', args: { include_cover_letter: false } },
  },
  {
    id: 'tailor-resume-cover-letter',
    label: 'Resume + cover letter',
    description: 'Tailor your resume and write a matching cover letter for a pasted job description.',
    icon: Mails,
    placeholder: 'Paste the full job description…',
    lead: 'Tailor my resume and write a cover letter for this job description.',
    minChars: 200,
    tool: { tool: 'tailor_resume', args: { include_cover_letter: true } },
  },
];

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Jobs: Briefcase,
  Insights: BarChart3,
  Applications: CheckCircle2,
};

export function categoryIcon(category: string): LucideIcon {
  return CATEGORY_ICONS[category] ?? Blocks;
}

/** A block for any assistant tool from GET /agent/tools. */
export function toolBlock(t: AgentToolInfo): PromptBlock {
  return {
    id: `tool-${t.name}`,
    label: t.label,
    description: t.description,
    icon: categoryIcon(t.category),
    placeholder: t.example ? `For example: ${t.example}` : `Ask with ${t.label}…`,
    lead: '',
    minChars: 1,
    selectedTool: t.name,
  };
}

export function composeBlockMessage(block: PromptBlock, text: string): string {
  return block.lead ? `${block.lead}\n\n${text.trim()}` : text.trim();
}
