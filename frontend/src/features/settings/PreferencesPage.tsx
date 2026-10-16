import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Briefcase,
  FileText,
  Gauge,
  Globe2,
  KeyRound,
  type LucideIcon,
  MessageSquareCode,
  RotateCw,
  Search,
  SlidersHorizontal,
  Target,
  UserRoundCheck,
} from 'lucide-react';
import { HeroStat, PageLayout } from '@/components/app/PageLayout';
import { PAGE_TABS_LIST, PAGE_TABS_TRIGGER } from '@/components/app/pageTabs';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { UserSettings } from '@/types/settings';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { AiKeysTab } from './AiKeysTab';
import { ApplicationDetailsTab } from './ApplicationDetailsTab';
import { JobSearchTab } from './JobSearchTab';
import { MatchingTab } from './MatchingTab';
import { PromptsTab } from './PromptsTab';
import { useSettingsQuery } from './queries';

const TABS = [
  { value: 'job-search', label: 'Job search' },
  { value: 'matching', label: 'Matching' },
  { value: 'application', label: 'Application details' },
  { value: 'ai', label: 'AI & keys' },
  { value: 'prompts', label: 'Prompts', advanced: true },
] as const;

type TabId = (typeof TABS)[number]['value'];
const DEFAULT_TAB: TabId = 'job-search';
const isTabId = (v: string | null): v is TabId => TABS.some((t) => t.value === v);

const TAB_ICON: Record<TabId, LucideIcon> = {
  'job-search': Search,
  matching: Target,
  application: UserRoundCheck,
  ai: KeyRound,
  prompts: MessageSquareCode,
};

const WORK_MODE_LABEL: Record<string, string> = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Onsite' };

function SettingsSummary({ settings }: { settings: UserSettings }) {
  const modes = settings.work_mode_preferences ?? [];
  const countries = settings.country_preferences ?? [];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Current preferences">
      <HeroStat
        icon={FileText}
        label="Apply with"
        value={settings.application_resume_source === 'original' ? 'Original résumé' : 'Tailored résumé'}
      />
      <HeroStat
        icon={Gauge}
        label="Minimum match"
        value={settings.min_match_score ? `${settings.min_match_score} and up` : 'Any score'}
        tone="bg-match-strong/10 text-match-strong"
      />
      <HeroStat
        icon={Briefcase}
        label="Work mode"
        value={modes.length ? modes.map((m) => WORK_MODE_LABEL[m] ?? m).join(', ') : 'Any mode'}
        tone="bg-chart-4/10 text-chart-4"
      />
      <HeroStat
        icon={Globe2}
        label="Countries"
        value={
          countries.length
            ? countries.slice(0, 3).join(', ').toUpperCase() + (countries.length > 3 ? ` +${countries.length - 3}` : '')
            : 'All countries'
        }
        tone="bg-chart-2/10 text-chart-2"
      />
    </div>
  );
}

export function PreferencesPage() {
  const query = useSettingsQuery();
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

  return (
    <PageLayout
      title="Preferences"
      description="How NAO finds, scores, and prepares jobs for you."
      variant="hero"
      icon={SlidersHorizontal}
      meta={query.data ? <SettingsSummary settings={query.data} /> : undefined}
    >
      {query.isPending ? (
        <div className="space-y-6" aria-busy="true" aria-label="Loading preferences">
          <Skeleton className="h-10 w-full max-w-lg rounded-xl" />
          <Skeleton className="h-56 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{extractApiErrorMessage(query.error, 'Failed to load preferences.')}</AlertTitle>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              <RotateCw />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <Tabs value={tab} onValueChange={(v) => isTabId(String(v)) && selectTab(String(v) as TabId)} className="gap-6">
          <div className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList aria-label="Preference sections" className={PAGE_TABS_LIST}>
              {TABS.map((t) => {
                const Icon = TAB_ICON[t.value];
                return (
                <TabsTrigger key={t.value} value={t.value} className={PAGE_TABS_TRIGGER}>
                  <Icon aria-hidden />
                  {t.label}
                  {'advanced' in t ? (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                      Advanced
                    </Badge>
                  ) : null}
                  {dirtyTabs[t.value] ? (
                    <>
                      <span aria-hidden className="size-1.5 rounded-full bg-brand" />
                      <span className="sr-only">(unsaved changes)</span>
                    </>
                  ) : null}
                </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          {TABS.map((t) => (
            <TabsContent key={t.value} value={t.value} keepMounted>
              {visited.has(t.value) ? (
                <TabPanel id={t.value} active={tab === t.value} onDirtyChange={reporters[t.value]} settings={query.data} />
              ) : null}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </PageLayout>
  );
}

function TabPanel({
  id,
  ...props
}: {
  id: TabId;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  settings: UserSettings;
}) {
  switch (id) {
    case 'job-search':
      return <JobSearchTab {...props} />;
    case 'matching':
      return <MatchingTab {...props} />;
    case 'application':
      return <ApplicationDetailsTab active={props.active} onDirtyChange={props.onDirtyChange} />;
    case 'ai':
      return <AiKeysTab settings={props.settings} />;
    case 'prompts':
      return <PromptsTab {...props} />;
  }
}
