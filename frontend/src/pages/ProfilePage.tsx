import { ProfilesPage } from '../features/profiles/ProfilesPage';
import type { AuthUser } from '../hooks/useAuth';

interface ProfilePageProps {
  user: { id?: string; email?: string; name?: string | null } | null;
  onLogout: () => void;
}

export function ProfilePage({ user, onLogout }: ProfilePageProps) {
  return (
    <ProfilesPage
      onBack={() => {
        window.location.href = '/scraper';
      }}
      onLogout={onLogout}
      userEmail={user?.email}
      userName={user?.name ?? undefined}
    />
  );
}
