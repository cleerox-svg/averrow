import { describe, it, expect } from 'vitest';
import { formatSignalValue, parseIdList, splitBriefing, stripMarkdown, truncateText } from './briefing-text';

describe('stripMarkdown', () => {
  it('removes headings, bold and italics', () => {
    expect(stripMarkdown('## Title\n**bold** and *em* and _under_')).toBe('Title\nbold and em and under');
  });
  it('leaves snake_case identifiers alone', () => {
    expect(stripMarkdown('malicious_ip and agent_runs rose')).toBe('malicious_ip and agent_runs rose');
  });
  it('handles multi-line bold', () => {
    expect(stripMarkdown('**a\nb**')).toBe('a\nb');
  });
});

describe('splitBriefing', () => {
  it('splits a bold lead-in from the body', () => {
    expect(splitBriefing('**Phishing surge** — 40 new domains hit Acme.')).toEqual({
      title: 'Phishing surge',
      body: '40 new domains hit Acme.',
    });
  });
  it('splits on a spaced dash', () => {
    expect(splitBriefing('Quiet night — nothing notable.')).toEqual({ title: 'Quiet night', body: 'nothing notable.' });
  });
  it('splits on the first sentence', () => {
    expect(splitBriefing('Three clusters moved. Two are new.')).toEqual({ title: 'Three clusters moved', body: 'Two are new.' });
  });
  it('keeps a short unsplittable summary as the title', () => {
    expect(splitBriefing('Just a headline')).toEqual({ title: 'Just a headline', body: '' });
  });
  it('hard-cuts an overlong unsplittable summary at 140 chars', () => {
    const long = 'x'.repeat(300);
    const { title, body } = splitBriefing(long);
    expect(title).toHaveLength(140);
    expect(body).toHaveLength(160);
  });
  it('strips markdown from both parts', () => {
    const r = splitBriefing('**Title** — body with **bold** and _italic_');
    expect(r.body).toBe('body with bold and italic');
  });
  it('returns Untitled for empty input', () => {
    expect(splitBriefing(undefined)).toEqual({ title: 'Untitled', body: '' });
    expect(splitBriefing('   ')).toEqual({ title: 'Untitled', body: '' });
  });
});

describe('truncateText', () => {
  it('only truncates when over the limit', () => {
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('abcdefghij', 5)).toBe('abcde…');
  });
});

describe('parseIdList', () => {
  it('parses JSON arrays, bare JSON strings and comma lists; never throws', () => {
    expect(parseIdList('["a","b"]')).toEqual(['a', 'b']);
    expect(parseIdList('"solo"')).toEqual(['solo']);
    expect(parseIdList('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(parseIdList('[1,"x"]')).toEqual(['x']);
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList('{"not":"a list"}')).toEqual([]);
  });
});

describe('formatSignalValue', () => {
  it('summarises Observer record arrays instead of printing [object Object]', () => {
    expect(formatSignalValue([{ grade: 'F', count: 50931 }, { grade: 'A+', count: 13791 }])).toBe('F: 50,931, A+: 13,791');
    expect(formatSignalValue([{ name: 'Line', email_security_grade: 'D', threat_count: 15456 }])).toBe('Line (D, 15,456 threats)');
    expect(formatSignalValue([{ name: 'Notino', current_grade: 'C', previous_grade: 'A' }])).toBe('Notino: A → C');
  });

  it('keeps scalars, string lists and empties readable', () => {
    expect(formatSignalValue(1234)).toBe('1,234');
    expect(formatSignalValue('ok')).toBe('ok');
    expect(formatSignalValue(['a', 'b'])).toBe('a, b');
    expect(formatSignalValue([])).toBe('—');
    expect(formatSignalValue(null)).toBe('—');
    expect(formatSignalValue({ total: 3, new_24h: 1 })).toBe('3, 1');
    expect(formatSignalValue([{ previous_grade: 'D', current_grade: 'F' }])).toBe('D → F');
    expect(formatSignalValue(['', 'a'])).toBe('a');
    expect(formatSignalValue([''])).toBe('—');
  });
});
