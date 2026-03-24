import { useEffect, useRef, useState } from 'react';
import { LogOut, Menu, User } from 'lucide-react';

type Props = {
  onToggleDrawer: () => void;
  onLogout: () => void;
  onMyProfile?: () => void;
  userEmail?: string | null;
  userName?: string | null;
};

function computeInitials(name?: string | null, email?: string | null) {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + (parts[parts.length - 1][0] || '')).toUpperCase();
  }
  if (!email) return 'U';
  const local = email.split('@')[0];
  const parts = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return local.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + (parts[1][0] || '')).toUpperCase();
}

function colorFromString(s?: string | null) {
  const colors = ['bg-indigo-500', 'bg-rose-500', 'bg-emerald-500', 'bg-yellow-500', 'bg-sky-500', 'bg-violet-500'];
  if (!s) return colors[0];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  const idx = Math.abs(h) % colors.length;
  return colors[idx];
}

export function Header({ onToggleDrawer, onLogout, onMyProfile, userEmail, userName }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const initials = computeInitials(userName, userEmail);
  const colorClass = colorFromString(userEmail ?? userName);

  return (
    <>
      <header className="w-full border-b border-slate-100 bg-white/60">
        <button
          onClick={onToggleDrawer}
          aria-label="Toggle navigation"
          className="fixed top-2 left-4 z-50 rounded-md bg-white/90 p-2 text-slate-800 hover:bg-white border border-slate-200 shadow-md transition"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="max-w-7xl mx-auto flex items-center justify-center px-4 py-3">
          <div className="text-lg font-semibold text-slate-900">Job Scraper</div>
        </div>

        <div className="fixed top-2 right-4 z-50" ref={ref}>
          <button
            onClick={() => setOpen((s) => !s)}
            className={`flex items-center justify-center rounded-full shadow-md hover:opacity-90 transition text-white font-semibold text-sm ${colorClass}`}
            style={{ width: 40, height: 40 }}
            aria-haspopup="true"
            aria-expanded={open}
          >
            {initials}
          </button>

          {open && (
            <div className="absolute right-0 mt-2 w-44 rounded-md border border-slate-100 bg-white shadow-lg">
              {onMyProfile && (
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    setOpen(false);
                    onMyProfile();
                  }}
                >
                  <User className="h-4 w-4 text-blue-600" />
                  My profile
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                onClick={onLogout}
              >
                <LogOut className="h-4 w-4 text-rose-600" />
                Logout
              </button>
            </div>
          )}
        </div>
      </header>
    </>
  );
}

export default Header;
