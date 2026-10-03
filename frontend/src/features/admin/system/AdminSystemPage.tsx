import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageLayout } from '@/components/app/PageLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { LlmKeysResponse, SystemSettingsResponse } from '@/types/admin';
import { BenchmarkTab } from './BenchmarkTab';
import { QueryError } from './fields';
import { JobSyncTab } from './JobSyncTab';
import { KeysTab } from './KeysTab';
import { LlmTab } from './LlmTab';
import { MatchEngineTab } from './MatchEngineTab';
import { PlatformTab } from './PlatformTab';
import { useLlmKeysQuery, useModelCatalog, useSystemSettingsQuery, type ModelCatalog } from './queries';
import { errDetail } from './settingsModel';
import { WorkersTab } from './WorkersTab';

const TABS = [
  { value: 'llm', label: 'LLM & models' },
  { value: 'keys', label: 'Keys' },
  { value: 'sync', label: 'Job sync' },
  { value: 'match', label: 'Match engine' },
  { value: 'workers', label: 'Workers & queues' },
  { value: 'benchmark', label: 'Benchmark' },
  { value: 'platform', label: 'Platform' },
] as const;

type TabId = (typeof TABS)[number]['value'];
const DEFAULT_TAB: TabId = 'llm';
const isTabId = (v: string | null): v is TabId => TABS.some((t) => t.value === v);

export function AdminSystemPage() {
  const settings = useSystemSettingsQuery();
  const llm = useLlmKeysQuery();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabId = isTabId(raw) ? raw : DEFAULT_TAB;

  // Panels mount on first visit and stay mounted so drafts survive tab switches.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set(visited).add(tab));

  const [dirtyTabs, setDirtyTabs] = useState<Partial<Record<TabId, boolean>>>({});
  const [reporters] = useState(
    () =>
      Object.fromEntries(
        TABS.map((t) => [
          t.value,
          (dirty: boolean) => setDirtyTabs((m) => (Boolean(m[t.value]) === dirty ? m : { ...m, [t.value]: dirty })),
        ]),
      ) as Record<TabId, (dirty: boolean) => void>,
  );

  const anyDirty = Object.values(dirtyTabs).some(Boolean);
  useEffect(() => {
    if (!anyDirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [anyDirty]);

  const selectTab = (next: TabId) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === DEFAULT_TAB) p.delete('tab');
        else p.set('tab', next);
        return p;
      },
      { replace: true },
    );

  const failed = settings.error ?? llm.error;

  return (
    <PageLayout
      title="System settings"
      description="Platform defaults, LLM providers and keys, job sync, match engine, and worker ops."
      width="wide"
    >
      {failed ? (
        <QueryError
          message={errDetail(failed, 'Failed to load system settings.')}
          onRetry={() => {
            if (settings.isError) void settings.refetch();
            if (llm.isError) void llm.refetch();
          }}
        />
      ) : !settings.data || !llm.data ? (
        <div className="space-y-6" aria-busy="true" aria-label="Loading system settings">
          <Skeleton className="h-8 w-full max-w-2xl" />
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : (
        <Loaded
          tab={tab}
          visited={visited}
          dirtyTabs={dirtyTabs}
          reporters={reporters}
          onSelect={selectTab}
          settings={settings.data}
          llm={llm.data}
        />
      )}
    </PageLayout>
  );
}

function Loaded({
  tab,
  visited,
  dirtyTabs,
  reporters,
  onSelect,
  settings,
  llm,
}: {
  tab: TabId;
  visited: Set<TabId>;
  dirtyTabs: Partial<Record<TabId, boolean>>;
  reporters: Record<TabId, (dirty: boolean) => void>;
  onSelect: (tab: TabId) => void;
  settings: SystemSettingsResponse;
  llm: LlmKeysResponse;
}) {
  const catalog = useModelCatalog(llm.keys, llm.bindings);
  return (
    <Tabs value={tab} onValueChange={(v) => isTabId(String(v)) && onSelect(String(v) as TabId)} className="gap-6">
      <div className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList aria-label="System settings sections" className="w-max">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="px-3">
              {t.label}
              {dirtyTabs[t.value] ? (
                <>
                  <span aria-hidden className="size-1.5 rounded-full bg-brand" />
                  <span className="sr-only">(unsaved changes)</span>
                </>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {TABS.map((t) => (
        <TabsContent key={t.value} value={t.value} keepMounted>
          {visited.has(t.value) ? (
            <TabPanel
              id={t.value}
              active={tab === t.value}
              onDirtyChange={reporters[t.value]}
              settings={settings}
              llm={llm}
              catalog={catalog}
            />
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function TabPanel({
  id,
  active,
  onDirtyChange,
  settings,
  llm,
  catalog,
}: {
  id: TabId;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  settings: SystemSettingsResponse;
  llm: LlmKeysResponse;
  catalog: ModelCatalog;
}) {
  switch (id) {
    case 'llm':
      return <LlmTab settings={settings} llm={llm} catalog={catalog} active={active} onDirtyChange={onDirtyChange} />;
    case 'keys':
      return <KeysTab settings={settings} llm={llm} />;
    case 'sync':
      return <JobSyncTab active={active} onDirtyChange={onDirtyChange} />;
    case 'match':
      return <MatchEngineTab settings={settings} active={active} onDirtyChange={onDirtyChange} />;
    case 'workers':
      return <WorkersTab settings={settings} active={active} onDirtyChange={onDirtyChange} />;
    case 'benchmark':
      return <BenchmarkTab settings={settings} catalog={catalog} />;
    case 'platform':
      return <PlatformTab settings={settings} active={active} onDirtyChange={onDirtyChange} />;
  }
}
