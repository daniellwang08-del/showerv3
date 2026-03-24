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
      className={`flex-shrink-0 overflow-hidden transition-all duration-200 ease-in-out bg-white border-r border-slate-100 shadow-sm ${
        open ? 'w-56' : 'w-0'
      }`}
      aria-hidden={!open}
    >
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Home className="h-5 w-5 text-blue-600" />
            <span className="text-sm font-semibold text-slate-900">Navigation</span>
          </div>
          <button
            aria-label="Close drawer"
            onClick={onClose}
            className="rounded-md p-1 text-slate-600 hover:bg-slate-100"
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
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left"
              >
                <User className="h-4 w-4 text-slate-500 flex-shrink-0" />
                My profile
              </button>
            </li>
          </ul>
        </nav>

        <div className="p-3 text-xs text-slate-500 border-t border-slate-100">
          <div>v1.0</div>
        </div>
      </div>
    </aside>
  );
};

export default SideDrawer;
