import { useState } from 'react';
import { AuthShell } from './AuthShell';
import { LoginForm } from './LoginForm';
import { SignupForm } from './SignupForm';

type AuthMode = 'login' | 'signup';

interface AuthScreenProps {
  onAuthSuccess: () => void;
  initialMode?: AuthMode;
}

export function AuthScreen({ onAuthSuccess, initialMode = 'login' }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);

  return (
    <AuthShell>
      {/* key swap triggers a smooth crossfade; the shell/background stays put */}
      <div key={mode} className="auth-form-swap">
        {mode === 'login' ? (
          <LoginForm onLogin={onAuthSuccess} onSwitchToSignup={() => setMode('signup')} />
        ) : (
          <SignupForm onSignup={onAuthSuccess} onSwitchToLogin={() => setMode('login')} />
        )}
      </div>
    </AuthShell>
  );
}
