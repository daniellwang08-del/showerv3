export type ResumeTemplateStatus = 'missing' | 'processing' | 'ready' | 'stale' | 'failed';
export type DetectedTemplateType = 'dynamic' | 'legacy_exp_n' | 'unknown';

export interface FieldBinding {
  tag: string;
  path: string;
  label?: string | null;
}

export interface RepeatBlock {
  loop_open_tag: string;
  loop_close_tag: string;
  start_index: number;
  end_index: number;
  item_bindings: FieldBinding[];
}

export interface ResumeSection {
  id: string;
  label: string;
  type: 'static' | 'scalar' | 'repeat' | 'optional';
  start_index?: number;
  end_index?: number;
  optional?: boolean;
  bindings: FieldBinding[];
  repeat?: RepeatBlock | null;
}

export interface ResumeTemplateBlueprint {
  version?: number;
  engine: 'blueprint' | 'legacy_exp_n';
  sections: ResumeSection[];
  working_block?: RepeatBlock | null;
  detected_tags: string[];
  warnings: string[];
}

export interface TemplatePlaceholderSpec {
  tag: string;
  label: string;
  required: boolean;
  description: string;
  repeatable?: boolean;
}

export interface TemplateFormatSpec {
  extension: string;
  mime_type: string;
  max_bytes: number;
  notes: string;
}

export interface TemplateTypeSpec {
  id: string;
  label: string;
  engine: 'blueprint' | 'legacy_exp_n';
  recommended: boolean;
  description: string;
  required_placeholders: TemplatePlaceholderSpec[];
  optional_placeholders: TemplatePlaceholderSpec[];
  example_snippet: string;
}

export interface ResumeStyleSection {
  id: string;
  heading: string;
  description: string;
  layout_example: string;
  placeholders: TemplatePlaceholderSpec[];
  required: boolean;
  applies_to_profile: boolean;
}

export interface ResumeTemplateRequirements {
  file_format: TemplateFormatSpec;
  resume_style_title: string;
  resume_style_intro: string;
  resume_style_sections: ResumeStyleSection[];
  template_types: TemplateTypeSpec[];
  validation_notes: string[];
  profile_work_count: number;
}

export interface ResumeTemplateAiValidation {
  passed: boolean;
  template_type: DetectedTemplateType;
  summary: string;
  errors: string[];
  warnings: string[];
  suggestions: string[];
  detected_required_tags: string[];
  missing_required_tags: string[];
  validated_at?: string | null;
}

export interface ResumeTemplateStatusPayload {
  resume_template_status: ResumeTemplateStatus;
  resume_template_source_filename?: string | null;
  resume_template_error?: string | null;
  resume_template_profile_work_count?: number | null;
  resume_template_analyzed_at?: string | null;
  resume_template_ready: boolean;
  sections: ResumeSection[];
  detected_tags: string[];
  warnings: string[];
  profile_work_count: number;
  validation_errors: string[];
  detected_template_type?: DetectedTemplateType | null;
  ai_validation?: ResumeTemplateAiValidation | null;
  requirements?: ResumeTemplateRequirements | null;
}

export interface TemplateVariableDefinition {
  tag: string;
  path: string;
  label: string;
  group: string;
  description: string;
  repeatable?: boolean;
}
