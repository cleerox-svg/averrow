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

import { createEvent, fireEvent, waitFor } from '@testing-library/react';
import { Dialog, Menu, MenuTrigger, MenuContent, MenuItem } from '../../../../../shared/src/ui/overlays';

describe('Sheet drag (review fix)', () => {
  // jsdom has no PointerEvent, so clientY / pointerId must be defined on the event by hand.
  const fire = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', handle: Element, y: number) => {
    const ev = createEvent[type](handle);
    Object.defineProperty(ev, 'clientY', { value: y });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    fireEvent(handle, ev);
  };
  const drag = (handle: Element, from: number, to: number) => {
    fire('pointerDown', handle, from);
    fire('pointerMove', handle, to);
    fire('pointerUp', handle, to);
  };
  const setup = (onOpenChange: (o: boolean) => void) => {
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent title="Drag me">x</SheetContent>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog');
    return { dialog, handle: dialog.querySelector('[data-sheet-handle]') as Element };
  };

  it('follows the finger via --sheet-drag-y without touching the animation state attribute', () => {
    const { dialog, handle } = setup(() => {});
    fire('pointerDown', handle, 10);
    fire('pointerMove', handle, 50);
    expect(dialog.style.getPropertyValue('--sheet-drag-y')).toBe('40px');
    expect(dialog).toHaveAttribute('data-drag-active', 'true');
    expect(dialog).not.toHaveAttribute('data-dragging');
  });

  it('a short release springs back (offset 0, transition re-enabled) and does not close', () => {
    const onOpenChange = vi.fn();
    const { dialog, handle } = setup(onOpenChange);
    drag(handle, 0, 40);
    expect(dialog.style.getPropertyValue('--sheet-drag-y')).toBe('0px');
    expect(dialog).toHaveAttribute('data-drag-active', 'false');
    expect(dialog).toHaveAttribute('data-state', 'open');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('a dismissing drag keeps the drop offset (exit starts from the drop point)', () => {
    const onOpenChange = vi.fn();
    const { dialog, handle } = setup(onOpenChange); // controlled open=true: parent "refuses"
    drag(handle, 0, 120);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(dialog.style.getPropertyValue('--sheet-drag-y')).toBe('120px');
    expect(dialog).toHaveAttribute('data-drag-active', 'false');
  });

  it('a refused close springs back instead of leaving the sheet stranded', async () => {
    const { dialog, handle } = setup(() => {});
    drag(handle, 0, 120);
    await waitFor(() => expect(dialog.style.getPropertyValue('--sheet-drag-y')).toBe('0px'));
  });
});

describe('overlay styles survive overlay unmount (M4)', () => {
  const sheets = () => document.querySelectorAll('style[data-averrow-overlay-styles]');

  it('stays in <head> while the root is mounted, even after the dialog closes; one copy only', () => {
    const { rerender, unmount } = render(
      <>
        <Dialog open onOpenChange={() => {}} title="A" presentation="dialog">x</Dialog>
        <Sheet open onOpenChange={() => {}}><SheetContent title="B">y</SheetContent></Sheet>
      </>,
    );
    expect(sheets()).toHaveLength(1);
    rerender(
      <>
        <Dialog open={false} onOpenChange={() => {}} title="A" presentation="dialog">x</Dialog>
        <Sheet open={false} onOpenChange={() => {}}><SheetContent title="B">y</SheetContent></Sheet>
      </>,
    );
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0]?.textContent).toContain('av-ov-sheet-out');
    unmount();
    expect(sheets()).toHaveLength(0);
  });

  it('menu content renders above the modal layer (S9)', async () => {
    render(
      <Menu defaultOpen>
        <MenuTrigger asChild><button type="button">m</button></MenuTrigger>
        <MenuContent aria-label="m"><MenuItem>One</MenuItem></MenuContent>
      </Menu>,
    );
    const menu = await screen.findByRole('menu');
    expect(menu.style.zIndex).toContain('--z-popover');
  });
});

describe('Sheet labelledBy', () => {
  it('is named by the host heading with no duplicate heading', () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent title="Notifications" labelledBy="host-h">
          <h2 id="host-h">Notifications</h2>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toHaveAttribute('aria-labelledby', 'host-h');
    expect(screen.getAllByRole('heading', { name: 'Notifications' })).toHaveLength(1);
  });
});
