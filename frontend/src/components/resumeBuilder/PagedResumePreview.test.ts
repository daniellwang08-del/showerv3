import { describe, expect, it } from 'vitest';
import { stampPageBlockVisibility } from './PagedResumePreview';

describe('stampPageBlockVisibility', () => {
  it('stamps data-on-page and clears inline visibility so React style rewrites cannot hide titles', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div data-block data-gap-role="heading" style="color:#0f172a;visibility:hidden">Technical Skills</div>
      <div data-block data-gap-role="skill" style="visibility:visible">Languages: Go</div>
    `;
    const heading = host.querySelector('[data-gap-role="heading"]') as HTMLElement;
    const skill = host.querySelector('[data-gap-role="skill"]') as HTMLElement;

    stampPageBlockVisibility(host, [true, true]);

    expect(heading.dataset.onPage).toBe('1');
    expect(skill.dataset.onPage).toBe('1');
    expect(heading.style.visibility).toBe('');
    expect(skill.style.visibility).toBe('');

    // Simulate React re-applying a heading color style object (no visibility key).
    heading.style.color = '#9f1239';
    heading.style.removeProperty('visibility');

    expect(heading.dataset.onPage).toBe('1');
    expect(heading.style.visibility).toBe('');
  });

  it('marks off-page blocks as data-on-page=0', () => {
    const host = document.createElement('div');
    host.innerHTML = `<div data-block data-gap-role="heading">Education</div>`;
    const heading = host.querySelector('[data-block]') as HTMLElement;
    stampPageBlockVisibility(host, [false]);
    expect(heading.dataset.onPage).toBe('0');
    expect(heading.style.visibility).toBe('');
  });
});
