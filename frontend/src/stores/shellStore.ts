import { create } from 'zustand';

const STORAGE_KEY = 'nao-shell:v1';

type Persisted = {
  sidebarCollapsed: boolean;
  assistantDocked: boolean;
  recentJobs: RecentJob[];
  /** User the recent jobs belong to; another account signing in on this browser starts empty. */
  owner: string | null;
};

export type RecentJob = { id: string; title: string; company: string; at: number };

type ShellState = Persisted & {
  paletteOpen: boolean;
  mobileNavOpen: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (v: boolean) => void;
  setMobileNavOpen: (v: boolean) => void;
  setAssistantDocked: (v: boolean) => void;
  toggleAssistant: () => void;
  pushRecentJob: (job: Omit<RecentJob, 'at'>) => void;
  setOwner: (userId: string | null) => void;
};

function load(): Persisted {
  const fallback: Persisted = { sidebarCollapsed: false, assistantDocked: false, recentJobs: [], owner: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<Persisted>) } : fallback;
  } catch {
    return fallback;
  }
}

function save(s: Persisted) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sidebarCollapsed: s.sidebarCollapsed,
        assistantDocked: s.assistantDocked,
        recentJobs: s.recentJobs,
        owner: s.owner,
      }),
    );
  } catch {
    /* ignore quota errors */
  }
}

export const useShellStore = create<ShellState>((set, get) => {
  const patch = (p: Partial<ShellState>) => {
    set(p);
    save(get());
  };
  return {
    ...load(),
    paletteOpen: false,
    mobileNavOpen: false,
    setSidebarCollapsed: (v) => patch({ sidebarCollapsed: v }),
    toggleSidebar: () => patch({ sidebarCollapsed: !get().sidebarCollapsed }),
    setPaletteOpen: (v) => set({ paletteOpen: v }),
    setMobileNavOpen: (v) => set({ mobileNavOpen: v }),
    setAssistantDocked: (v) => patch({ assistantDocked: v }),
    toggleAssistant: () => patch({ assistantDocked: !get().assistantDocked }),
    pushRecentJob: (job) =>
      patch({
        recentJobs: [{ ...job, at: Date.now() }, ...get().recentJobs.filter((j) => j.id !== job.id)].slice(0, 8),
      }),
    setOwner: (userId) => {
      if (get().owner === userId) return;
      patch({ owner: userId, recentJobs: [] });
    },
  };
});
