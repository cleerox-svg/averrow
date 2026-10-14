import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Short name used in the fallback copy, e.g. "Intelligence panel". */
  label: string;
}

/**
 * Contains a render crash in one Observatory region (the side panel) so it
 * can't blank the whole map page. Retry re-mounts the children.
 */
export class PanelErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 p-3 m-3 rounded-lg font-mono text-[11px]"
        style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)', color: 'var(--sev-critical-text)' }}
      >
        <span>{this.props.label} failed to render.</span>
        <button
          type="button"
          className="ds-focusable font-bold uppercase tracking-wide text-[10px]"
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', textDecoration: 'underline' }}
          onClick={() => this.setState({ failed: false })}
        >
          Retry
        </button>
      </div>
    );
  }
}
