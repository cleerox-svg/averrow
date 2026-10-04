import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sheet, SheetContent } from '../../../../../shared/src/ui/overlays';
import { installDomStubs } from './helpers';

beforeEach(() => installDomStubs());

describe('Sheet', () => {
  it('renders a modal dialog with an accessible name and a grab handle', () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent title="Pick one" description="Choose an option">
          <p>body</p>
        </SheetContent>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Pick one' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Choose an option');
    expect(dialog.querySelector('[data-sheet-handle]')).not.toBeNull();
    expect(dialog.className).toContain('av-ov-sheet');
    expect(dialog.style.maxHeight).toBe('85dvh');
  });

  it('closes on Escape', async () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent title="T">x</SheetContent>
      </Sheet>,
    );
    await userEvent.setup().keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the title for assistive tech only with hideTitle', () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent title="Account menu" hideTitle>x</SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Account menu' })).toBeInTheDocument();
    expect(screen.getByText('Account menu')).toHaveClass('sr-only');
  });
});
