interface DrillHeaderProps {
  title: string;
  badge?: string;
  onBack: () => void;
}

export function DrillHeader({ title, badge, onBack }: DrillHeaderProps) {
  return (
    <div className="fixed top-0 left-0 right-0 z-40 flex items-center gap-2.5 border-b border-bulkhead bg-[#060A14] px-4 py-3.5">
      <button
        type="button"
        onClick={onBack}
        className="bg-transparent text-[rgba(255,255,255,0.60)] text-base cursor-pointer p-0 leading-none"
        aria-label="Go back"
      >
        ←
      </button>
      <span className="text-xs font-mono font-bold tracking-wider text-[rgba(255,255,255,0.92)]">
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
