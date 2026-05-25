import { Signup } from '../components/extraction/Signup';

interface SignupPageProps {
  onSignup: () => void;
  onSwitchToLogin: () => void;
}

export function SignupPage({ onSignup, onSwitchToLogin }: SignupPageProps) {
  return <Signup onSignup={onSignup} onSwitchToLogin={onSwitchToLogin} />;
}
