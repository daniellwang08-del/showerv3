import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Globe, Inbox, type LucideIcon, PlugZap, RotateCw, Send } from 'lucide-react';
import { toast } from 'sonner';
import { HeroStat, PageLayout } from '@/components/app/PageLayout';
import { PAGE_TABS_LIST, PAGE_TABS_TRIGGER } from '@/components/app/pageTabs';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CardGrid, IntegrationCard, IntegrationCardError, IntegrationCardSkeleton } from './IntegrationCard';
import { GmailSheet, GMAIL_BLURB, GMAIL_LOGO, GMAIL_NAME } from './GmailSheet';
import { GoogleSheetsSheet, SHEETS_BLURB, SHEETS_LOGO, SHEETS_NAME } from './GoogleSheetsSheet';
import { JobSiteManagePanel } from './JobSiteManagePanel';
import { JobSiteSheet } from './JobSiteSheet';
import { PumbleSheet, PUMBLE_BLURB, PUMBLE_LOGO, PUMBLE_NAME } from './PumbleSheet';
import { invalidateGmail, useGmail, useJobSites, usePumble, useSheets } from './queries';
import { errorDetail, gmailStatus, jobSiteStatus, pumbleStatus, sheetsStatus } from './status';
import { useQueryClient } from '@tanstack/react-query';

const TABS = [
  { value: 'job-sites', label: 'Job sites' },
  { value: 'posting', label: 'Posting' },
  { value: 'inbox', label: 'Inbox & chat' },
] as const;

type TabId = (typeof TABS)[number]['value'];
const DEFAULT_TAB: TabId = 'job-sites';
const TAB_ICON: Record<TabId, LucideIcon> = { 'job-sites': Globe, posting: Send, inbox: Inbox };
const isTabId = (v: string | null): v is TabId => TABS.some((t) => t.value === v);

type Active =
  | { kind: 'job-site'; slug: string }
  | { kind: 'sheets' }
  | { kind: 'pumble' }
  | { kind: 'gmail' };

