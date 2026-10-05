import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast, type ToastContextValue } from '../../../../../shared/src/ui/overlays';

let api: ToastContextValue;
function Grab() {
  api = useToast();
  return null;
}
const setup = () => render(<ToastProvider><Grab /></ToastProvider>);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ToastProvider', () => {
  it('shows one toast at a time and advances the queue', () => {
    setup();
    act(() => { api.success('First'); api.info('Second'); });
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.queryByText('Second')).toBeNull();
    act(() => { vi.advanceTimersByTime(3500); });
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByText('Second')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3500); });
    expect(screen.queryByText('Second')).toBeNull();
  });

  it('uses role=status for success/info and role=alert for errors', () => {
    setup();
    act(() => { api.success('Saved'); });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    act(() => { vi.advanceTimersByTime(3500); });
    act(() => { api.error('Could not save'); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
  });

  it('keeps errors for 6s (not 3.5s)', () => {
    setup();
    act(() => { api.error('Nope'); });
    act(() => { vi.advanceTimersByTime(3600); });
    expect(screen.getByText('Nope')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2500); });
    expect(screen.queryByText('Nope')).toBeNull();
  });

  it('keeps toasts with an action for 6s and runs + dismisses on action click', () => {
    setup();
    const onAction = vi.fn();
    act(() => { api.toast({ message: 'Notifications off', type: 'success', action: { label: 'Undo', onAction } }); });
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.getByText('Notifications off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Notifications off')).toBeNull();
  });

  it('pauses on hover and resumes with the remaining time on leave', () => {
    setup();
    act(() => { api.success('Hold me'); });
    const el = screen.getByText('Hold me').closest('[class*="av-ov-toast"]') as HTMLElement;
    act(() => { vi.advanceTimersByTime(2000); });
    fireEvent.mouseEnter(el);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(screen.getByText('Hold me')).toBeInTheDocument();
    fireEvent.mouseLeave(el);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('Hold me')).toBeInTheDocument(); // ~1500ms left
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByText('Hold me')).toBeNull();
  });

  it('pauses while focus is inside the toast', () => {
    setup();
    act(() => { api.toast({ message: 'Focus me', action: { label: 'Undo', onAction: () => {} } }); });
    const undo = screen.getByRole('button', { name: 'Undo' });
    fireEvent.focus(undo);
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByText('Focus me')).toBeInTheDocument();
  });

  it('is ops-compatible: showToast(message, type)', () => {
    setup();
    act(() => { api.showToast('Legacy call', 'error'); });
    expect(screen.getByRole('alert')).toHaveTextContent('Legacy call');
  });

  it('dismiss() removes the visible toast', () => {
    setup();
    let id = '';
    act(() => { id = api.info('Bye'); });
    act(() => { api.dismiss(id); });
    expect(screen.queryByText('Bye')).toBeNull();
  });

  it('throws outside a provider', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Grab />)).toThrow(/ToastProvider/);
    err.mockRestore();
  });
});

describe('ToastProvider (review fixes)', () => {
  it('keeps always-mounted live regions so inserted toasts are announced', () => {
    setup();
    const polite = document.querySelector('.av-toast-viewport [aria-live="polite"]');
    const assertive = document.querySelector('.av-toast-viewport [aria-live="assertive"]');
    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();
    act(() => { api.success('Hi'); });
    expect(document.querySelector('.av-toast-viewport [aria-live="polite"]')).toBe(polite);
    expect(polite).toHaveTextContent('Hi');
    act(() => { api.error('Bad'); });
    act(() => { vi.advanceTimersByTime(3500); });
    expect(assertive).toHaveTextContent('Bad');
  });

  it('sticky toasts (duration 0 / Infinity) get a 44px Dismiss button that unblocks the queue', () => {
    setup();
    act(() => { api.toast({ message: 'Stuck', duration: 0 }); api.info('Next'); });
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.getByText('Stuck')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Dismiss' });
    expect(btn.className).toContain('h-[44px]');
    fireEvent.click(btn);
    expect(screen.queryByText('Stuck')).toBeNull();
    expect(screen.getByText('Next')).toBeInTheDocument();
    act(() => { api.toast({ message: 'Inf', duration: Infinity }); });
    act(() => { vi.advanceTimersByTime(3500); });
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('Escape dismisses the focused toast', () => {
    setup();
    act(() => { api.toast({ message: 'Esc me', action: { label: 'Undo', onAction: () => {} } }); });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Undo' }), { key: 'Escape' });
    expect(screen.queryByText('Esc me')).toBeNull();
  });

  it('a pause that lands at expiry does not turn the toast sticky', () => {
    setup();
    act(() => { api.success('Edge'); });
    const el = screen.getByText('Edge').closest('[class*="av-ov-toast"]') as HTMLElement;
    act(() => { vi.advanceTimersByTime(3499); });
    fireEvent.mouseEnter(el);
    fireEvent.mouseLeave(el);
    act(() => { vi.advanceTimersByTime(10); });
    expect(screen.queryByText('Edge')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('hover and focus pause independently (leaving hover while focused stays paused)', () => {
    setup();
    act(() => { api.toast({ message: 'Both', action: { label: 'Undo', onAction: () => {} } }); });
    const el = screen.getByText('Both').closest('[class*="av-ov-toast"]') as HTMLElement;
    fireEvent.mouseEnter(el);
    fireEvent.focus(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.mouseLeave(el);
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByText('Both')).toBeInTheDocument();
  });
});
