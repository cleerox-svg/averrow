import type { Ref } from 'react';
import { sentenceCase } from '@/lib/sentence-case';
import './threats.css';

/**
 * Sectioned narrative divider (matches /brands Intel). Pass `innerRef` to make
 * the header a programmatic focus target (tabIndex -1) for scroll-to-section.
 * Title is a sentence-case sans h2 at the --type-h2-* scale; the subtitle is a
 * 12px label. Styles live in threats.css (`.thr-panel-title` / `.thr-label`).
 */
export function PanelHeader({ title, subtitle, id, innerRef }: {
  title: string;
  subtitle: string;
  id?: string;
  innerRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      className={innerRef ? 'pt-2 ds-focusable' : 'pt-2'}
      id={id}
      ref={innerRef}
      tabIndex={innerRef ? -1 : undefined}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="thr-panel-title">{sentenceCase(title)}</h2>
        <span className="thr-label">{subtitle}</span>
      </div>
      <div className="thr-panel-rule" />
    </div>
  );
}