export function IntegrationsPage() {
  const jobSites = useJobSites();
  const sheets = useSheets();
  const pumble = usePumble();
  const gmail = useGmail();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab: TabId = isTabId(rawTab) ? rawTab : DEFAULT_TAB;
  const [active, setActive] = useState<Active | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const flag = params.get('gmail');
    if (!flag) return;
    if (flag === 'connected') {
      invalidateGmail(qc);
      toast.success('Gmail connected');
    } else if (flag === 'error') {
      const reason = params.get('reason')?.trim();
      toast.error(reason ? `Gmail connection failed (${reason})` : 'Gmail connection failed');
    }
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('gmail');
        next.delete('reason');
        if (!next.get('tab')) next.set('tab', 'inbox');
        return next;
      },
      { replace: true },
    );
  }, [params, qc, setParams]);

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

  const show = (next: Active) => {
    setActive(next);
    setOpen(true);
  };

  const plugins = [...(jobSites.data?.plugins ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  const connectionFor = (slug: string) => jobSites.data?.connections.find((c) => c.plugin_slug === slug);
  const connected = plugins.flatMap((plugin) => {
    const connection = connectionFor(plugin.slug);
    return connection && plugin.connectable ? [{ plugin, connection }] : [];
  });
  const available = plugins.filter((plugin) => !connected.some((c) => c.plugin.slug === plugin.slug));

  const siteKinds = connected.map(({ plugin, connection }) => jobSiteStatus(plugin, connection).kind);
  const postingKinds = [sheets.data && sheetsStatus(sheets.data).kind, pumble.data && pumbleStatus(pumble.data).kind];
  const inboxKinds = [gmail.data && gmailStatus(gmail.data).kind];
  const countLive = (kinds: unknown[]) => kinds.filter((k) => k === 'connected' || k === 'attention').length;
  const tabCount: Record<TabId, number> = {
    'job-sites': connected.length,
    posting: countLive(postingKinds),
    inbox: countLive(inboxKinds),
  };
  const attention = [...siteKinds, ...postingKinds, ...inboxKinds].filter((k) => k === 'attention').length;
  const newJobs = connected.reduce((n, c) => n + (c.connection.last_new_jobs ?? 0), 0);

  const meta = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <HeroStat
        icon={Globe}
        label="Job sites connected"
        value={jobSites.data ? `${connected.length} of ${plugins.length}` : '-'}
      />
      <HeroStat icon={PlugZap} label="New from last syncs" value={jobSites.data ? newJobs : '-'} tone="bg-chart-4/10 text-chart-4" />
      <HeroStat icon={Send} label="Posting destinations" value={`${tabCount.posting} of 2`} tone="bg-chart-2/10 text-chart-2" />
      <HeroStat
        icon={AlertTriangle}
        label="Need attention"
        value={attention}
        tone={attention ? 'bg-status-preparing/15 text-status-preparing' : 'bg-muted text-muted-foreground'}
      />
    </div>
  );

  let sheetBody: ReactNode = null;
  if (active?.kind === 'job-site') {
    const plugin = plugins.find((p) => p.slug === active.slug);
    if (plugin) {
      sheetBody = (
        <JobSiteSheet
          key={plugin.slug}
          plugin={plugin}
          connection={connectionFor(plugin.slug)}
          onClose={() => setOpen(false)}
        />
      );
    }
  } else if (active?.kind === 'sheets' && sheets.data) {
    sheetBody = <GoogleSheetsSheet data={sheets.data} />;
  } else if (active?.kind === 'pumble' && pumble.data) {
    sheetBody = <PumbleSheet data={pumble.data} />;
  } else if (active?.kind === 'gmail' && gmail.data) {
    sheetBody = <GmailSheet data={gmail.data} />;
  }

  return (
    <PageLayout
      title="Integrations"
      description="Connect job boards, posting destinations, and read-only inbox sources."
      width="wide"
      variant="hero"
      icon={PlugZap}
      meta={meta}
    >
      <Tabs value={tab} onValueChange={(v) => isTabId(String(v)) && selectTab(String(v) as TabId)} className="gap-6">
        <div className="no-scrollbar -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList aria-label="Integration sections" className={PAGE_TABS_LIST}>
            {TABS.map((t) => {
              const Icon = TAB_ICON[t.value];
              return (
                <TabsTrigger key={t.value} value={t.value} className={PAGE_TABS_TRIGGER}>
                  <Icon aria-hidden />
                  {t.label}
                  {tabCount[t.value] > 0 ? (
                    <span
                      aria-hidden
                      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-status-ready/15 px-1 text-[10px] font-semibold text-status-ready tabular-nums"
                    >
                      {tabCount[t.value]}
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value="job-sites" className="space-y-10">
          {connected.length > 0 ? (
            <Group
              title="Your job sites"
              description="Each connected site syncs on its own schedule. Sync now runs it right away; progress also shows at the top of the Jobs page."
            >
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {connected.map(({ plugin, connection }) => (
                  <JobSiteManagePanel
                    key={plugin.slug}
                    plugin={plugin}
                    connection={connection}
                    onManage={() => show({ kind: 'job-site', slug: plugin.slug })}
                  />
                ))}
              </div>
            </Group>
          ) : null}

          <Group
            title={connected.length > 0 ? 'Add a job site' : 'Job sites'}
            description="Connect boards with your account, an API key, or a public feed. Account sites open in a new tab and connect automatically if you're already signed in."
          >
            {jobSites.isPending ? (
              <CardGrid>
                {Array.from({ length: 6 }, (_, i) => (
                  <IntegrationCardSkeleton key={i} />
                ))}
              </CardGrid>
            ) : jobSites.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Couldn't load job sites</AlertTitle>
                <AlertDescription>{errorDetail(jobSites.error, 'Failed to load job sites.')}</AlertDescription>
                <AlertAction>
                  <Button variant="outline" size="sm" onClick={() => void jobSites.refetch()}>
                    <RotateCw />
                    Retry
                  </Button>
                </AlertAction>
              </Alert>
            ) : plugins.length === 0 ? (
              <p className="rounded-2xl border border-dashed bg-card/60 px-4 py-8 text-center text-sm text-muted-foreground backdrop-blur-sm">
                No job sites are available on this server yet.
              </p>
            ) : available.length === 0 ? (
              <p className="rounded-2xl border border-dashed bg-card/60 px-4 py-8 text-center text-sm text-muted-foreground backdrop-blur-sm">
                Every available job site is connected.
              </p>
            ) : (
              <CardGrid>
                {available.map((plugin) => (
                  <IntegrationCard
                    key={plugin.slug}
                    name={plugin.name}
                    description={plugin.blurb}
                    logoSrc={plugin.logo_src}
                    status={jobSiteStatus(plugin, connectionFor(plugin.slug))}
                    onOpen={() => show({ kind: 'job-site', slug: plugin.slug })}
                  />
                ))}
              </CardGrid>
            )}
          </Group>
        </TabsContent>

        <TabsContent value="posting" className="space-y-10">
          <Group title="Post matching jobs" description="After jobs are scored, auto-post matching URLs to a spreadsheet or a chat channel.">
            <CardGrid>
              {sheets.isPending ? (
                <IntegrationCardSkeleton />
              ) : sheets.isError ? (
                <IntegrationCardError
                  name={SHEETS_NAME}
                  message={errorDetail(sheets.error, 'Failed to load Google Sheets settings.')}
                  onRetry={() => void sheets.refetch()}
                />
              ) : (
                <IntegrationCard
                  name={SHEETS_NAME}
                  description={SHEETS_BLURB}
                  logoSrc={SHEETS_LOGO}
                  status={sheetsStatus(sheets.data)}
                  onOpen={() => show({ kind: 'sheets' })}
                />
              )}
              {pumble.isPending ? (
                <IntegrationCardSkeleton />
              ) : pumble.isError ? (
                <IntegrationCardError
                  name={PUMBLE_NAME}
                  message={errorDetail(pumble.error, 'Failed to load Pumble settings.')}
                  onRetry={() => void pumble.refetch()}
                />
              ) : (
                <IntegrationCard
                  name={PUMBLE_NAME}
                  description={PUMBLE_BLURB}
                  logoSrc={PUMBLE_LOGO}
                  status={pumbleStatus(pumble.data)}
                  onOpen={() => show({ kind: 'pumble' })}
                />
              )}
            </CardGrid>
          </Group>
        </TabsContent>

        <TabsContent value="inbox" className="space-y-10">
          <Group
            title="Mail and messaging"
            description="Read-only connections for searching important messages. NAO does not send mail or post chat on your behalf from this tab."
          >
            <CardGrid>
              {gmail.isPending ? (
                <IntegrationCardSkeleton />
              ) : gmail.isError ? (
                <IntegrationCardError
                  name={GMAIL_NAME}
                  message={errorDetail(gmail.error, 'Failed to load Gmail settings.')}
                  onRetry={() => void gmail.refetch()}
                />
              ) : (
                <IntegrationCard
                  name={GMAIL_NAME}
                  description={GMAIL_BLURB}
                  logoSrc={GMAIL_LOGO}
                  status={gmailStatus(gmail.data)}
                  onOpen={() => show({ kind: 'gmail' })}
                />
              )}
              <IntegrationCard
                name="Outlook"
                description="Search Microsoft Outlook / Microsoft 365 mail. Coming soon."
                status={{ kind: 'unavailable', detail: 'Not available yet' }}
                onOpen={() => toast.message('Outlook integration is coming soon')}
              />
              <IntegrationCard
                name="Slack"
                description="Search Slack messages you can already access. Coming soon."
                status={{ kind: 'unavailable', detail: 'Not available yet' }}
                onOpen={() => toast.message('Slack integration is coming soon')}
              />
            </CardGrid>
          </Group>
        </TabsContent>
      </Tabs>

      <Sheet open={open && sheetBody !== null} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        >
          {sheetBody}
        </SheetContent>
      </Sheet>
    </PageLayout>
  );
}

function Group({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const id = `integrations-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex items-start gap-2.5 px-1">
        <span aria-hidden className="mt-1.5 h-4 w-1 shrink-0 rounded-full bg-gradient-to-b from-brand to-brand/30" />
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
