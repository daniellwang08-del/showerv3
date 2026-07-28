import type { ReactElement } from 'react';

export type LlmModelFamily = 'openai' | 'gemini' | 'anthropic' | 'sonar' | 'default';

/** Infer brand family from a gateway model id (gpt-5.1, gemini-2.5-pro, …). */
export function llmModelFamily(modelId: string): LlmModelFamily {
  const id = (modelId || '').trim().toLowerCase();
  if (!id) return 'default';
  if (id.includes('gemini') || id.startsWith('gemma')) return 'gemini';
  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (id.includes('sonar') || id.includes('perplexity')) return 'sonar';
  if (
    id.includes('gpt') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.includes('chatgpt') ||
    id.includes('openai') ||
    id.includes('davinci')
  ) {
    return 'openai';
  }
  return 'default';
}

function OpenAiMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.365-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.163a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function GeminiMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M12 0C8.6 7.2 7.2 8.6 0 12c7.2 3.4 8.6 4.8 12 12 3.4-7.2 4.8-8.6 12-12C16.8 8.6 15.4 7.2 12 0z" />
    </svg>
  );
}

function AnthropicMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M13.827 3.52h3.603L24 20.48h-3.603l-1.674-3.977h-7.446l-1.674 3.977H6L13.827 3.52zm.6 4.324-2.29 5.516h4.58l-2.29-5.516zM5.41 3.52h3.604L5.41 13.12 1.807 3.52H5.41z" />
    </svg>
  );
}

function SonarMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M12 2a10 10 0 1 0 10 10A10.011 10.011 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8.009 8.009 0 0 1-8 8zm0-14a1 1 0 0 0-1 1v4.586l-2.707 2.707a1 1 0 1 0 1.414 1.414l3-3A1 1 0 0 0 13 12V7a1 1 0 0 0-1-1z" />
    </svg>
  );
}

function DefaultMark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v3m0 12v3M3 12h3m12 0h3M6.3 6.3l2.1 2.1m7.2 7.2 2.1 2.1m0-11.4-2.1 2.1M8.4 15.6l-2.1 2.1"
      />
    </svg>
  );
}

const FAMILY_STYLE: Record<
  LlmModelFamily,
  {
    chip: string;
    icon: string;
    label: string;
    Mark: (p: { className?: string }) => ReactElement;
  }
> = {
  openai: {
    chip: 'bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300',
    icon: 'text-emerald-600 dark:text-emerald-300',
    label: 'OpenAI',
    Mark: OpenAiMark,
  },
  gemini: {
    chip: 'bg-sky-500/15 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300',
    icon: 'text-sky-600 dark:text-sky-300',
    label: 'Gemini',
    Mark: GeminiMark,
  },
  anthropic: {
    chip: 'bg-orange-500/15 text-orange-800 dark:bg-orange-400/15 dark:text-orange-200',
    icon: 'text-orange-600 dark:text-orange-300',
    label: 'Anthropic',
    Mark: AnthropicMark,
  },
  sonar: {
    chip: 'bg-teal-500/15 text-teal-800 dark:bg-teal-400/15 dark:text-teal-200',
    icon: 'text-teal-600 dark:text-teal-300',
    label: 'Sonar',
    Mark: SonarMark,
  },
  default: {
    chip: 'bg-slate-500/15 text-slate-700 dark:bg-white/10 dark:text-slate-300',
    icon: 'text-slate-500 dark:text-slate-300',
    label: 'Model',
    Mark: DefaultMark,
  },
};

/** Compact brand glyph for model rows / triggers. */
export function LlmModelGlyph({
  modelId,
  size = 16,
  className = '',
}: {
  modelId: string;
  size?: number;
  className?: string;
}) {
  const family = llmModelFamily(modelId);
  const style = FAMILY_STYLE[family];
  const Mark = style.Mark;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md ${style.chip} ${className}`.trim()}
      style={{ width: size + 8, height: size + 8 }}
      title={style.label}
      aria-hidden
    >
      <span className="inline-flex" style={{ width: size, height: size }}>
        <Mark className={`h-full w-full ${style.icon}`} />
      </span>
    </span>
  );
}

export function llmModelFamilyLabel(modelId: string): string {
  return FAMILY_STYLE[llmModelFamily(modelId)].label;
}
