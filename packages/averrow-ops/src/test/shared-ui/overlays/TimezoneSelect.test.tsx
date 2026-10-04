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
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    // rows: [Detected Paris, New York, Toronto, ...]; two downs lands on index 2.
    expect(onChange).toHaveBeenCalledWith('America/Toronto');
  });

  it('opens as a bottom sheet on compact screens', async () => {
    stubViewport(true);
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    expect((await screen.findByRole('dialog')).className).toContain('av-ov-sheet');
  });
});
