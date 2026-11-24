import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, Link, useLocation } from 'react-router-dom';
import { appHistoryIndex, BackLink, useBack, replaceUrlKeepingState } from '@averrow/shared/nav';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}
function Detail() {
  const { canGoBack } = useBack('/parent');
  return (
    <div>
      <Where />
      <span data-testid="can">{String(canGoBack)}</span>
      <BackLink fallback="/parent">BACK</BackLink>
    </div>
  );
}
function App() {
  return (
    <Routes>
      <Route path="/parent" element={<div><Where />parent</div>} />
      <Route path="/list" element={<div><Where /><Link to="/detail">open</Link></div>} />
      <Route path="/detail" element={<Detail />} />
      <Route path="/old" element={<Navigate to="/detail" replace />} />
    </Routes>
  );
}
function start(path: string) {
  window.history.replaceState(null, '', path);
  return render(<BrowserRouter><App /></BrowserRouter>);
}

describe('shared nav (BrowserRouter)', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'));

  it('cold start has index 0 and Back goes to fallback with replace', () => {
    start('/detail');
    expect(appHistoryIndex()).toBe(0);
    expect(screen.getByTestId('can').textContent).toBe('false');
    const len = window.history.length;
    fireEvent.click(screen.getByText('BACK'));
    expect(screen.getByTestId('where').textContent).toBe('/parent');
    expect(window.history.length).toBe(len);
  });

  it('after a push, Back returns to the previous screen', async () => {
    start('/list');
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('where').textContent).toBe('/detail');
    expect(appHistoryIndex()).toBe(1);
    expect(screen.getByTestId('can').textContent).toBe('true');
    fireEvent.click(screen.getByText('BACK'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/list'));
  });

  it('redirect-on-arrival (replace) is still a cold start', () => {
    start('/old');
    expect(screen.getByTestId('where').textContent).toBe('/detail');
    expect(appHistoryIndex()).toBe(0);
    expect(screen.getByTestId('can').textContent).toBe('false');
    fireEvent.click(screen.getByText('BACK'));
    expect(screen.getByTestId('where').textContent).toBe('/parent');
  });

  it('BackLink renders the fallback href; modifier clicks keep default behaviour', () => {
    start('/detail');
    const a = screen.getByText('BACK') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/parent');
    // jsdom cannot navigate; swallow the default after React has seen the event.
    const swallow = (e: Event) => e.preventDefault();
    document.addEventListener('click', swallow);
    fireEvent.click(a, { ctrlKey: true });
    expect(screen.getByTestId('where').textContent).toBe('/detail');
    fireEvent.click(a, { metaKey: true });
    document.removeEventListener('click', swallow);
    expect(screen.getByTestId('where').textContent).toBe('/detail');
  });
});

describe('history idx hygiene', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'));

  it('idx survives the AuthProvider-style URL strip, and later pushes stay numeric', () => {
    start('/list');
    replaceUrlKeepingState('/list');
    expect(appHistoryIndex()).toBe(0);
    fireEvent.click(screen.getByText('open'));
    expect(appHistoryIndex()).toBe(1);
    expect(screen.getByTestId('can').textContent).toBe('true');
  });

  it('NaN / garbage idx is unknown, not "can go back"', () => {
    for (const bad of [Number.NaN, -1, 1.5, '3', null]) {
      window.history.replaceState({ idx: bad }, '', '/detail');
      render(<MemoryRouter initialEntries={['/detail']}><App /></MemoryRouter>);
      expect(appHistoryIndex()).toBe(0);
      expect(screen.getAllByTestId('can').pop()?.textContent).toBe('false');
    }
  });
});

describe('shared nav (MemoryRouter fallback)', () => {
  it('first entry falls back; basename-aware href', () => {
    render(
      <MemoryRouter initialEntries={['/detail']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('can').textContent).toBe('false');
    fireEvent.click(screen.getByText('BACK'));
    expect(screen.getByTestId('where').textContent).toBe('/parent');
  });
});
