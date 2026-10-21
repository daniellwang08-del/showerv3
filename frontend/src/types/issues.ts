export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type IssueCategory = 'bug' | 'autofill' | 'jobs' | 'resume' | 'account' | 'other';

export interface IssueAttachment {
  id: string;
  kind: 'image' | 'file';
  filename: string;
  content_type: string;
  byte_size: number;
}

export interface IssuePerson {
  id: string;
  name: string;
  email: string;
}

export interface IssueReport {
  id: string;
  number: number;
  category: IssueCategory | string;
  title: string;
  description: string;
  status: IssueStatus;
  source: string;
  page_url: string | null;
  page_title: string | null;
  attachments: IssueAttachment[];
  created_at: string;
  updated_at: string;
  status_changed_at: string | null;
  context: Record<string, string | number | boolean | null>;
  admin_note: string | null;
  reporter: IssuePerson | null;
  status_changed_by: IssuePerson | null;
}

export interface IssuePage {
  total: number;
  counts: Record<IssueStatus, number>;
  items: IssueReport[];
}
