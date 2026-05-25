import { useState, FormEvent } from 'react';
import { apiClient } from '../../api/client';

interface SignupProps {
  onSignup: () => void;
  onSwitchToLogin: () => void;
}

export function Signup({ onSignup, onSwitchToLogin }: SignupProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const validateForm = (): boolean => {
    if (!email || !password || !confirmPassword) {
      setError('All fields are required');
      return false;
    }

    if (!email.includes('@') || !email.includes('.')) {
      setError('Invalid email format');
      return false;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return false;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return false;
    }

    return true;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!validateForm()) return;

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

  return (
    <div className="app-surface flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-100 via-blue-50 to-indigo-100 p-4">
      <div className="glass-card w-full max-w-md rounded-2xl border border-blue-200/70 bg-white/90 p-8 shadow-2xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-blue-600">Job Scraper</h1>
          <p className="mt-2 text-sm text-slate-600">Duplicate prevention system</p>
        </div>
        <h2 className="mb-8 text-center text-xl font-bold text-slate-900">Create Account</h2>

        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label className="mb-2 block text-sm font-semibold text-slate-900" htmlFor="email">
              Email
            </label>
            <input
              className="blue-outline-input w-full rounded-lg bg-white px-4 py-2.5 text-sm text-slate-900 outline-none"
              id="email"
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="mb-5">
            <label className="mb-2 block text-sm font-semibold text-slate-900" htmlFor="password">
              Password
            </label>
            <input
              className="blue-outline-input w-full rounded-lg bg-white px-4 py-2.5 text-sm text-slate-900 outline-none"
              id="password"
              type="password"
              placeholder="•••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p className="mt-1 text-xs text-slate-600">Minimum 8 characters required</p>
          </div>

          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold text-slate-900" htmlFor="confirmPassword">
              Confirm Password
            </label>
            <input
              className="blue-outline-input w-full rounded-lg bg-white px-4 py-2.5 text-sm text-slate-900 outline-none"
              id="confirmPassword"
              type="password"
              placeholder="•••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>

          {error && <p className="mb-4 text-sm font-medium text-red-700">{error}</p>}

          <div className="mb-6">
            <button
              className="btn-blue-neon w-full rounded-lg px-4 py-2.5 font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-70"
              type="submit"
              disabled={loading}
            >
              {loading ? 'Creating Account...' : 'Sign Up'}
            </button>
          </div>

          <div className="text-center text-sm text-slate-700">
            Already have an account?{' '}
            <button
              type="button"
              onClick={onSwitchToLogin}
              className="font-semibold text-blue-600 hover:text-blue-700 transition"
            >
              Sign In
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
