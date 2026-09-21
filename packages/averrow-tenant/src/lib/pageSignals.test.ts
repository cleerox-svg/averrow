import { describe, it, expect } from 'vitest';
import {
  PAGE_SIGNAL_WEIGHTS,
  SHADOW_SIGNAL_WEIGHTS,
  pageSignalLabel,
  PAGE_SIGNAL_LABELS,
  SHADOW_SIGNAL_LABELS,
  parsePageSignalArray,
  defangHost,
} from './pageSignals';

describe('parsePageSignalArray', () => {
  it('returns [] for null', () => {
    expect(parsePageSignalArray(null)).toEqual([]);
  });

  it('returns [] for an empty-array JSON string', () => {
    expect(parsePageSignalArray('[]')).toEqual([]);
  });

  it('parses a normal fired-key JSON array', () => {
    expect(parsePageSignalArray('["credential_form","offdomain_form_exfil"]')).toEqual([
      'credential_form',
      'offdomain_form_exfil',
    ]);
  });

  it('degrades to [] on malformed JSON instead of throwing', () => {
    expect(() => parsePageSignalArray('not json{')).not.toThrow();
    expect(parsePageSignalArray('not json{')).toEqual([]);
  });

  it('degrades to [] when the JSON parses to a non-array', () => {
    expect(parsePageSignalArray('{"credential_form": 30}')).toEqual([]);
  });

  it('filters out non-string entries defensively', () => {
    expect(parsePageSignalArray('["credential_form", 42, null]')).toEqual(['credential_form']);
  });
});

describe('pageSignalLabel', () => {
  it('returns the mapped label for a known live key', () => {
    expect(pageSignalLabel('offdomain_form_exfil', PAGE_SIGNAL_LABELS)).toBe('Off-domain form exfil');
  });

  it('falls back to a humanized key for an unknown key', () => {
    expect(pageSignalLabel('some_future_signal_key', PAGE_SIGNAL_LABELS)).toBe('some future signal key');
  });

  it('returns the mapped label for a known shadow key', () => {
    expect(pageSignalLabel('default_scaffold_title', SHADOW_SIGNAL_LABELS)).toBe(
      'Default scaffold title never replaced',
    );
  });
});

describe('defangHost', () => {
  it('replaces every dot with [.]', () => {
    expect(defangHost('api.telegram.org')).toBe('api[.]telegram[.]org');
  });

  it('leaves a dotless host untouched', () => {
    expect(defangHost('localhost')).toBe('localhost');
  });

  it('never produces a string containing a bare "://" that could be pasted as a live URL', () => {
    // Defanging only handles the host; this just documents that a host
    // (no scheme) never round-trips into something clickable by accident.
    expect(defangHost('api.telegram.org')).not.toMatch(/:\/\//);
  });
});

describe('weight tables — live vs shadow are disjoint', () => {
  it('no key appears in both the live and shadow weight tables', () => {
    const liveKeys = Object.keys(PAGE_SIGNAL_WEIGHTS);
    const shadowKeys = Object.keys(SHADOW_SIGNAL_WEIGHTS);
    const overlap = liveKeys.filter((k) => shadowKeys.includes(k));
    expect(overlap).toEqual([]);
  });
});
