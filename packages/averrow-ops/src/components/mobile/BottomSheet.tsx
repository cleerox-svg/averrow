import { useState, type ReactNode } from 'react';

type SheetState = 'peek' | 'half' | 'full';

interface MobileBottomSheetProps {
  peekHeight?: number;
  halfHeight?: number;
  fullHeight?: number;
  headerLeft: ReactNode;
  headerRight?: ReactNode;
  children: ReactNode;
  defaultState?: SheetState;
}

const HEADER_HEIGHT = 52;

const CYCLE: Record<SheetState, SheetState> = {
  peek: 'half',
  half: 'full',
  full: 'peek',
};

function heightForState(
  state: SheetState,
  peek: number,
  half: number,
  full: number,
): number {
  if (state === 'peek') return peek;
  if (state === 'half') return half;
  return full;
}

export function MobileBottomSheet({
  peekHeight = 90,
  halfHeight = 340,
  fullHeight = 500,
  headerLeft,
  headerRight,
  children,
  defaultState = 'half',
}: MobileBottomSheetProps) {
  const [sheetState, setSheetState] = useState<SheetState>(defaultState);

  const height = heightForState(sheetState, peekHeight, halfHeight, fullHeight);
  const contentHeight = height - HEADER_HEIGHT;

  return (
    <div
      className="absolute bottom-0 left-0 right-0 rounded-t-[14px] border-t border-bulkhead bg-instrument shadow-2xl transition-all duration-300 ease-out"
      style={{ height: `${height}px` }}
    >
      {/* Drag handle */}
      <div
        className="flex cursor-pointer items-center justify-center py-2.5"
        role="button"
        tabIndex={0}
        aria-label="Toggle sheet size"
        onClick={() => setSheetState(CYCLE[sheetState])}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSheetState(CYCLE[sheetState]);
          }
        }}
      >
        <div className="h-1 w-8 rounded-full bg-fuselage" />
      </div>

      {/* Header row */}
      <div className="flex items-center justify-between border-b border-bulkhead/25 px-4 pb-2">
        <div>{headerLeft}</div>
        {headerRight && <div>{headerRight}</div>}
      </div>

      {/* Scrollable content */}
      <div
        className="overflow-y-auto"
        style={{ height: `${Math.max(0, contentHeight)}px` }}
      >
        {children}
      </div>
    </div>
  );
}
