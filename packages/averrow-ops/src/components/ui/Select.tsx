import { cn } from '@/lib/cn';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string }>;
}

export function Select({ options, className, ...props }: SelectProps) {
  return (
    <select
      style={{ color: 'var(--text-primary)' }}
      className={cn(
        'bg-instrument border border-white/[0.08] rounded-md px-3 py-2 text-sm font-mono',
        'focus:outline-none focus:border-accent/30',
        className
      )}
      {...props}
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}
