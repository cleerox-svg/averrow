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
    const el = screen.getByRole('status');
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
