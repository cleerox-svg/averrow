import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  Switch, SegmentedControl, Field, Input, Select, TimeInput, describeQuietWindow,
} from '../../../../../shared/src/ui/forms';

describe('Switch', () => {
  function Row({ onChange, disabled }: { onChange?: (v: boolean) => void; disabled?: boolean }) {
    const [on, setOn] = useState(false);
    return (
      <div>
        <span id="t">Push alerts</span>
        <span id="d">Get a ping when something critical lands.</span>
        <Switch aria-labelledby="t" aria-describedby="d" checked={on} disabled={disabled}
          onCheckedChange={(v) => { setOn(v); onChange?.(v); }} />
      </div>
    );
  }

  it('is named and described via aria attributes', () => {
    render(<Row />);
    const sw = screen.getByRole('switch', { name: 'Push alerts' });
    expect(sw).toHaveAccessibleDescription('Get a ping when something critical lands.');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles with Space and click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Row onChange={onChange} />);
    const sw = screen.getByRole('switch');
    sw.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(true);
    await user.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('does nothing when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Row onChange={onChange} disabled />);
    const sw = screen.getByRole('switch');
    expect(sw).toBeDisabled();
    await user.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SegmentedControl', () => {
  const OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'dark', label: 'Dark', icon: <svg data-testid="moon" /> },
    { value: 'light', label: 'Light' },
  ];
  function Harness({ onChange }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState('auto');
    return <SegmentedControl aria-label="Theme" value={v} options={OPTIONS} onValueChange={(n) => { setV(n); onChange?.(n); }} />;
  }

  it('exposes a labelled radiogroup with radios', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked();
    expect(screen.getByTestId('moon')).toBeInTheDocument();
  });

  it('arrow keys rove focus (wrapping) and Space selects', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Dark' })).toHaveFocus());
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus());
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith('light');
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
  });
});

describe('Field', () => {
  it('associates label with the control and help via describedby', () => {
    render(<Field label="Display name" help="Shown to teammates."><Input /></Field>);
    const input = screen.getByLabelText('Display name');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAccessibleDescription('Shown to teammates.');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('error is an alert, marks the control invalid and is described', () => {
    render(<Field label="Name" help="Help text" error="Name is required"><Input /></Field>);
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Name is required');
    expect(alert.querySelector('svg')).not.toBeNull();
    expect(input).toHaveAccessibleDescription(/Name is required/);
    expect(input).toHaveAccessibleDescription(/Help text/);
  });

  it('works for Select and TimeInput and keeps caller aria-describedby', () => {
    render(
      <>
        <Field label="Level"><Select defaultValue="a"><option value="a">A</option></Select></Field>
        <Field label="From"><TimeInput defaultValue="22:00" aria-describedby="extra" /></Field>
        <p id="extra">Extra note</p>
      </>,
    );
    expect(screen.getByLabelText('Level').tagName).toBe('SELECT');
    const time = screen.getByLabelText('From');
    expect(time).toHaveAttribute('type', 'time');
    expect(time).toHaveAttribute('step', '900');
    expect(time).toHaveAccessibleDescription('Extra note');
  });

  it('two Fields get distinct ids', () => {
    render(<><Field label="One"><Input /></Field><Field label="Two"><Input /></Field></>);
    expect(screen.getByLabelText('One').id).not.toBe(screen.getByLabelText('Two').id);
  });
});

describe('Input', () => {
  it('readOnly shows a lock icon by default and is not editable', async () => {
    const user = userEvent.setup();
    const { container } = render(<Input aria-label="Email" readOnly defaultValue="a@b.co" />);
    const input = screen.getByLabelText('Email');
    await user.type(input, 'xyz');
    expect(input).toHaveValue('a@b.co');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('lockIcon={false} hides the icon; editable has none', () => {
    const { container, rerender } = render(<Input aria-label="E" readOnly lockIcon={false} />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<Input aria-label="E" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('forwards ref', () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<Input aria-label="E" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});

describe('Select', () => {
  it('changes value via the native control; inline variant renders', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select variant="inline" aria-label="Frequency" defaultValue="daily" onChange={(e) => onChange(e.target.value)}>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
      </Select>,
    );
    await user.selectOptions(screen.getByLabelText('Frequency'), 'weekly');
    expect(onChange).toHaveBeenCalledWith('weekly');
  });
});

describe('describeQuietWindow', () => {
  it('describes overnight windows', () => {
    expect(describeQuietWindow('22:00', '07:00')).toBe('Quiet for 9 hours overnight');
  });
  it('describes same-day windows', () => {
    expect(describeQuietWindow('13:00', '14:00')).toBe('Quiet for 1 hour');
    expect(describeQuietWindow('09:00', '17:30')).toBe('Quiet for 8 hours 30 minutes');
  });
  it('handles minutes-only and overnight with minutes', () => {
    expect(describeQuietWindow('10:00', '10:15')).toBe('Quiet for 15 minutes');
    expect(describeQuietWindow('23:30', '00:00')).toBe('Quiet for 30 minutes overnight');
  });
  it('returns null for empty or invalid windows', () => {
    expect(describeQuietWindow('07:00', '07:00')).toBeNull();
    expect(describeQuietWindow('', '07:00')).toBeNull();
    expect(describeQuietWindow('25:00', '07:00')).toBeNull();
  });
});

import { TimezoneSelect } from '../../../../../shared/src/ui/overlays';

describe('Field wiring with a control-owned id (review fix)', () => {
  it('Input with its own id: label and help follow it', () => {
    render(<Field label="Name" help="Shown on invoices"><Input id="custom-name" /></Field>);
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('id', 'custom-name');
    expect(input).toHaveAccessibleDescription('Shown on invoices');
    expect(screen.getByText('Shown on invoices').id).toBe('custom-name-help');
  });

  it('Select, TimeInput and Switch with their own ids are labelled by the Field', () => {
    render(
      <>
        <Field label="Language"><Select id="lang"><option>EN</option></Select></Field>
        <Field label="Start"><TimeInput id="start" /></Field>
        <Field label="Alerts"><Switch id="alerts" /></Field>
      </>,
    );
    expect(screen.getByLabelText('Language')).toHaveAttribute('id', 'lang');
    expect(screen.getByLabelText('Start')).toHaveAttribute('id', 'start');
    expect(screen.getByRole('switch', { name: 'Alerts' })).toHaveAttribute('id', 'alerts');
  });

  it('TimezoneSelect consumes Field id, describedby and invalid', () => {
    render(
      <Field label="Time zone" help="Used for quiet hours" error="Pick one">
        <TimezoneSelect value="UTC" onChange={() => {}} zones={['UTC']} detectedZone={null} />
      </Field>,
    );
    const trigger = screen.getByRole('button', { name: 'Time zone' });
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAccessibleDescription('Pick one Used for quiet hours');
  });

  it('Switch off state uses the contrast tokens; checked keeps a white knob', () => {
    render(<Switch aria-label="x" />);
    const sw = screen.getByRole('switch');
    expect(sw.className).toContain('var(--switch-off-border)');
    const thumb = sw.querySelector('span') as HTMLElement;
    expect(thumb.className).toContain('var(--switch-knob-off)');
    expect(thumb.className).toContain('data-[state=checked]:bg-[#fff]');
  });

  it('SegmentedControl segments are 44px on coarse pointers', () => {
    render(<SegmentedControl aria-label="t" value="a" options={[{ value: 'a', label: 'A' }]} />);
    expect(screen.getByRole('radio').className).toContain('[@media(pointer:coarse)]:min-h-[44px]');
  });
});
