import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PeekSheet } from './PeekSheet';

const AREA = 800;
// jsdom has no PointerEvent: MouseEvent carries clientY / pointerId well enough for the drag math.
if (typeof window.PointerEvent === 'undefined') {
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  };
}
let clientHeight: PropertyDescriptor | undefined;
beforeEach(() => {
  clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => AREA });
});
afterEach(() => {
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

const sheetHeight = () => (screen.getByRole('dialog') as HTMLElement).style.height;

describe('PeekSheet height reporting', () => {
  it('reports the settled height (snap fraction x area), and 0 when it closes', () => {
    const onHeight = vi.fn();
    const { rerender } = render(<PeekSheet open onClose={vi.fn()} label="Sheet" onHeight={onHeight}>x</PeekSheet>);
    expect(onHeight).toHaveBeenLastCalledWith(240); // 30% of 800
    rerender(<PeekSheet open={false} onClose={vi.fn()} label="Sheet" onHeight={onHeight}>x</PeekSheet>);
    expect(onHeight).toHaveBeenLastCalledWith(0);
  });
  it('does not report per drag frame: only when the snap settles', () => {
    const onHeight = vi.fn();
    render(<PeekSheet open onClose={vi.fn()} label="Sheet" onHeight={onHeight}>x</PeekSheet>);
    const handle = screen.getByRole('button', { name: /Resize panel/ });
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    onHeight.mockClear();
    fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 });
    for (let y = 590; y > 400; y -= 10) fireEvent.pointerMove(handle, { clientY: y, pointerId: 1 });
    expect(onHeight).not.toHaveBeenCalled(); // 19 frames of dragging, zero page updates
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 });
    expect(onHeight.mock.calls.at(-1)![0]).toBe(480); // settled on the 60% snap
  });
});

describe('PeekSheet handle', () => {
  it('Enter and Space cycle the height like a tap (click with detail 0), arrows still step', async () => {
    const user = userEvent.setup();
    render(<PeekSheet open onClose={vi.fn()} label="Sheet">x</PeekSheet>);
    const handle = screen.getByRole('button', { name: /Resize panel/ });
    expect(sheetHeight()).toBe('30%');
    handle.focus();
    await user.keyboard('{Enter}');
    expect(sheetHeight()).toBe('60%');
    await user.keyboard(' ');
    expect(sheetHeight()).toBe('90%');
    await user.keyboard('{Enter}');
    expect(sheetHeight()).toBe('30%'); // cycles back
    await user.keyboard('{ArrowUp}');
    expect(sheetHeight()).toBe('60%');
  });
  it('a pointer click (detail > 0) is left to pointer-up: no double cycle', () => {
    render(<PeekSheet open onClose={vi.fn()} label="Sheet">x</PeekSheet>);
    fireEvent.click(screen.getByRole('button', { name: /Resize panel/ }), { detail: 1 });
    expect(sheetHeight()).toBe('30%');
  });
});

describe('PeekSheet reopen', () => {
  it('starts at the initial snap again, already at first paint (no leftover 90%)', () => {
    const seen: string[] = [];
    function Probe() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(o => !o)}>toggle</button>
          <PeekSheet open={open} onClose={() => setOpen(false)} label="Sheet">
            <span ref={el => { if (el) seen.push((el.closest('[role=dialog]') as HTMLElement).style.height); }}>x</span>
          </PeekSheet>
        </>
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: /Resize panel/ }), { detail: 0 }); // 60%
    fireEvent.click(screen.getByRole('button', { name: /Resize panel/ }), { detail: 0 }); // 90%
    expect(sheetHeight()).toBe('90%');
    fireEvent.click(screen.getByText('toggle')); // close
    seen.length = 0;
    fireEvent.click(screen.getByText('toggle')); // reopen
    expect(sheetHeight()).toBe('30%');
    // the first DOM the content ever saw on reopen was already the peek
    expect(seen[0]).toBe('30%');
  });
});

describe('PeekSheet focus', () => {
  function Host({ fallback }: { fallback?: () => HTMLElement | null }) {
    const [open, setOpen] = useState(false);
    return (
      <div>
        {!open && <button onClick={() => setOpen(true)}>Open it</button>}
        <button>stable</button>
        <PeekSheet open={open} onClose={() => setOpen(false)} label="Sheet" restoreFocus={fallback}>
          <button>inside</button>
        </PeekSheet>
      </div>
    );
  }
  it('takes focus when it opens even though the opener unmounts, and falls back to a stable control on close', async () => {
    const user = userEvent.setup();
    let stable: HTMLElement | null = null;
    render(<Host fallback={() => stable} />);
    stable = screen.getByText('stable');
    await user.click(screen.getByText('Open it'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus(); // not <body>
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stable).toHaveFocus(); // the opener was replaced; the stable fallback gets focus
  });
  it('returns focus to the opener when it still exists', async () => {
    const user = userEvent.setup();
    function Keep() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Opener</button>
          <PeekSheet open={open} onClose={() => setOpen(false)} label="Sheet"><button>inside</button></PeekSheet>
        </>
      );
    }
    render(<Keep />);
    await user.click(screen.getByText('Opener'));
    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByText('Opener')).toHaveFocus();
  });
  it('leaves focus alone when the content already claimed it', async () => {
    function Claim() {
      return <button autoFocus>content</button>;
    }
    const user = userEvent.setup();
    function Host2() {
      const [open, setOpen] = useState(false);
      return (<><button onClick={() => setOpen(true)}>go</button><PeekSheet open={open} onClose={() => setOpen(false)} label="Sheet"><Claim /></PeekSheet></>);
    }
    render(<Host2 />);
    await act(async () => { await user.click(screen.getByText('go')); });
    expect(screen.getByText('content')).toHaveFocus();
  });
});
