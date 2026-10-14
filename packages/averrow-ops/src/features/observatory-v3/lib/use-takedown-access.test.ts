import { describe, it, expect } from 'vitest';
import { canSeeTakedowns } from './use-takedown-access';

describe('canSeeTakedowns (mirrors the server manage_takedowns gate)', () => {
  it.each(['super_admin', 'admin', 'analyst'])('%s can', role => expect(canSeeTakedowns(role)).toBe(true));
  it.each(['sales', 'support', 'billing', 'auditor', 'client', undefined, null])('%s cannot', role => expect(canSeeTakedowns(role as string | null | undefined)).toBe(false));
});
