import type { SubmittedUrlItem } from '../types/ui';

export type PipelineRingPhase = 'queue' | 'extracted' | 'analyzing';

export type JobPipelineVisual =
  | { kind: 'score'; score: number }
  | { kind: 'ring'; filled: 1 | 2 | 3; phase: PipelineRingPhase }
  | { kind: 'failed' };

function isExtracted(item: SubmittedUrlItem): boolean {
  return (
    item.extraction_status === 'completed' ||
    (item.scraped_at_ms != null && Boolean(item.extraction_id))
  );
}

/**
 * Maps extraction + match list API fields to a single UI state:
 * - Match score (persisted) replaces all ring visuals.
 * - 1/4 + amber: queued or running page extraction.
 * - 2/4 + blue: posting text extracted; match not running yet.
 * - 3/4 + amber: AI profile match in progress.
 */
export function getJobPipelineVisual(item: SubmittedUrlItem): JobPipelineVisual | null {
  if (item.table !== 'active') return null;

  const ext = item.extraction_status;
  if (ext === 'failed') {
    return { kind: 'failed' };
  }

  if (item.match_overall_score != null) {
    return { kind: 'score', score: item.match_overall_score };
  }

  if (ext === 'pending' || ext === 'processing' || ext === 'extracted') {
    return { kind: 'ring', filled: 1, phase: 'queue' };
  }

  if (!isExtracted(item)) {
    return { kind: 'ring', filled: 1, phase: 'queue' };
  }

  if (item.match_status === 'processing') {
    return { kind: 'ring', filled: 3, phase: 'analyzing' };
  }

  return { kind: 'ring', filled: 2, phase: 'extracted' };
}

export function pipelineRingAriaLabel(visual: JobPipelineVisual): string {
  switch (visual.kind) {
    case 'score':
      return `Match score ${visual.score} out of 100`;
    case 'failed':
      return 'Job page extraction failed';
    case 'ring':
      if (visual.phase === 'queue') {
        return 'Pipeline: queued for extraction or extracting posting';
      }
      if (visual.phase === 'extracted') {
        return 'Pipeline: posting extracted; match analysis not started';
      }
      return 'Pipeline: AI match analysis running';
  }
}
