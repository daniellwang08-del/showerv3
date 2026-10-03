import { describe, expect, it } from 'vitest';
import { contributionsToEditorText, resumeBulletsFromContributions } from './workExperience';

describe('resumeBulletsFromContributions', () => {
  it('keeps bullets that open with bold markup', () => {
    const list = [
      'Owned the **CI** platform.',
      '**Design**ed and led the migration of 120+ services to **Kubernetes**.',
      'Cut pipeline time **45%**.',
    ];
    expect(resumeBulletsFromContributions(list)).toEqual(list);
  });

  it('does not read decimals or bare numbers as numbered markers', () => {
    const list = ['3.5x faster builds', '2) shipped']; // only "2) " is a marker
    expect(resumeBulletsFromContributions(list)).toEqual(['shipped']);
  });

  it('still recognises real markdown bullets', () => {
    expect(resumeBulletsFromContributions(['- one', '* two', '1. three', 'prose'])).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('round-trips bold-led lines through the editor text', () => {
    expect(contributionsToEditorText(['**Led** the team'])).toBe('- **Led** the team');
  });
});
