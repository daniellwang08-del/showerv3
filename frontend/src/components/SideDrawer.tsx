import type { FC } from 'react';
import { X, Home, User, LayoutGrid } from 'lucide-react';

type Props = {
  open: boolean;
  onClose: () => void;
  onMyProfile: () => void;
  onGoDashboard?: () => void;
  activeItem?: 'dashboard' | 'profile';
};

export const SideDrawer: FC<Props> = ({
  open,
  onClose,
  onMyProfile,
  onGoDashboard,
  activeItem = 'dashboard',
}) => {
  const itemBase =
    'flex w-full items-center gap-3 rounded-xl border px-2.5 py-2.5 text-left text-sm font-medium transition duration-200';
  const idle = 'border-transparent text-slate-700 hover:border-blue-200/80 hover:bg-blue-50/90';
  const active = 'border-blue-300/70 bg-gradient-to-r from-blue-50 to-indigo-50/80 text-blue-900 shadow-sm';

  return (
    <aside
      className={`z-20 flex-shrink-0 overflow-hidden transition-all duration-300 ease-out border-r border-blue-200/60 bg-white/70 backdrop-blur-xl shadow-xl ${
        open ? 'w-56' : 'w-0'
      }`}
      aria-hidden={!open}
    >
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-blue-200/60">
          <div className="flex items-center gap-2">
            <LayoutGrid className="h-5 w-5 text-blue-600" />
            <span className="text-sm font-semibold text-slate-900">Navigation</span>
          </div>
          <button
            aria-label="Close drawer"
            onClick={onClose}
            className="rounded-md p-1 text-slate-600 hover:bg-blue-100 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="p-3 flex-1 overflow-auto">
          <ul className="flex flex-col gap-1.5">
            {onGoDashboard && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onGoDashboard();
                    onClose();
                  }}
                  className={`${itemBase} ${activeItem === 'dashboard' ? active : idle}`}
                >
                  <Home className={`h-4 w-4 flex-shrink-0 ${activeItem === 'dashboard' ? 'text-blue-600' : 'text-slate-500'}`} />
                  Dashboard
                </button>
              </li>
            )}
            <li>
              <button
                type="button"
                onClick={() => {
                  onMyProfile();
                  onClose();
                }}
                className={`${itemBase} ${activeItem === 'profile' ? active : idle}`}
              >
                <User className={`h-4 w-4 flex-shrink-0 ${activeItem === 'profile' ? 'text-blue-600' : 'text-slate-500'}`} />
                My profile
              </button>
            </li>
          </ul>
        </nav>

        <div className="p-3 text-xs text-slate-500 border-t border-blue-200/60">
          <div>v1.0</div>
        </div>
      </div>
    </aside>
  );
};

export default SideDrawer;
