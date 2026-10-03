import { useEffect, useState, FormEvent } from 'react';
import { Mail, Lock, Check, Eye, EyeOff } from 'lucide-react';
import { apiClient } from '../../api/client';
import {
  errorBoxClass,
  fieldIconClass,
  glassInputClass,
  glassLabelClass,
  primaryButtonClass,
} from './authStyles';

interface LoginFormProps {
  onLogin: () => void;
  onSwitchToSignup: () => void;
}

const REMEMBER_EMAIL_KEY = 'nao_remember_email';

function readRememberedEmail(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(REMEMBER_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function LoginForm({ onLogin, onSwitchToSignup }: LoginFormProps) {
  const rememberedEmail = readRememberedEmail();
  const [email, setEmail] = useState(rememberedEmail);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(Boolean(rememberedEmail));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      if (remember && email.trim()) {
        window.localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim());
      } else if (!remember) {
        window.localStorage.removeItem(REMEMBER_EMAIL_KEY);
      }
    } catch {
      /* ignore storage failures */
    }
  }, [remember, email]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await apiClient.post('/auth/login', { email, password });
      if (response.data.success) {
        onLogin();
      } else {
        setError(response.data.message || 'Login failed');
      }
    } catch (err: any) {
      let errorMessage = 'Invalid email or password';
      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;
        if (Array.isArray(detail) && detail.length > 0) {
          errorMessage = detail[0].msg || detail[0].type || 'Invalid input';
        } else if (typeof detail === 'string') {
          errorMessage = detail;
        }
      }
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className={glassLabelClass} htmlFor="login-email">
          Email
        </label>
        <div className="group relative">
          <Mail size={18} className={fieldIconClass} aria-hidden="true" />
          <input
            className={glassInputClass}
            id="login-email"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
      </div>

      <div>
        <label className={glassLabelClass} htmlFor="login-password">
          Password
        </label>
        <div className="group relative">
          <Lock size={18} className={fieldIconClass} aria-hidden="true" />
          <input
            className={`${glassInputClass} pr-11`}
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-white/50 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6F9BFF]/70"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
      </div>

      <label className="group flex w-fit cursor-pointer select-none items-center gap-2.5 text-sm font-medium text-white/70">
        <span className="relative inline-flex h-5 w-5 items-center justify-center">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="peer sr-only"
          />
          <span className="absolute inset-0 rounded-md border border-white/25 bg-white/[0.04] transition-colors duration-200 group-hover:border-white/45 peer-checked:border-[#2C5BF5] peer-checked:bg-[#2C5BF5] peer-focus-visible:ring-2 peer-focus-visible:ring-[#6F9BFF]/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#070B1C]" />
          <Check
            size={13}
            strokeWidth={3.5}
            className="relative scale-50 text-white opacity-0 transition-all duration-200 peer-checked:scale-100 peer-checked:opacity-100"
          />
        </span>
        <span className="transition-colors group-hover:text-white">Remember me on this device</span>
      </label>

      {error && <p className={errorBoxClass}>{error}</p>}

      <button className={primaryButtonClass} type="submit" disabled={loading}>
        <span className="relative">{loading ? 'Signing in…' : 'Continue to workspace'}</span>
      </button>

      <p className="text-center text-sm text-white/60">
        New here?{' '}
        <button
          type="button"
          onClick={onSwitchToSignup}
          className="rounded font-semibold text-[#9DB9FF] transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6F9BFF]/70"
        >
          Create a free account
        </button>
      </p>
    </form>
  );
}
