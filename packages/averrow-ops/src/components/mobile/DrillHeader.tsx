interface DrillHeaderProps {
  title: string;
  badge?: string;
  onBack: () => void;
}

export function DrillHeader({ title, badge, onBack }: DrillHeaderProps) {
  return (
    <div
      className="fixed top-0 left-0 right-0 z-40 flex items-center gap-2.5 border-b border-[var(--border-strong)] px-4 py-3.5"
      style={{ background: 'var(--bg-page)' }}
    >
      <button
        type="button"
        onClick={onBack}
        className="bg-transparent text-[var(--text-secondary)] text-base cursor-pointer p-0 leading-none"
        aria-label="Go back"
      >
        ←
      </button>
      <span className="text-xs font-mono font-bold tracking-wider text-[var(--text-primary)]">
        {title}
      </span>
      {badge && (
        <span className="text-[9px] font-mono text-accent bg-accent/10 px-2 py-0.5 rounded-full">
          {badge}
        </span>
      )}
    </div>
  );
}
