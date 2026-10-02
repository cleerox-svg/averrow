import { Sun, Moon, Laptop } from 'lucide-react';
import { useTheme } from '@/design-system/hooks';

// Sidebar header theme cycler. Single click cycles
// auto → dark → light → auto. Mirror of the tenant sidebar's
// toggle so both products carry the same canonical surface
// (per SHARED_LOGIN_SPEC). Profile Preferences is the explicit
// picker; this button is the quick-access affordance.
export function ThemeCycleButton() {
  const { theme, cycle } = useTheme();
  const Icon = theme === 'auto' ? Laptop : theme === 'light' ? Sun : Moon;
  const label =
    theme === 'auto'  ? 'Theme: auto (follows OS) — click for dark' :
    theme === 'dark'  ? 'Theme: dark — click for light' :
                        'Theme: light — click for auto';
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      style={{
        padding: 6,
        borderRadius: 6,
        background: 'transparent',
        border: 'none',
        color: 'var(--text-tertiary)',
        cursor: 'pointer',
        transition: 'color 120ms ease',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)'; }}
    >
      <Icon size={14} />
    </button>
  );
}
