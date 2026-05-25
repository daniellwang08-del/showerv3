import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

interface AppShellProps {
  userEmail?: string;
  userName?: string;
  onLogout: () => void;
}

export function AppShell({ userEmail, userName, onLogout }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar userEmail={userEmail} userName={userName} onLogout={onLogout} />
      <main className="flex-1 overflow-y-auto bg-slate-50">
        <Outlet />
      </main>
    </div>
  );
}
