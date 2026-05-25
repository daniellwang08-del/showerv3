import { Login } from '../components/extraction/Login';

interface LoginPageProps {
  onLogin: () => void;
  onSwitchToSignup: () => void;
}

export function LoginPage({ onLogin, onSwitchToSignup }: LoginPageProps) {
  return <Login onLogin={onLogin} onSwitchToSignup={onSwitchToSignup} />;
}
