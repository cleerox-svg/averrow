import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useTheme } from '@/lib/useTheme';

export function Shell() {
  // Mounting useTheme here applies the persisted theme on app boot
  // and keeps it synced with localStorage on toggle.
  useTheme();
  return (
    <div className="h-full flex bg-bg-page">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
