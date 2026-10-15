import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PanelDock, type PanelDockProps } from './PanelDock';

// The aside is the scroll container and never remounts across tab / lens swaps, so its scroll must be reset by hand.
function dock(props: Partial<PanelDockProps> = {}) {
  return (
    <PanelDock tab="intel" onTab={vi.fn()} placement="dock" label="Dock" {...props}>
      <div style={{ height: 2000 }}>content</div>
    </PanelDock>
  );
}

describe('PanelDock scroll reset', () => {
  it('scrolls back to the top when the tab changes', () => {
    const { rerender } = render(dock());
    const aside = screen.getByRole('complementary', { name: 'Dock' });
    aside.scrollTop = 400;
    rerender(dock({ tab: 'events' }));
    expect(aside.scrollTop).toBe(0);
    aside.scrollTop = 250;
    rerender(dock({ tab: 'intel' }));
    expect(aside.scrollTop).toBe(0);
  });

  it('scrolls back to the top when the Intel content switches between the Threats panel and a lens panel', () => {
    const { rerender } = render(dock({ contentKey: 'threats' }));
    const aside = screen.getByRole('complementary', { name: 'Dock' });
    aside.scrollTop = 400;
    rerender(dock({ contentKey: 'lens' }));
    expect(aside.scrollTop).toBe(0);
    aside.scrollTop = 300;
    rerender(dock({ contentKey: 'threats' }));
    expect(aside.scrollTop).toBe(0);
  });

  it('keeps the scroll position on a re-render that changes neither', () => {
    const { rerender } = render(dock({ contentKey: 'lens' }));
    const aside = screen.getByRole('complementary', { name: 'Dock' });
    aside.scrollTop = 400;
    rerender(dock({ contentKey: 'lens', eventCount: 12, label: 'Dock' }));
    expect(aside.scrollTop).toBe(400);
  });
});
