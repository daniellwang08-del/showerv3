import { useState } from 'react';
import { RefreshCw, ChevronDown, CheckCircle, AlertTriangle, Terminal } from 'lucide-react';
import type { SpiderInfo } from '../../types/scraper';

interface SyncButtonProps {
  syncing: boolean;
  spiders: SpiderInfo[];
  onSync: (spiderName?: string) => void;
}

export function SyncButton({ syncing, spiders, onSync }: SyncButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showCommandFor, setShowCommandFor] = useState<string | null>(null);

  return (
    <div className="relative inline-flex">
      <button
        disabled={syncing}
        onClick={() => onSync('all')}
        className="inline-flex items-center gap-2 rounded-l-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
        {syncing ? 'Syncing...' : 'Sync All'}
      </button>

      <button
        disabled={syncing}
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="inline-flex items-center rounded-r-lg border-l border-blue-500 bg-blue-600 px-2 py-2 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronDown size={16} />
      </button>

      {dropdownOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setDropdownOpen(false); setShowCommandFor(null); }} />
          <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded-lg border border-slate-200 bg-white shadow-lg py-1">
            <div className="px-3 py-1.5 text-xs font-medium text-slate-500 uppercase tracking-wider">
              Run individual spider
            </div>
            {spiders.map((spider) => {
              const needsAuth = spider.requires_auth && !spider.auth_configured;
              return (
                <div key={spider.name}>
                  <button
                    disabled={needsAuth}
                    onClick={() => {
                      if (!needsAuth) {
                        setDropdownOpen(false);
                        setShowCommandFor(null);
                        onSync(spider.name);
                      }
                    }}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors ${
                      needsAuth
                        ? 'text-slate-400 cursor-not-allowed'
                        : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className="flex-1 text-left">{spider.label}</span>
                    {spider.requires_auth && spider.auth_configured && (
                      <CheckCircle size={14} className="text-green-500 shrink-0" />
                    )}
                    {needsAuth && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 font-medium cursor-pointer hover:bg-red-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowCommandFor(showCommandFor === spider.name ? null : spider.name);
                        }}
                      >
                        <AlertTriangle size={10} />
                        Auth Required
                      </span>
                    )}
                    {spider.requires_auth && spider.auth_configured && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-medium">
                        Auth
                      </span>
                    )}
                  </button>
                  {needsAuth && showCommandFor === spider.name && spider.auth_setup_command && (
                    <div className="mx-3 mb-2 p-2 rounded bg-slate-800 text-slate-100">
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mb-1">
                        <Terminal size={10} />
                        Run this command to set up auth:
                      </div>
                      <code className="text-xs break-all select-all">{spider.auth_setup_command}</code>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
