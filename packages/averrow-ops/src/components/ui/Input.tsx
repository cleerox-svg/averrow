import { cn } from '@/lib/cn';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn('rounded-md text-sm', className)}
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border-base)',
        color: 'var(--text-primary)',
        padding: '8px 12px',
        outline: 'none',
        transition: 'var(--transition-fast)',
        width: '100%',
      }}
      onFocus={e => {
        e.currentTarget.style.borderColor = 'var(--amber-border)';
        e.currentTarget.style.boxShadow = '0 0 0 2px var(--amber-glow)';
      }}
      onBlur={e => {
        e.currentTarget.style.borderColor = 'var(--border-base)';
        e.currentTarget.style.boxShadow = 'none';
      }}
      {...props}
    />
  );
}
