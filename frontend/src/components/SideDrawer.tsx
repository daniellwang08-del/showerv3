import type { FC } from 'react';
import { X, Home, User } from 'lucide-react';

type Props = {
  open: boolean;
  onClose: () => void;
  onMyProfile: () => void;
};

export const SideDrawer: FC<Props> = ({ open, onClose, onMyProfile }) => {
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
            <Home className="h-5 w-5 text-blue-600" />
            <span className="text-sm font-semibold text-slate-900">Navigation</span>
          </div>
          <button
            aria-label="Close drawer"
            onClick={onClose}
            className="rounded-md p-1 text-slate-600 hover:bg-blue-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="p-3 flex-1 overflow-auto">
          <ul className="flex flex-col gap-1">
            <li>
              <button
                type="button"
                onClick={() => { onMyProfile(); onClose(); }}
                className="flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left text-sm text-slate-700 transition hover:border-blue-200 hover:bg-blue-50/80"
              >
                <User className="h-4 w-4 text-slate-500 flex-shrink-0" />
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
