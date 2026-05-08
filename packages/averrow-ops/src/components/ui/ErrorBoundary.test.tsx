import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from './ErrorBoundary';

function BrokenComponent(): JSX.Element {
  throw new Error('Test error');
}

function WorkingComponent() {
  return <div>Working content</div>;
}

describe('ErrorBoundary', () => {
  // Suppress console.error for expected errors
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <WorkingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Working content')).toBeInTheDocument();
  });

  it('renders error UI when child throws', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('System Error')).toBeInTheDocument();
    // Error message should NOT be exposed to users
    expect(screen.queryByText('Test error')).not.toBeInTheDocument();
  });

  it('shows descriptive error message', () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong loading this view. Please try again.')).toBeInTheDocument();
  });

  it('shows Try Again button that resets error state', async () => {
    render(
      <ErrorBoundary>
        <BrokenComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Try Again')).toBeInTheDocument();

    // Click try again - it will re-render and catch the error again
    await userEvent.click(screen.getByText('Try Again'));
    // After reset, BrokenComponent throws again so error boundary catches it again
    expect(screen.getByText('System Error')).toBeInTheDocument();
  });

  it('does not show error UI initially', () => {
    render(
      <ErrorBoundary>
        <WorkingComponent />
      </ErrorBoundary>
    );
    expect(screen.queryByText('System Error')).not.toBeInTheDocument();
    expect(screen.queryByText('Try Again')).not.toBeInTheDocument();
  });
});
