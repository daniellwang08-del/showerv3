import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';

describe('Composer', () => {
  it('keeps long drafts inside the field with a scrollable max height', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} with enough text to wrap.`).join('\n');

    const { rerender } = render(
      <Composer size="lg" value="" onChange={onChange} onSubmit={vi.fn()} />,
    );

    const field = screen.getByRole('textbox');
    // jsdom does not layout text; stub scrollHeight growth like a tall draft.
    Object.defineProperty(field, 'scrollHeight', {
      configurable: true,
      get: () => (field.value.split('\n').length > 8 ? 480 : 48),
    });

    await user.click(field);
    rerender(<Composer size="lg" value={long} onChange={onChange} onSubmit={vi.fn()} />);

    const updated = screen.getByRole('textbox');
    expect(updated.style.maxHeight).toBe('280px');
    expect(updated.style.height).toBe('280px');
    expect(updated.style.overflowY).toBe('auto');
    expect(updated.className).toContain('[overflow-wrap:anywhere]');
  });

  it('breaks long unbroken urls instead of overflowing sideways', () => {
    const url = `https://boards.example.com/jobs/${'a'.repeat(180)}`;
    render(<Composer size="lg" value={url} onChange={vi.fn()} onSubmit={vi.fn()} />);
    const field = screen.getByRole('textbox');
    expect(field.className).toMatch(/break-words/);
    expect(field.className).toMatch(/overflow-x-hidden/);
  });
});
