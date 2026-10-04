// Pins the notification_preferences schema to the event registry.
//
// The prefs handler (handlers/notifications.ts) and the send-time opt-out
// gate (lib/notifications.ts) derive their column lists from
// USER_TOGGLEABLE_EVENTS + NOTIFICATION_CHANNELS. Flipping an event to
// `userToggleable: true` without a migration adding its column made
// GET/PATCH /api/notifications/preferences 500 with "no such column" for
// every user (takedown_awaiting_approval → migration 0280). This test
// fails the build instead.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_TOGGLEABLE_EVENTS, NOTIFICATION_CHANNELS } from '@averrow/shared';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function notificationPreferencesColumns(): Set<string> {
  const cols = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

    const create = /CREATE TABLE(?: IF NOT EXISTS)?\s+notification_preferences\s*\(([\s\S]*?)\n\);/i.exec(sql);
    if (create) {
      for (const line of create[1].split('\n')) {
        const m = /^\s*([a-z_][a-z0-9_]*)\s+/i.exec(line);
        if (m) cols.add(m[1]);
      }
    }

    const addRe = /ALTER TABLE\s+notification_preferences\s+ADD COLUMN\s+([a-z_][a-z0-9_]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = addRe.exec(sql))) cols.add(m[1]);
  }
  return cols;
}

describe('notification_preferences schema ↔ event registry', () => {
  const columns = notificationPreferencesColumns();

  it('parses the base table', () => {
    expect(columns.has('user_id')).toBe(true);
    expect(columns.has('brand_threat')).toBe(true);
  });

  it.each(USER_TOGGLEABLE_EVENTS.map((e) => e.key))(
    'user-toggleable event %s has a column',
    (key) => { expect(columns.has(key)).toBe(true); },
  );

  it.each(NOTIFICATION_CHANNELS.map((c) => c.key))(
    'channel %s has a column',
    (key) => { expect(columns.has(key)).toBe(true); },
  );
});
