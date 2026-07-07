import type { ResumeContent } from './resumeDesign';

export interface ResumeAiMatch {
  overall_score: number;
  recommendation: string;
  summary: string;
  strengths: string[];
  gaps: string[];
  dimension_scores: Record<string, number>;
}

/** Tailored sections only. The header/education/certificates are merged from the
 *  profile on the client so they are never lost. Field shapes mirror ResumeContent. */
export interface ResumeAiTailoredContent {
  profile_summary: string;
  technical_skills: ResumeContent['technical_skills'];
  work_experience: ResumeContent['work_experience'];
}

export type ResumeAiAction = 'tailored' | 'analyzed' | 'none';

export interface ResumeAiChatRequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ResumeAiChatResponse {
  reply: string;
  intent: string;
  action: ResumeAiAction;
  job_description?: string | null;
  job_title?: string | null;
  company?: string | null;
  content?: ResumeAiTailoredContent | null;
  cover_letter?: string | null;
  match?: ResumeAiMatch | null;
}
