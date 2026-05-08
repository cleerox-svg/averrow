import { cn } from '@/lib/cn';

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full', className)}>{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      style={{ color: 'rgba(255,255,255,0.36)' }}
      className={cn(
      'font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left border-b border-white/[0.06]',
      className
    )}>
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={cn('px-3 py-2.5 text-sm border-b border-white/[0.03]', className)}>
      {children}
    </td>
  );
}
