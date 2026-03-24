import { useState, FormEvent } from 'react';
import { apiClient } from '../api/client';

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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-purple-50 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-lg">
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
              className="w-full rounded border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-200"
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
              className="w-full rounded border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-200"
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
              className="w-full rounded-lg bg-gradient-to-r from-blue-500 to-purple-500 px-4 py-2.5 font-semibold text-white hover:from-blue-600 hover:to-purple-600 transition disabled:opacity-70 disabled:cursor-not-allowed"
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
