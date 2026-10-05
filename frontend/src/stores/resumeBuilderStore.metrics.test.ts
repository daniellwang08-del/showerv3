import { afterEach, describe, expect, it } from 'vitest';
import type { ResumeDesign } from '@/types/resumeDesign';
import { selectIsDirty, useResumeBuilderStore } from './resumeBuilderStore';

const design = {
  theme_id: 't',
  typography: {},
  colors: {},
  layout: { header_metrics: null, layout_metrics: null },
  sections: {},
} as ResumeDesign;

afterEach(() => {
  useResumeBuilderStore.setState({ design: null, baseline: '', saving: false });
});

describe('preview layout cache', () => {
  it('does not mark the design dirty when header metrics update', () => {
    useResumeBuilderStore.setState({ design, baseline: JSON.stringify(design) });
    useResumeBuilderStore.getState().setHeaderMetrics({
      band_pt: 72,
      gap_pt: 8,
      measured_at_px: 816,
    });
    const s = useResumeBuilderStore.getState();
    expect(s.design?.layout.header_metrics?.band_pt).toBe(72);
    expect(selectIsDirty(s)).toBe(false);
  });
});
