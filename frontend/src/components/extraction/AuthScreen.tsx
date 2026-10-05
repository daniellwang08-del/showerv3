import { useState } from 'react';
import { AuthShell } from './AuthShell';
import { errorBoxClass } from './authStyles';
import { LoginForm } from './LoginForm';
import { SignupForm } from './SignupForm';

type AuthMode = 'login' | 'signup';

interface AuthScreenProps {
  onAuthSuccess: () => void;
  initialMode?: AuthMode;
  /**
   * When provided, the URL owns the mode: the switch links call this instead of
   * flipping local state, so /login and /signup stay shareable and reloadable.
   */
  onModeChange?: (mode: AuthMode) => void;
  /** Kept for call-site compatibility; home is always the landing header brand. */
  homeTo?: string;
  /** Why the previous session ended (e.g. the signup was declined). */
  notice?: string | null;
}

export function AuthScreen({
  onAuthSuccess,
  initialMode = 'login',
  onModeChange,
  notice,
}: AuthScreenProps) {
  const [localMode, setLocalMode] = useState<AuthMode>(initialMode);
  const mode = onModeChange ? initialMode : localMode;

  const switchTo = (next: AuthMode) => {
    if (onModeChange) onModeChange(next);
    else setLocalMode(next);
  };

  return (
    <AuthShell mode={mode} onModeChange={switchTo}>
      {notice && mode === 'login' && (
        <p role="alert" className={`${errorBoxClass} mb-4`}>
          {notice}
        </p>
      )}
      <div key={mode} className="auth-form-swap">
        {mode === 'login' ? (
          <LoginForm onLogin={onAuthSuccess} onSwitchToSignup={() => switchTo('signup')} />
        ) : (
          <SignupForm onSignup={onAuthSuccess} onSwitchToLogin={() => switchTo('login')} />
        )}
      </div>
    </AuthShell>
  );
}
