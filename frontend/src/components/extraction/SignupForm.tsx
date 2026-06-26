import { useMemo, useState, FormEvent } from 'react';
import { Mail, Lock, Check, X, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { apiClient } from '../../api/client';
import {
  errorBoxClass,
  fieldIconClass,
  glassInputClass,
  glassLabelClass,
  primaryButtonClass,
} from './authStyles';

interface SignupFormProps {
  onSignup: () => void;
  onSwitchToLogin: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignupForm({ onSignup, onSwitchToLogin }: SignupFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const emailValid = EMAIL_RE.test(email);
  const emailTouched = email.length > 0;

  const passwordChecks = useMemo(
    () => [
      { label: 'At least 8 characters', ok: password.length >= 8 },
      { label: 'An uppercase letter (A-Z)', ok: /[A-Z]/.test(password) },
      { label: 'A lowercase letter (a-z)', ok: /[a-z]/.test(password) },
      { label: 'A number (0-9)', ok: /\d/.test(password) },
    ],
    [password],
  );
  const passedCount = passwordChecks.filter((c) => c.ok).length;
  const passwordValid = passedCount === passwordChecks.length;
  const confirmTouched = confirmPassword.length > 0;
  const confirmValid = confirmTouched && confirmPassword === password;

  const canSubmit = emailValid && passwordValid && confirmValid && !loading;

  const strengthLabel = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][passedCount];
  const strengthColor = ['bg-rose-500', 'bg-rose-500', 'bg-amber-400', 'bg-sky-400', 'bg-emerald-400'][passedCount];

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!canSubmit) return;

    setLoading(true);
    try {
      const response = await apiClient.post('/auth/signup', { email, password });
      if (response.data.success) onSignup();
      else setError(response.data.message || 'Signup failed');
    } catch (err: any) {
      let errorMessage = 'Signup failed. Please try again.';
      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;
        if (Array.isArray(detail) && detail.length > 0) errorMessage = detail[0].msg || detail[0].type || 'Invalid input';
        else if (typeof detail === 'string') errorMessage = detail;
      }
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const emailBorder = !emailTouched
    ? 'border-white/25 focus:border-sky-300/70'
    : emailValid
      ? 'border-emerald-400/60 focus:border-emerald-300'
      : 'border-rose-400/60 focus:border-rose-300';

  const confirmBorder = !confirmTouched
    ? 'border-white/25 focus:border-sky-300/70'
    : confirmValid
      ? 'border-emerald-400/60 focus:border-emerald-300'
      : 'border-rose-400/60 focus:border-rose-300';

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <label className={glassLabelClass} htmlFor="signup-email">
          Email
        </label>
        <div className="group relative">
          <Mail size={18} className={fieldIconClass} aria-hidden="true" />
          <input
            className={`${glassInputClass} pr-10 ${emailBorder}`}
            id="signup-email"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {emailTouched && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              {emailValid ? (
                <Check size={18} className="text-emerald-400" />
              ) : (
                <X size={18} className="text-rose-400" />
              )}
            </span>
          )}
        </div>
        {emailTouched && !emailValid && (
          <p className="mt-1.5 text-xs font-semibold text-rose-200">Enter a valid email like name@example.com</p>
        )}
      </div>

      <div>
        <label className={glassLabelClass} htmlFor="signup-password">
          Password
        </label>
        <div className="group relative">
          <Lock size={18} className={fieldIconClass} aria-hidden="true" />
          <input
            className={`${glassInputClass} pr-11`}
            id="signup-password"
            type={showPassword ? 'text' : 'password'}
            placeholder="Create a strong password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/55 transition-colors hover:text-sky-300"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>

        {/* Strength meter + live requirement checklist */}
        {password.length > 0 && (
          <div className="mt-2.5 rounded-xl border border-white/15 bg-white/5 p-3 backdrop-blur-md">
            <div className="mb-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/15">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${strengthColor}`}
                  style={{ width: `${(passedCount / passwordChecks.length) * 100}%` }}
                />
              </div>
              <span className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-blue-50">
                <ShieldCheck size={13} className="text-sky-300" />
                {strengthLabel}
              </span>
            </div>
            <ul className="grid grid-cols-1 gap-1">
              {passwordChecks.map((c) => (
                <li
                  key={c.label}
                  className={`flex items-center gap-2 text-xs font-medium transition-colors ${
                    c.ok ? 'text-emerald-300' : 'text-blue-100/70'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full ${
                      c.ok ? 'bg-emerald-400/25' : 'bg-white/10'
                    }`}
                  >
                    {c.ok ? <Check size={11} strokeWidth={3.5} className="text-emerald-300" /> : <X size={10} className="text-white/45" />}
                  </span>
                  {c.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div>
        <label className={glassLabelClass} htmlFor="signup-confirm">
          Confirm Password
        </label>
        <div className="group relative">
          <Lock size={18} className={fieldIconClass} aria-hidden="true" />
          <input
            className={`${glassInputClass} pr-10 ${confirmBorder}`}
            id="signup-confirm"
            type={showPassword ? 'text' : 'password'}
            placeholder="Re-enter your password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
          {confirmTouched && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              {confirmValid ? (
                <Check size={18} className="text-emerald-400" />
              ) : (
                <X size={18} className="text-rose-400" />
              )}
            </span>
          )}
        </div>
        {confirmTouched && !confirmValid && (
          <p className="mt-1.5 text-xs font-semibold text-rose-200">Passwords do not match</p>
        )}
      </div>

      {error && <p className={errorBoxClass}>{error}</p>}

      <button className={primaryButtonClass} type="submit" disabled={!canSubmit}>
        <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
        {loading ? 'Creating Account...' : 'Create Account'}
      </button>

      <div className="text-center text-sm font-medium text-blue-50">
        Already have an account?{' '}
        <button
          type="button"
          onClick={onSwitchToLogin}
          className="font-bold text-sky-300 transition hover:text-sky-200"
        >
          Sign In
        </button>
      </div>
    </form>
  );
}
