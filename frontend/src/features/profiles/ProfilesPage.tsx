import { ProfilesManagementPage } from '../../components/ProfilesManagementPage';

export function ProfilesPage({ onBack }: { onBack: () => void }) {
  return <ProfilesManagementPage onBack={onBack} />;
}

