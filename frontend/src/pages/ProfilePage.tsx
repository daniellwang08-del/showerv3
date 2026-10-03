import { ProfilesPage } from '../features/profiles/ProfilesPage';
import type { AuthUser } from '../hooks/useAuth';

interface ProfilePageProps {
  user: { id?: string; email?: string; name?: string | null } | null;
  onLogout: () => void;
  /** Refresh the authenticated user (updates the sidebar name after a save). */
  onProfileSaved?: () => void | Promise<unknown>;
}

export function ProfilePage({ user, onLogout, onProfileSaved }: ProfilePageProps) {
  return (
    <ProfilesPage
      onBack={() => {
        window.location.href = '/';
      }}
      onLogout={onLogout}
      userEmail={user?.email}
      userName={user?.name ?? undefined}
      onProfileSaved={onProfileSaved}
    />
  );
}
