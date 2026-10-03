import { describe, expect, it } from 'vitest';

const EM_DASH = '\u2014';

const sources = import.meta.glob(['../**/*.{ts,tsx,css}', '../../index.html'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('copy style', () => {
  it('never uses the em dash character', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes(EM_DASH))
      .map(([file, text]) => {
        const line = text.split('\n').findIndex((l) => l.includes(EM_DASH)) + 1;
        return `${file.replace(/^\.\.\//, 'src/')}:${line}`;
      });
    expect(offenders).toEqual([]);
  });
});
