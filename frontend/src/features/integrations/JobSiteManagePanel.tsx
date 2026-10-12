import { ExternalLink, KeyRound, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import type { JobSiteConnection, JobSitePlugin } from '@/api/jobSitesApi';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { IntegrationLogo, StatusBadge } from './IntegrationCard';
import { jobSiteStatus, parseServerDate, relativeTime } from './status';
import { SyncProgress } from './SyncProgress';
import { useJobSiteControls } from './useJobSiteControls';

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular-nums" title={title}>
        {value}
      </dd>
    </div>
  );
}

/** Inline sync management for one connected site: schedule, Sync now, live progress, last results. */
export function JobSiteManagePanel({
  plugin,
  connection,
  onManage,
}: {
  plugin: JobSitePlugin;
  connection: JobSiteConnection;
  onManage: () => void;
}) {
  const status = jobSiteStatus(plugin, connection);
  const { toggle, sync, enabled, reauth, waiting, fetching, canSync, nextSync } = useJobSiteControls(plugin, connection);
  const synced = parseServerDate(connection.last_synced_at);
  const searchLink = plugin.credential_fields
    .filter((f) => !f.secret)
    .map((f) => connection.credential_hints?.[f.key])
    .find((v) => v && /^https?:\/\//.test(v));
  const switchId = `panel-auto-sync-${plugin.slug}`;

  let schedule = 'Paused';
  if (reauth) schedule = 'Stopped';
  else if (enabled) schedule = nextSync ? `Next ${nextSync}` : 'Due now';

  return (
    <article aria-label={plugin.name} className="flex flex-col rounded-xl border bg-card">
      <div className="flex items-start gap-3 p-4 pb-3">
        <IntegrationLogo name={plugin.name} src={plugin.logo_src} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-sm font-medium break-words">{plugin.name}</h3>
            <StatusBadge kind={status.kind} />
          </div>
          <p
            className={cn(
              'mt-0.5 line-clamp-2 text-xs tabular-nums text-muted-foreground',
              status.kind === 'attention' && 'text-destructive',
            )}
          >
            {status.detail ?? ''}
          </p>
        </div>
      </div>

      <div className="space-y-3 px-4 pb-4">
        {connection.sync ? (
          <SyncProgress activity={[connection.sync]} className="rounded-lg bg-brand-soft/40 px-3 py-2" />
        ) : null}

        <dl className="grid grid-cols-3 gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
          <Stat label="Last sync" value={relativeTime(connection.last_synced_at) ?? 'Not yet'} title={synced?.toLocaleString()} />
          <Stat label="New jobs" value={connection.last_new_jobs != null ? String(connection.last_new_jobs) : '-'} />
          <Stat label="Schedule" value={schedule} />
        </dl>

        {searchLink ? (
          <a
            href={searchLink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1 text-xs text-brand hover:underline"
            title={searchLink}
          >
            <ExternalLink className="size-3 shrink-0" />
            <span className="truncate">Syncing your saved search</span>
          </a>
        ) : null}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <div className="mr-auto flex items-center gap-2">
          <Switch
            id={switchId}
            checked={enabled}
            disabled={toggle.isPending || reauth}
            onCheckedChange={(next) => toggle.mutate(next)}
          />
          <label htmlFor={switchId} className="cursor-pointer text-sm">
            Auto-sync <span className="sr-only">{plugin.name}</span>
          </label>
        </div>
        {reauth ? (
          <Button size="sm" onClick={onManage} aria-label={`Reconnect ${plugin.name}`}>
            <KeyRound />
            Reconnect
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!canSync}
            onClick={() => sync.mutate()}
            aria-label={`Sync ${plugin.name} now`}
            title={
              !enabled
                ? 'Turn on auto-sync to sync now'
                : waiting
                  ? "Waiting for the site's request limit to reset"
                  : undefined
            }
          >
            {fetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {fetching ? 'Syncing' : 'Sync now'}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onManage} aria-label={`Manage ${plugin.name}`}>
          <Settings2 />
          Manage
        </Button>
      </div>
    </article>
  );
}
