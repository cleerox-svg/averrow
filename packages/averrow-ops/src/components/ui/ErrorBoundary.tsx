import React from 'react';
import { Button } from './Button';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-20 animate-fade-in">
          <div className="font-mono text-xs text-accent uppercase tracking-wider mb-3">System Error</div>
          <div style={{ color: 'rgba(255,255,255,0.55)' }} className="text-sm mb-6 max-w-md text-center">
            Something went wrong loading this view. Please try again.
          </div>
          <Button variant="secondary" onClick={() => this.setState({ hasError: false, error: null })}>
            Try Again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
