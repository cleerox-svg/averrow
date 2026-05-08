import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

function TestConsumer() {
  const { showToast } = useToast();
  return (
    <button onClick={() => showToast('Test message', 'success')}>
      Show Toast
    </button>
  );
}

function ErrorToastConsumer() {
  const { showToast } = useToast();
  return (
    <button onClick={() => showToast('Error occurred', 'error')}>
      Show Error
    </button>
  );
}

describe('Toast', () => {
  it('shows toast message when triggered', async () => {
    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    await act(async () => {
      screen.getByText('Show Toast').click();
    });

    expect(screen.getByText('Test message')).toBeInTheDocument();
  });

  it('auto-dismisses after timeout', async () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <TestConsumer />
      </ToastProvider>
    );

    await act(async () => {
      screen.getByText('Show Toast').click();
    });

    expect(screen.getByText('Test message')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByText('Test message')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it('shows multiple toasts', async () => {
    function MultiConsumer() {
      const { showToast } = useToast();
      return (
        <>
          <button onClick={() => showToast('First toast', 'info')}>First</button>
          <button onClick={() => showToast('Second toast', 'success')}>Second</button>
        </>
      );
    }

    render(
      <ToastProvider>
        <MultiConsumer />
      </ToastProvider>
    );

    await act(async () => {
      screen.getByText('First').click();
      screen.getByText('Second').click();
    });

    expect(screen.getByText('First toast')).toBeInTheDocument();
    expect(screen.getByText('Second toast')).toBeInTheDocument();
  });

  it('applies error styling for error toast', async () => {
    render(
      <ToastProvider>
        <ErrorToastConsumer />
      </ToastProvider>
    );

    await act(async () => {
      screen.getByText('Show Error').click();
    });

    const toast = screen.getByText('Error occurred');
    expect(toast.closest('div[class*="bg-accent"]')).toBeInTheDocument();
  });

  it('throws when useToast is used outside provider', () => {
    // Suppress console.error for expected error
    vi.spyOn(console, 'error').mockImplementation(() => {});

    function Orphan() {
      useToast();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow('useToast must be used within ToastProvider');
  });
});
