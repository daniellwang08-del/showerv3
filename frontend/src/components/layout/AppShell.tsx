import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { AgentChat } from '../agent/AgentChat';
import { setAgentNavigator } from '../../lib/agentNavigation';

interface AppShellProps {
  userEmail?: string;
  userName?: string;
  onLogout: () => void;
}

export function AppShell({ userEmail, userName, onLogout }: AppShellProps) {
  const navigate = useNavigate();
  useEffect(() => {
    setAgentNavigator((path) => navigate(path));
    return () => setAgentNavigator(null);
  }, [navigate]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar userEmail={userEmail} userName={userName} onLogout={onLogout} />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50">
        <Outlet />
      </main>
      <AgentChat />
    </div>
  );
}
