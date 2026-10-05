import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BottomSheet } from './BottomSheet';

describe('BottomSheet', () => {
  it('exposes a modal dialog role and uses a token background', () => {
    render(<BottomSheet open onClose={vi.fn()}><p>content</p></BottomSheet>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.style.background).toContain('var(--bg-elevated)');
    expect(dialog.className).not.toContain('bg-instrument');
  });

  it('renders nothing when closed', () => {
    render(<BottomSheet open={false} onClose={vi.fn()}><p>x</p></BottomSheet>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
