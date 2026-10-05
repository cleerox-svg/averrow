import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '../../../../../shared/src/ui/overlays';
import { installDomStubs, stubViewport } from './helpers';

beforeEach(() => {
  installDomStubs();
  stubViewport(false);
});

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const base = {
  open: true,
  title: 'Sign out of all devices?',
  description: 'This ends all your sessions.',
  consequence: "You'll stay signed in here.",
  confirmLabel: 'Sign out everywhere',
};

describe('ConfirmDialog', () => {
  it('renders title, description, consequence and both actions', () => {
    render(<ConfirmDialog {...base} onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Sign out of all devices?' })).toBeInTheDocument();
    expect(screen.getByText('This ends all your sessions.')).toBeInTheDocument();
    expect(screen.getByText("You'll stay signed in here.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeInTheDocument();
  });

  it('focuses Cancel initially for the danger tone', async () => {
    render(<ConfirmDialog {...base} tone="danger" onOpenChange={() => {}} onConfirm={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('disables both buttons and shows busy state while the confirm promise is pending, then closes', async () => {
    const d = deferred();
    const onOpenChange = vi.fn();
    render(<ConfirmDialog {...base} onOpenChange={onOpenChange} onConfirm={() => d.promise} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const confirm = screen.getByRole('button', { name: 'Sign out everywhere' });
    // aria-disabled (not disabled) so keyboard focus is never dropped mid-request.
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(confirm).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).not.toHaveBeenCalled();
    // Esc must not dismiss mid-request.
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
    d.resolve();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open with an inline alert when confirm rejects, and can retry', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce(undefined);
    render(<ConfirmDialog {...base} onOpenChange={onOpenChange} onConfirm={onConfirm} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('uses errorMessage override and a generic fallback for non-Error rejections', async () => {
    const { rerender } = render(
      <ConfirmDialog {...base} onOpenChange={() => {}} onConfirm={() => Promise.reject('x')} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/try again/i);
    rerender(
      <ConfirmDialog {...base} errorMessage="Custom failure." onOpenChange={() => {}} onConfirm={() => Promise.reject(new Error('raw'))} />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(await screen.findByText('Custom failure.')).toBeInTheDocument();
  });

  it('Cancel calls onOpenChange(false) without confirming', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...base} onOpenChange={onOpenChange} onConfirm={onConfirm} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('presents as a bottom sheet with a stacked footer on compact screens', () => {
    stubViewport(true);
    render(<ConfirmDialog {...base} onOpenChange={() => {}} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('av-ov-sheet');
    const footer = screen.getByRole('button', { name: 'Cancel' }).parentElement as HTMLElement;
    expect(footer).toHaveAttribute('data-presentation', 'sheet');
  });

  it('presents as a centered dialog on desktop', () => {
    render(<ConfirmDialog {...base} onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole('dialog').className).toContain('av-ov-dialog');
  });
});

describe('ConfirmDialog a11y (S8)', () => {
  it('announces description AND consequence as the dialog description', () => {
    render(<ConfirmDialog {...base} onOpenChange={() => {}} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining("You'll stay signed in here."));
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining(String(base.description)));
  });
});
