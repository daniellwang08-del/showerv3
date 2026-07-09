import { ProfilesManagementPage } from '../../components/extraction/ProfilesManagementPage';

type Props = {
  onBack: () => void;
  onLogout: () => void;
  userEmail?: string | null;
  userName?: string | null;
  onProfileSaved?: () => void | Promise<unknown>;
};

export function ProfilesPage({ onBack, userEmail, onProfileSaved }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 text-slate-900">
      <ProfilesManagementPage onBack={onBack} userEmail={userEmail} onProfileSaved={onProfileSaved} />
    </div>
  );
}
