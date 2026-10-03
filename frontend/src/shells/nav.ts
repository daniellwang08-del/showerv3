import {
  BarChart3,
  Briefcase,
  Cpu,
  Database,
  FileText,
  Home,
  LayoutTemplate,
  Puzzle,
  ScrollText,
  SlidersHorizontal,
  UserCircle,
  Users,
  type LucideIcon,
} from 'lucide-react';

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Exact match for index routes so `/app` is not active on every child. */
  end?: boolean;
  keywords?: string[];
};

export type NavSection = { label?: string; items: NavItem[] };

export const applicantNav: NavSection[] = [
  {
    items: [
      { to: '/app', label: 'Home', icon: Home, end: true, keywords: ['start', 'composer'] },
      { to: '/app/jobs', label: 'Jobs', icon: Briefcase, keywords: ['dashboard', 'list', 'scraper'] },
      { to: '/app/analysis', label: 'Insights', icon: BarChart3, keywords: ['analysis', 'pipeline', 'trends'] },
      { to: '/app/documents', label: 'Documents', icon: FileText, keywords: ['resume', 'cover letter', 'tailor', 'downloads'] },
      { to: '/app/studio', label: 'Resume studio', icon: LayoutTemplate, keywords: ['builder', 'template', 'design', 'theme'] },
    ],
  },
  {
    label: 'You',
    items: [
      { to: '/app/profile', label: 'Profile', icon: UserCircle, keywords: ['resume data', 'experience'] },
      { to: '/app/preferences', label: 'Preferences', icon: SlidersHorizontal, keywords: ['settings', 'filters'] },
      { to: '/app/integrations', label: 'Integrations', icon: Puzzle, keywords: ['sheets', 'pumble', 'job sites'] },
    ],
  },
];

export const adminNav: NavSection[] = [
  {
    items: [
      { to: '/admin', label: 'Jobs pipeline', icon: Briefcase, end: true, keywords: ['scraper', 'extraction', 'sync'] },
      { to: '/admin/data', label: 'Data', icon: Database, keywords: ['analysis', 'management', 'cleanup'] },
      { to: '/admin/users', label: 'Users', icon: Users, keywords: ['accounts', 'team'] },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/settings', label: 'Settings', icon: Cpu, keywords: ['llm', 'workers', 'queues', 'keys'] },
      { to: '/admin/logs', label: 'Logs', icon: ScrollText, keywords: ['errors', 'events'] },
    ],
  },
];

/** Old flat routes → new role-scoped routes. */
export const legacyRedirects: Record<string, { applicant: string; admin: string }> = {
  '/scraper': { applicant: '/app/jobs', admin: '/admin' },
  '/job-analysis': { applicant: '/app/analysis', admin: '/admin' },
  '/profile': { applicant: '/app/profile', admin: '/admin' },
  '/preferences': { applicant: '/app/preferences', admin: '/admin' },
  '/settings': { applicant: '/app/preferences', admin: '/admin/settings' },
  '/integrations': { applicant: '/app/integrations', admin: '/admin' },
  '/billing': { applicant: '/app/billing', admin: '/admin' },
  '/resume-builder': { applicant: '/app/studio', admin: '/admin' },
  '/data-analysis': { applicant: '/app', admin: '/admin/data' },
  '/data-management': { applicant: '/app', admin: '/admin/data' },
  '/user-management': { applicant: '/app', admin: '/admin/users' },
  '/system-settings': { applicant: '/app', admin: '/admin/settings' },
  '/system-logs': { applicant: '/app', admin: '/admin/logs' },
};
