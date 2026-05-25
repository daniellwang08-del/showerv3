import { useCallback, useState } from 'react';
import { ProfilesManagementPage } from '../../components/ProfilesManagementPage';
import Header from '../../components/Header';
import SideDrawer from '../../components/SideDrawer';

type Props = {
  onBack: () => void;
  onLogout: () => void;
  userEmail?: string | null;
  userName?: string | null;
};

export function ProfilesPage({ onBack, onLogout, userEmail, userName }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleMyProfile = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  return (
    <div className="app-surface flex h-[100dvh] flex-col overflow-hidden text-slate-900">
      <Header
        onToggleDrawer={() => setDrawerOpen((s) => !s)}
        onLogout={onLogout}
        onMyProfile={handleMyProfile}
        userEmail={userEmail ?? undefined}
        userName={userName ?? undefined}
      />

      <div className="flex min-h-0 flex-1">
        <SideDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onMyProfile={handleMyProfile}
          onGoDashboard={onBack}
          activeItem="profile"
        />

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-gradient-to-b from-blue-50/35 via-white/40 to-white/80 md:from-blue-50/50">
          <ProfilesManagementPage onBack={onBack} userEmail={userEmail} />
        </div>
      </div>
    </div>
  );
}
