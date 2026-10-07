import { describe, expect, it } from 'vitest';
import { parseInlineMarkup } from './richText';

describe('parseInlineMarkup', () => {
  it('keeps whole-word bold', () => {
    expect(parseInlineMarkup('Built on **Kafka** and **Go**')).toEqual([
      { text: 'Built on ', bold: false, italic: false, underline: false },
      { text: 'Kafka', bold: true, italic: false, underline: false },
      { text: ' and ', bold: false, italic: false, underline: false },
      { text: 'Go', bold: true, italic: false, underline: false },
    ]);
  });

  it('renders bold that splits a word as plain text', () => {
    expect(parseInlineMarkup('**Design**ed with **engineer**s at **AWS**')).toEqual([
      { text: 'Designed with engineers at ', bold: false, italic: false, underline: false },
      { text: 'AWS', bold: true, italic: false, underline: false },
    ]);
  });

  it('keeps bold next to punctuation', () => {
    const segs = parseInlineMarkup('cut latency **40%**, using **Node.js**.');
    expect(segs.filter((s) => s.bold).map((s) => s.text)).toEqual(['40%', 'Node.js']);
  });
});
