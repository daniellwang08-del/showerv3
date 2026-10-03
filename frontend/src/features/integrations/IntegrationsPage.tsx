import { useState, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { PageLayout } from '@/components/app/PageLayout';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { CardGrid, IntegrationCard, IntegrationCardError, IntegrationCardSkeleton } from './IntegrationCard';
import { GoogleSheetsSheet, SHEETS_BLURB, SHEETS_LOGO, SHEETS_NAME } from './GoogleSheetsSheet';
import { JobSiteSheet } from './JobSiteSheet';
import { PumbleSheet, PUMBLE_BLURB, PUMBLE_LOGO, PUMBLE_NAME } from './PumbleSheet';
import { useJobSites, usePumble, useSheets } from './queries';
import { errorDetail, jobSiteStatus, pumbleStatus, sheetsStatus } from './status';

type Active = { kind: 'job-site'; slug: string } | { kind: 'sheets' } | { kind: 'pumble' };

export function IntegrationsPage() {
  const jobSites = useJobSites();
  const sheets = useSheets();
  const pumble = usePumble();
  const [active, setActive] = useState<Active | null>(null);
  const [open, setOpen] = useState(false);

  const show = (next: Active) => {
    setActive(next);
    setOpen(true);
  };

  const plugins = [...(jobSites.data?.plugins ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  const connectionFor = (slug: string) => jobSites.data?.connections.find((c) => c.plugin_slug === slug);

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
  }

  return (
    <PageLayout
      title="Integrations"
      description="Pull openings from job sites into your pipeline, then post the best matches to Google Sheets or Pumble."
      width="wide"
    >
      <div className="space-y-10">
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

        <Group
          title="Job sites"
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
            <p className="rounded-xl border px-4 py-8 text-center text-sm text-muted-foreground">
              No job sites are available on this server yet.
            </p>
          ) : (
            <CardGrid>
              {plugins.map((plugin) => (
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
      </div>

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
      <div>
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}
