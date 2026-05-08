interface FilterChip {
  label: string;
  active: boolean;
  onClick: () => void;
}

interface MobileFilterChipsProps {
  filters: FilterChip[];
}

export function MobileFilterChips({ filters }: MobileFilterChipsProps) {
  return (
    <div className="flex gap-1">
      {filters.map((filter) => (
        <button
          key={filter.label}
          type="button"
          onClick={filter.onClick}
          className={`cursor-pointer rounded-[10px] border px-2 py-1 text-[8px] font-mono ${
            filter.active
              ? 'border-accent/35 bg-accent/10 text-accent'
              : 'border-bulkhead/35 text-white/55'
          }`}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}
