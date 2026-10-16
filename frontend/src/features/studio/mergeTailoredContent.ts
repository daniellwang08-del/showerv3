import type { ResumeContent } from '@/types/resumeDesign';
import type { ResumeAiTailoredContent } from '@/api/resumeAiChatApi';

/** Merge OneClick tailored sections onto the open studio content (keep header/edu/certs). */
export function mergeTailoredContent(
  base: ResumeContent,
  tailored: ResumeAiTailoredContent | null | undefined,
): ResumeContent {
  if (!tailored) return base;

  const skills = (tailored.technical_skills || [])
    .map((s) => ({
      category: String(s.category || '').trim(),
      skills: String(s.skills || '').trim(),
    }))
    .filter((s) => s.category && s.skills);

  const experience = (tailored.work_experience || [])
    .map((w) => ({
      company_name: String(w.company_name || ''),
      job_title: String(w.job_title || ''),
      period_start: String(w.period_start || ''),
      period_end: String(w.period_end || ''),
      location: String(w.location || ''),
      job_type: String(w.job_type || ''),
      employment_type: String(w.employment_type || ''),
      project_title: String(w.project_title || ''),
      project_intro: String(w.project_intro || ''),
      contributions: Array.isArray(w.contributions)
        ? w.contributions.map((c) => String(c || '').trim()).filter(Boolean)
        : [],
      used_skills: String(w.used_skills || ''),
      description: String(w.description || ''),
    }))
    .filter((w) => w.company_name && w.job_title);

  const summary = String(tailored.profile_summary || '').trim();

  return {
    ...base,
    profile_summary: summary || base.profile_summary,
    technical_skills: skills.length ? skills : base.technical_skills,
    work_experience: experience.length ? experience : base.work_experience,
  };
}
