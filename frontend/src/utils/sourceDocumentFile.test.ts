import { describe, expect, it } from 'vitest';
import {
  SOURCE_DOCUMENT_ACCEPT,
  SOURCE_DOCUMENT_MAX_BYTES,
  isAllowedSourceDocumentFilename,
  sourceDocumentFileError,
  sourceKindLabel,
} from './sourceDocumentFile';

describe('sourceDocumentFile', () => {
  it('accepts pdf, docx, md, and markdown names', () => {
    expect(isAllowedSourceDocumentFilename('projects.pdf')).toBe(true);
    expect(isAllowedSourceDocumentFilename('writeup.DOCX')).toBe(true);
    expect(isAllowedSourceDocumentFilename('notes.md')).toBe(true);
    expect(isAllowedSourceDocumentFilename(String.raw`C:\docs\Acme.MARKDOWN`)).toBe(true);
    expect(isAllowedSourceDocumentFilename('folder/writeup.md')).toBe(true);
  });

  it('rejects other text types', () => {
    expect(isAllowedSourceDocumentFilename('notes.txt')).toBe(false);
    expect(isAllowedSourceDocumentFilename('slide.pptx')).toBe(false);
    expect(isAllowedSourceDocumentFilename('readme.md.txt')).toBe(false);
  });

  it('exposes md in the file-picker accept list', () => {
    expect(SOURCE_DOCUMENT_ACCEPT).toMatch(/\.md/);
    expect(SOURCE_DOCUMENT_ACCEPT).toMatch(/\.markdown/);
    expect(SOURCE_DOCUMENT_ACCEPT).toMatch(/text\/markdown/);
  });

  it('returns a type error for unsupported files and a size error when too large', () => {
    const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    expect(sourceDocumentFileError(txt)).toMatch(/PDF, DOCX, or Markdown/i);

    const md = new File(['# Project'], 'projects.md', { type: 'text/markdown' });
    expect(sourceDocumentFileError(md)).toBeNull();

    const huge = { name: 'big.md', size: SOURCE_DOCUMENT_MAX_BYTES + 1 } as File;
    expect(sourceDocumentFileError(huge)).toMatch(/10 MB or smaller/i);
  });

  it('labels markdown as MD', () => {
    expect(sourceKindLabel('markdown')).toBe('MD');
    expect(sourceKindLabel('pdf')).toBe('PDF');
    expect(sourceKindLabel('docx')).toBe('DOCX');
  });
});
