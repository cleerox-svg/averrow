import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { RedirectToAdminAbuseMailbox } from './App';

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.hash}</div>;
}

describe('tenant abuse-mailbox verdict link in the ops app', () => {
  it('forwards /modules/abuse-mailbox#msg-<id> to the admin page, keeping the anchor', () => {
    render(
      <MemoryRouter initialEntries={['/modules/abuse-mailbox#msg-9af9dec2']}>
        <Routes>
          <Route path="modules/abuse-mailbox" element={<RedirectToAdminAbuseMailbox />} />
          <Route path="admin/abuse-mailbox" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/admin/abuse-mailbox#msg-9af9dec2');
  });
});
