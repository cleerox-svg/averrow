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
      className="v4-theme-btn"
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
