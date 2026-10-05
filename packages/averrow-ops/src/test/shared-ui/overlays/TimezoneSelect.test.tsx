import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimezoneSelect, formatTimeZoneLabel } from '../../../../../shared/src/ui/overlays';
import { installDomStubs, stubViewport } from './helpers';

beforeEach(() => {
  installDomStubs();
  stubViewport(false);
});

const JAN = new Date('2026-01-15T12:00:00Z');
const JUL = new Date('2026-07-15T12:00:00Z');
const ZONES = ['UTC', 'America/Toronto', 'America/New_York', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Kolkata'];

describe('formatTimeZoneLabel', () => {
  it('formats city + offset', () => {
    expect(formatTimeZoneLabel('America/Toronto', JAN)).toBe('Toronto (UTC-5)');
    expect(formatTimeZoneLabel('Asia/Tokyo', JAN)).toBe('Tokyo (UTC+9)');
  });
  it('follows daylight saving at the given date', () => {
    expect(formatTimeZoneLabel('America/Toronto', JUL)).toBe('Toronto (UTC-4)');
  });
  it('handles half-hour offsets, underscores and nested ids', () => {
    expect(formatTimeZoneLabel('Asia/Kolkata', JAN)).toBe('Kolkata (UTC+5:30)');
    expect(formatTimeZoneLabel('America/Argentina/Buenos_Aires', JAN)).toBe('Buenos Aires (UTC-3)');
  });
  it('reads UTC as UTC and returns unknown zones unchanged', () => {
    expect(formatTimeZoneLabel('UTC', JAN)).toBe('UTC');
    expect(formatTimeZoneLabel('Not/AZone', JAN)).toBe('Not/AZone');
  });
});

describe('TimezoneSelect', () => {
  const setup = (over: Partial<React.ComponentProps<typeof TimezoneSelect>> = {}) => {
    const onChange = vi.fn();
    render(
      <TimezoneSelect value="America/Toronto" onChange={onChange} zones={ZONES} detectedZone="Europe/Paris" now={JAN} aria-label="Time zone" {...over} />,
    );
    return { onChange, user: userEvent.setup() };
  };

  it('shows the current zone as "Toronto (UTC-5)" on the trigger', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Time zone' })).toHaveTextContent('Toronto (UTC-5)');
  });

  it('opens a listbox with the detected zone pinned first and the current zone selected', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    const list = await screen.findByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Detected: Paris (UTC+1)');
    expect(options[0]).toHaveTextContent('Use this');
    // Detected zone is not repeated further down.
    expect(within(list).getAllByRole('option', { name: /Paris/ })).toHaveLength(1);
    const selected = options.filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('Toronto (UTC-5)');
  });

  it('groups zones by region', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    await screen.findByRole('listbox');
    expect(screen.getByRole('group', { name: 'Americas' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Asia' })).toBeInTheDocument();
  });

  it('filters as you type and shows an empty state', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    const search = await screen.findByRole('combobox', { name: 'Search time zones' });
    await user.type(search, 'tok');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Tokyo (UTC+9)');
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText("No time zone matches 'zzz'")).toBeInTheDocument();
  });

  it('calls onChange with the IANA id and closes when an option is clicked', async () => {
    const { user, onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    await user.click(await screen.findByRole('option', { name: /Tokyo/ }));
    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects the detected zone', async () => {
    const { user, onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    await user.click(await screen.findByRole('option', { name: /Detected/ }));
    expect(onChange).toHaveBeenCalledWith('Europe/Paris');
  });

  it('supports arrow keys + Enter from the search box', async () => {
    const { user, onChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    await screen.findByRole('combobox', { name: 'Search time zones' });
    // The highlight starts on the selected row (Toronto); one down moves to the next row.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('Asia/Kolkata');
  });

  it('opens as a bottom sheet on compact screens', async () => {
    stubViewport(true);
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    expect((await screen.findByRole('dialog')).className).toContain('av-ov-sheet');
  });
});

describe('TimezoneSelect legacy ids (review fix)', () => {
  const run = (over: Partial<React.ComponentProps<typeof TimezoneSelect>> = {}) => {
    const onChange = vi.fn();
    render(<TimezoneSelect value="Asia/Calcutta" onChange={onChange} zones={['UTC', 'Asia/Calcutta', 'Asia/Kolkata', 'Europe/Kiev', 'Asia/Saigon']} detectedZone={null} now={JAN} aria-label="Time zone" {...over} />);
    return { onChange, user: userEvent.setup() };
  };

  it('labels legacy ids with the modern city name', () => {
    expect(formatTimeZoneLabel('Asia/Calcutta', JAN)).toBe('Kolkata (UTC+5:30)');
    expect(formatTimeZoneLabel('Europe/Kiev', JAN)).toBe('Kyiv (UTC+2)');
    expect(formatTimeZoneLabel('Asia/Saigon', JAN)).toBe('Ho Chi Minh (UTC+7)');
  });

  it('collapses Calcutta/Kolkata into one selected row', async () => {
    const { user } = run();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    const kolkata = (await screen.findAllByRole('option')).filter((o) => /Kolkata/.test(o.textContent ?? ''));
    expect(kolkata).toHaveLength(1);
    expect(kolkata[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('search matches the legacy name', async () => {
    const { user } = run({ value: 'UTC' });
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    await user.type(await screen.findByRole('combobox', { name: 'Search time zones' }), 'calcutta');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Kolkata');
  });

  it('marks the detected row selected when detected is a legacy alias of the value', async () => {
    const { user } = run({ value: 'Asia/Kolkata', detectedZone: 'Asia/Calcutta' });
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    const detected = await screen.findByRole('option', { name: /Detected/ });
    expect(detected).toHaveAttribute('aria-selected', 'true');
  });

  it('opens with the selected row highlighted and exposes aria-autocomplete', async () => {
    const { user, onChange } = run({ value: 'Europe/Kiev' });
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    const input = await screen.findByRole('combobox', { name: 'Search time zones' });
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('Europe/Kyiv');
  });
});
