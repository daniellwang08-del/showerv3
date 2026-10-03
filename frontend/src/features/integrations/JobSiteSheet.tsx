import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Circle,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Unplug,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  disconnectJobSite,
  syncJobSiteNow,
  updateJobSite,
  type JobSiteCatalog,
  type JobSiteConnection,
  type JobSitePlugin,
} from '@/api/jobSitesApi';
import { detectExtension } from '@/lib/extensionBridge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { integrationKeys, invalidateJobSites } from './queries';
import { InlineError, Section, SheetFrame } from './SheetFrame';
import { errorDetail, jobSiteStatus, parseServerDate, relativeTime } from './status';
import { useJobSiteConnect, type ConnectLogLine, type StepState } from './useJobSiteConnect';

function upsertConnection(qc: ReturnType<typeof useQueryClient>, row: JobSiteConnection) {
  qc.setQueryData<JobSiteCatalog>(integrationKeys.jobSites, (prev) =>
    prev
      ? { ...prev, connections: [...prev.connections.filter((c) => c.plugin_slug !== row.plugin_slug), row] }
      : prev,
  );
}

export function JobSiteSheet({
  plugin,
  connection,
  onClose,
}: {
  plugin: JobSitePlugin;
  connection: JobSiteConnection | undefined;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const status = jobSiteStatus(plugin, connection);
  const [reconnecting, setReconnecting] = useState(false);

  const onConnected = (row: JobSiteConnection) => {
    upsertConnection(qc, row);
    invalidateJobSites(qc);
    setReconnecting(false);
    toast.success(`${plugin.name} connected`, {
      description: 'First sync started. New jobs appear on your dashboard shortly.',
    });
  };

  let body;
  if (!plugin.connectable) {
    body = (
      <Alert>
        <AlertCircle />
        <AlertTitle>{plugin.name} can't be connected right now</AlertTitle>
        <AlertDescription>{plugin.unavailable_reason || 'This job site is not available.'}</AlertDescription>
      </Alert>
    );
  } else if (connection && !reconnecting) {
    body = (
      <ConnectedSite
        plugin={plugin}
        connection={connection}
        onReconnect={() => setReconnecting(true)}
        onDisconnected={onClose}
      />
    );
  } else {
    body = (
      <>
        <ConnectFlow key={plugin.slug} plugin={plugin} onConnected={onConnected} />
        {reconnecting ? (
          <Button variant="ghost" size="sm" className="mt-4" onClick={() => setReconnecting(false)}>
            Back
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <SheetFrame name={plugin.name} description={plugin.blurb} logoSrc={plugin.logo_src} status={status.kind}>
      {body}
      <p className="mt-6 text-xs text-muted-foreground">
        <a href={plugin.homepage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
          Visit {plugin.name}
          <ExternalLink className="size-3" />
        </a>
      </p>
    </SheetFrame>
  );
}

function ConnectedSite({
  plugin,
  connection,
  onReconnect,
  onDisconnected,
}: {
  plugin: JobSitePlugin;
  connection: JobSiteConnection;
  onReconnect: () => void;
  onDisconnected: () => void;
}) {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateJobSite(plugin.slug, { enabled }),
    onSuccess: (row) => {
      upsertConnection(qc, row);
      invalidateJobSites(qc);
      toast.success(row.enabled ? `Auto-sync resumed for ${plugin.name}` : `Auto-sync paused for ${plugin.name}`);
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to update this job site.')),
  });

  const sync = useMutation({
    mutationFn: () => syncJobSiteNow(plugin.slug),
    onSuccess: () => {
      toast.success('Sync started', { description: 'New jobs appear on your dashboard shortly.' });
      // The sync runs in the background; re-read counts once it has had time to land.
      window.setTimeout(() => invalidateJobSites(qc), 8000);
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to start the sync.')),
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectJobSite(plugin.slug),
    onSuccess: () => {
      qc.setQueryData<JobSiteCatalog>(integrationKeys.jobSites, (prev) =>
        prev ? { ...prev, connections: prev.connections.filter((c) => c.plugin_slug !== plugin.slug) } : prev,
      );
      invalidateJobSites(qc);
      toast.success(`${plugin.name} disconnected`);
      setConfirmOpen(false);
      onDisconnected();
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to disconnect this job site.')),
  });

  const enabled = toggle.isPending ? Boolean(toggle.variables) : connection.enabled;
  const synced = parseServerDate(connection.last_synced_at);
  const hints = Object.entries(connection.credential_hints ?? {});

  return (
    <div className="space-y-6">
      {connection.last_error ? (
        <InlineError title="The last sync failed">{connection.last_error}</InlineError>
      ) : null}

      <Field orientation="horizontal" className="rounded-xl border p-4">
        <div className="min-w-0 flex-1">
          <FieldLabel htmlFor={`auto-sync-${plugin.slug}`}>Auto-sync</FieldLabel>
          <FieldDescription className="mt-1 text-xs">
            Pull new openings from {plugin.name} into your pipeline automatically.
          </FieldDescription>
        </div>
        <Switch
          id={`auto-sync-${plugin.slug}`}
          checked={enabled}
          disabled={toggle.isPending}
          onCheckedChange={(next) => toggle.mutate(next)}
        />
      </Field>

      <Section
        title="Sync"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={sync.isPending || !enabled}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Sync now
          </Button>
        }
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Last sync</dt>
          <dd className="tabular-nums" title={synced?.toLocaleString()}>
            {relativeTime(connection.last_synced_at) ?? 'Not synced yet'}
          </dd>
          <dt className="text-muted-foreground">Listings</dt>
          <dd className="tabular-nums">{connection.last_listing_count ?? '-'}</dd>
          <dt className="text-muted-foreground">New jobs</dt>
          <dd className="tabular-nums">{connection.last_new_jobs ?? '-'}</dd>
          {hints.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground capitalize">{k.replace(/_/g, ' ')}</dt>
              <dd className="truncate">{v}</dd>
            </div>
          ))}
        </dl>
        {!enabled ? <p className="text-xs text-muted-foreground">Turn on auto-sync to sync now.</p> : null}
      </Section>

      <Separator />

      <div className="flex flex-wrap gap-2">
        {plugin.auth_type !== 'none' ? (
          <Button variant="outline" onClick={onReconnect}>
            <KeyRound />
            {plugin.auth_type === 'api_key' ? 'Update credentials' : 'Reconnect'}
          </Button>
        ) : null}
        <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
          <Unplug />
          Disconnect
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !disconnect.isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {plugin.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Syncing stops and saved credentials are removed. Jobs already in your pipeline stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConnectFlow({ plugin, onConnected }: { plugin: JobSitePlugin; onConnected: (row: JobSiteConnection) => void }) {
  const flow = useJobSiteConnect(plugin, { onConnected });
  const [showCredentials, setShowCredentials] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const hasFields = plugin.credential_fields.length > 0;

  const submit = () => {
    const filled = plugin.credential_fields.filter((f) => (flow.values[f.key] ?? '').trim());
    if (plugin.auth_type === 'api_key') {
      const empty = plugin.credential_fields.filter((f) => !(flow.values[f.key] ?? '').trim()).map((f) => f.key);
      setMissing(empty);
      if (empty.length) return;
    } else if (hasFields && filled.length === 0) {
      setMissing(plugin.credential_fields.map((f) => f.key));
      return;
    }
    setMissing([]);
    const credentials = Object.fromEntries(
      Object.entries(flow.values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
    );
    void flow.submitCredentials(credentials);
  };

  const credentialForm = (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <CredentialFields plugin={plugin} values={flow.values} setValue={flow.setValue} missing={missing} />
      {missing.length && plugin.auth_type !== 'api_key' ? (
        <FieldError>Fill in at least one field.</FieldError>
      ) : null}
      <Button type="submit" disabled={flow.busy}>
        {flow.busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
        Verify & connect
      </Button>
    </form>
  );

  if (plugin.auth_type === 'none') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This board publishes a public job feed. Connecting enables automatic sync into your pipeline, no
          account required.
        </p>
        {flow.error ? <InlineError>{flow.error}</InlineError> : null}
        <Button disabled={flow.busy} onClick={() => void flow.submitCredentials({})}>
          {flow.busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          Enable
        </Button>
      </div>
    );
  }

  if (!flow.sessionFlow) {
    return (
      <div className="space-y-4">
        {flow.error ? <InlineError>{flow.error}</InlineError> : null}
        {credentialForm}
      </div>
    );
  }

  const extMissing = flow.extReady === false;
  const stepTitles = [
    'Detect the NAO browser extension',
    `Open ${plugin.name} in a new tab`,
    `Sign in to ${plugin.name}`,
    'Capture and verify your session',
  ];

  return (
    <div className="space-y-5">
      <Section title="Connect with your browser login" description="If you're already signed in, we detect it and connect automatically.">
        <ol className="space-y-2.5" aria-label="Connection steps">
          {stepTitles.map((title, i) => (
            <ConnectStep key={title} title={title} state={flow.steps[i]} />
          ))}
        </ol>
        <p role="status" aria-live="polite" className="rounded-lg bg-muted px-3 py-2 text-sm">
          {flow.statusText}
          {flow.liveUrl ? (
            <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">{flow.liveUrl}</span>
          ) : null}
        </p>
      </Section>

      {flow.error ? <InlineError>{flow.error}</InlineError> : null}

      {extMissing ? (
        <InstallGuide onInstalled={flow.retry} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={flow.busy || flow.extReady === null} onClick={() => void flow.captureNow()}>
            {flow.busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            I&apos;m signed in. Capture now
          </Button>
          <Button variant="outline" disabled={flow.extReady === null} onClick={() => void flow.focusTab()}>
            <ExternalLink />
            Show sign-in tab
          </Button>
          {flow.liveState === 'cancelled' || flow.liveState === 'start_failed' ? (
            <Button variant="ghost" onClick={flow.retry}>
              <RefreshCw />
              Try again
            </Button>
          ) : null}
        </div>
      )}

      {hasFields ? (
        <Collapsible open={showCredentials} onOpenChange={setShowCredentials} className="rounded-xl border">
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left text-sm font-medium outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            }
          >
            Enter credentials instead
            <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', showCredentials && 'rotate-180')} />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t px-4 py-4">{credentialForm}</CollapsibleContent>
        </Collapsible>
      ) : null}

      <LogPanel lines={flow.logLines} />
    </div>
  );
}

const STEP_ICON: Record<StepState, typeof Circle> = {
  pending: Circle,
  active: Loader2,
  done: CheckCircle2,
  failed: XCircle,
};

function ConnectStep({ title, state }: { title: string; state: StepState }) {
  const Icon = STEP_ICON[state];
  return (
    <li className="flex items-center gap-2.5 text-sm" data-state={state}>
      <Icon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          state === 'pending' && 'text-muted-foreground/50',
          state === 'active' && 'animate-spin text-brand',
          state === 'done' && 'text-status-ready',
          state === 'failed' && 'text-status-preparing',
        )}
      />
      <span className={cn(state === 'pending' && 'text-muted-foreground')}>{title}</span>
      <span className="sr-only">
        {state === 'done' ? '(done)' : state === 'active' ? '(in progress)' : state === 'failed' ? '(needs action)' : ''}
      </span>
    </li>
  );
}

const EXTENSION_STEPS = [
  'Open chrome://extensions in your browser',
  'Turn on “Developer mode” (top-right toggle)',
  'Click “Load unpacked”',
  'Select the extension folder from this NAO checkout',
  'Pin “NAO” and sign in with your account',
];

function InstallGuide({ onInstalled }: { onInstalled: () => void }) {
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const recheck = async () => {
    setChecking(true);
    setNotFound(false);
    const info = await detectExtension(1200, true);
    setChecking(false);
    if (info.installed) onInstalled();
    else setNotFound(true);
  };

  return (
    <Section
      title="Install the NAO extension"
      description="The extension reads your existing login so we can connect without a password. It isn't on a store yet, so load it once as an unpacked extension."
      className="rounded-xl border p-4"
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        {EXTENSION_STEPS.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {notFound ? (
        <p className="text-sm text-destructive">
          Still not detected. Reload the extension from chrome://extensions, make sure it's enabled, then try again.
        </p>
      ) : null}
      <Button variant="outline" disabled={checking} onClick={() => void recheck()}>
        {checking ? <Loader2 className="animate-spin" /> : null}
        I&apos;ve installed it
      </Button>
      <p className="text-xs text-muted-foreground">Or enter your credentials below instead.</p>
    </Section>
  );
}

function LogPanel({ lines }: { lines: ConnectLogLine[] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="xs" className="text-muted-foreground" />
        }
      >
        Connection log
        <ChevronDown />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="scrollbar-thin mt-2 max-h-44 overflow-y-auto rounded-lg border bg-muted p-2.5 font-mono text-[11px] leading-relaxed">
          {lines.length === 0 ? (
            <p className="text-muted-foreground">Waiting for the browser extension…</p>
          ) : (
            lines.map((line) => (
              <div
                key={line.id}
                className={cn(line.level === 'error' && 'text-destructive', line.level === 'warn' && 'text-status-preparing')}
              >
                <span className="text-foreground">{line.text}</span>
                {line.detail ? <span className="text-muted-foreground"> {line.detail}</span> : null}
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CredentialFields({
  plugin,
  values,
  setValue,
  missing,
}: {
  plugin: JobSitePlugin;
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  missing: string[];
}) {
  const strict = plugin.auth_type === 'api_key';
  return (
    <FieldGroup className="gap-4">
      {plugin.auth_type === 'account' && plugin.login_url ? (
        <p className="text-sm text-muted-foreground">
          {plugin.slug === 'remoterocketship' ? (
            <>
              Paste a Cookie header from DevTools after signing in on{' '}
              <a href={plugin.login_url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                RemoteRocketship
              </a>
              .
            </>
          ) : (
            <>
              Enter the same email and password you use on{' '}
              <a href={plugin.homepage} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                {plugin.name}
              </a>
              . We verify against the live API.
            </>
          )}
        </p>
      ) : null}
      {plugin.credential_fields.map((field) => {
        const id = `cred-${plugin.slug}-${field.key}`;
        const invalid = strict && missing.includes(field.key);
        return (
          <Field key={field.key} data-invalid={invalid || undefined}>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
              {field.help_url ? (
                <a
                  href={field.help_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                >
                  {plugin.auth_type === 'account' ? 'Open site' : 'Get key'}
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
            {field.key === 'cookie_header' ? (
              <Textarea
                id={id}
                value={values[field.key] ?? ''}
                onChange={(e) => setValue(field.key, e.target.value)}
                placeholder={field.placeholder}
                aria-invalid={invalid || undefined}
                autoComplete="off"
                spellCheck={false}
                className="min-h-22 font-mono text-xs"
              />
            ) : (
              <Input
                id={id}
                type={field.secret ? 'password' : field.key === 'email' ? 'email' : 'text'}
                value={values[field.key] ?? ''}
                onChange={(e) => setValue(field.key, e.target.value)}
                placeholder={field.placeholder}
                aria-invalid={invalid || undefined}
                autoComplete={field.key === 'email' ? 'username' : field.secret ? 'current-password' : 'off'}
              />
            )}
            {invalid ? <FieldError>{field.label} is required.</FieldError> : null}
          </Field>
        );
      })}
    </FieldGroup>
  );
}
