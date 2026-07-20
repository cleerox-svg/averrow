import { describe, it, expect } from 'vitest';
import {
  validateExecutiveName,
  validateWatchPlatforms,
  SUPPORTED_EXEC_PLATFORMS,
  EXEC_PLATFORM_LABELS,
} from './executives';

// Mirrors averrow-worker/test coverage for the same rules in
// executive-registry.ts (validateFullName / validateWatchPlatforms) —
// these are the client-side fail-fast copies, so the form never
// round-trips an obviously-invalid payload to the server.

describe('validateExecutiveName', () => {
  it('rejects an empty string', () => {
    expect(validateExecutiveName('')).toBe('Name is required');
  });

  it('rejects a whitespace-only string', () => {
    expect(validateExecutiveName('   ')).toBe('Name is required');
  });

  it('accepts a normal name', () => {
    expect(validateExecutiveName('Jane Doe')).toBeNull();
  });

  it('rejects a name over 200 characters', () => {
    expect(validateExecutiveName('A'.repeat(201))).toMatch(/too long/);
  });

  it('accepts exactly 200 characters', () => {
    expect(validateExecutiveName('A'.repeat(200))).toBeNull();
  });
});

describe('validateWatchPlatforms', () => {
  it('rejects an empty list', () => {
    expect(validateWatchPlatforms([])).toMatch(/at least one/);
  });

  it('rejects an unknown platform key', () => {
    expect(validateWatchPlatforms(['twitter', 'myspace'])).toMatch(/Unsupported platform key: myspace/);
  });

  it('accepts a single known platform', () => {
    expect(validateWatchPlatforms(['linkedin'])).toBeNull();
  });

  it('accepts all six supported platforms', () => {
    expect(validateWatchPlatforms([...SUPPORTED_EXEC_PLATFORMS])).toBeNull();
  });
});

describe('SUPPORTED_EXEC_PLATFORMS / EXEC_PLATFORM_LABELS', () => {
  it('has exactly the six platforms the social monitor supports', () => {
    expect([...SUPPORTED_EXEC_PLATFORMS].sort()).toEqual(
      ['github', 'instagram', 'linkedin', 'tiktok', 'twitter', 'youtube'].sort(),
    );
  });

  it('has a display label for every supported platform', () => {
    for (const p of SUPPORTED_EXEC_PLATFORMS) {
      expect(EXEC_PLATFORM_LABELS[p]).toBeTruthy();
    }
  });
});
