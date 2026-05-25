import { useState, FormEvent } from 'react';
import { apiClient } from '../../api/client';

interface LoginProps {
  onLogin: () => void;
  onSwitchToSignup: () => void;
}

export function Login({ onLogin, onSwitchToSignup }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      // Handle validation errors (422) which return detail as array
      let errorMessage = 'Invalid email or password';
      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;
        if (Array.isArray(detail) && detail.length > 0) {
          // Extract message from first validation error
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
    <div className="app-surface flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-100 via-blue-50 to-indigo-100 p-4">
      <div className="glass-card w-full max-w-md rounded-2xl border border-blue-200/70 bg-white/90 p-8 shadow-2xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-blue-600">Job Scraper</h1>
          <p className="mt-2 text-sm text-slate-600">Duplicate prevention system</p>
        </div>
        <h2 className="mb-8 text-center text-xl font-bold text-slate-900">Sign In</h2>
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
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold text-slate-900" htmlFor="password">
              Password
            </label>
            <input
              className="blue-outline-input w-full rounded-lg bg-white px-4 py-2.5 text-sm text-slate-900 outline-none"
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
              {loading ? 'Signing In...' : 'Sign In'}
            </button>
          </div>

          <div className="text-center text-sm text-slate-700">
            Don't have an account?{' '}
            <button
              type="button"
              onClick={onSwitchToSignup}
              className="font-semibold text-blue-600 hover:text-blue-700 transition"
            >
              Sign Up
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
