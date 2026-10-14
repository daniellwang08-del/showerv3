import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Search, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import {
  disconnectGmail,
  fetchGmailMessage,
  searchGmail,
  setGmailEnabled,
  startGmailConnect,
} from '@/api/gmailApi';
import type { GmailMessageSummary } from '@/types/gmail';
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { integrationKeys, invalidateGmail } from './queries';
import { InlineError, Section, SheetFrame } from './SheetFrame';
import { errorDetail, gmailStatus, relativeTime, type GmailData } from './status';

export const GMAIL_NAME = 'Gmail';
export const GMAIL_BLURB = 'Search your inbox with read-only access. NAO never sends or deletes mail.';
export const GMAIL_LOGO = '/integrations/gmail.svg';

export function GmailSheet({ data }: { data: GmailData }) {
  const { status, config } = data;
  const configured = Boolean(config.configured);
  const serverReady = Boolean(status.server_configured);

  let body;
  if (!serverReady && !configured) {
    body = <ServerNotConfigured />;
  } else if (!configured) {
    body = <ConnectPrompt />;
  } else {
    body = <ConnectedGmail data={data} />;
  }

  return (
    <SheetFrame name={GMAIL_NAME} description={GMAIL_BLURB} logoSrc={GMAIL_LOGO} status={gmailStatus(data).kind}>
      {!serverReady && configured ? (
        <div className="mb-5">
          <ServerNotConfigured />
        </div>
      ) : null}
      {body}
    </SheetFrame>
  );
}

function ServerNotConfigured() {
  return (
    <Alert>
      <AlertTitle>Gmail is not configured on this server</AlertTitle>
      <AlertDescription>
        An admin needs to set <code className="text-xs">GOOGLE_OAUTH_CLIENT_ID</code> and{' '}
        <code className="text-xs">GOOGLE_OAUTH_CLIENT_SECRET</code>, enable the Gmail API, and register the OAuth
        redirect URI. Only the <code className="text-xs">gmail.readonly</code> scope is requested.
      </AlertDescription>
    </Alert>
  );
}

function ConnectPrompt() {
  return (
    <div className="space-y-5">
      <Section
        title="Connect with Google"
        description="You'll sign in with Google and grant read-only access so NAO can search messages in your inbox."
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Read and search mail only. No send, delete, or label changes.</li>
          <li>Tokens are encrypted at rest. You can disconnect anytime.</li>
          <li>Uses the same search syntax as the Gmail search box.</li>
        </ul>
      </Section>
      <Button type="button" className="w-full" onClick={() => startGmailConnect()}>
        <ExternalLink />
        Continue with Google
      </Button>
    </div>
  );
}

function ConnectedGmail({ data }: { data: GmailData }) {
  const qc = useQueryClient();
  const { config } = data;
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [query, setQuery] = useState('newer_than:30d');
  const [results, setResults] = useState<GmailMessageSummary[] | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [selected, setSelected] = useState<GmailMessageSummary | null>(null);

  const writeConfig = (patch: Partial<GmailData['config']>) =>
    qc.setQueryData<GmailData>(integrationKeys.gmail, (prev) =>
      prev ? { ...prev, config: { ...prev.config, ...patch } } : prev,
    );

  const enabledMut = useMutation({
    mutationFn: setGmailEnabled,
    onSuccess: (res) => {
      writeConfig(res);
      invalidateGmail(qc);
      toast.success(res.is_enabled ? 'Gmail search enabled' : 'Gmail search paused');
    },
    onError: (err) => toast.error(errorDetail(err, 'Could not update Gmail settings.')),
  });

  const disconnectMut = useMutation({
    mutationFn: disconnectGmail,
    onSuccess: () => {
      qc.setQueryData<GmailData>(integrationKeys.gmail, (prev) =>
        prev ? { ...prev, config: { configured: false } } : prev,
      );
      invalidateGmail(qc);
      toast.success('Gmail disconnected');
      setConfirmDisconnect(false);
    },
    onError: (err) => toast.error(errorDetail(err, 'Could not disconnect Gmail.')),
  });

  const searchMut = useMutation({
    mutationFn: () => searchGmail(query),
    onSuccess: (res) => {
      setResults(res.messages);
      setEstimate(res.result_size_estimate);
      setSelected(null);
      if (res.messages.length === 0) toast.message('No messages matched that search');
    },
    onError: (err) => toast.error(errorDetail(err, 'Gmail search failed.')),
  });

  const detailMut = useMutation({
    mutationFn: (messageId: string) => fetchGmailMessage(messageId),
    onSuccess: (msg) => setSelected(msg),
    onError: (err) => toast.error(errorDetail(err, 'Could not load that message.')),
  });

  const enabled = config.is_enabled !== false;
  const needsReauth = config.status === 'needs_reauth';

  return (
    <div className="space-y-6">
      {needsReauth ? (
        <InlineError title="Reconnect required">
          {config.last_error?.trim() || 'Google access expired or was revoked.'}
          <div className="mt-3">
            <Button type="button" size="sm" onClick={() => startGmailConnect()}>
              <ExternalLink />
              Reconnect Google
            </Button>
          </div>
        </InlineError>
      ) : null}

      <Section title="Account" description="Read-only access to this Gmail inbox.">
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{config.google_email}</p>
            <p className="text-xs text-muted-foreground">
              Connected {relativeTime(config.connected_at) ?? 'recently'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">{enabled ? 'On' : 'Off'}</span>
            <Switch
              checked={enabled}
              disabled={enabledMut.isPending || needsReauth}
              onCheckedChange={(next) => enabledMut.mutate(next)}
              aria-label="Enable Gmail search"
            />
          </div>
        </div>
      </Section>

      <Section
        title="Search inbox"
        description="Uses Gmail search syntax, for example from:recruiter@company.com or subject:offer newer_than:14d."
      >
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!query.trim() || !enabled || needsReauth) return;
            searchMut.mutate();
          }}
        >
          <Field className="min-w-0 flex-1 gap-1.5">
            <FieldLabel htmlFor="gmail-search-query" className="sr-only">
              Search query
            </FieldLabel>
            <Input
              id="gmail-search-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="from:jobs@company.com newer_than:30d"
              disabled={!enabled || needsReauth || searchMut.isPending}
            />
            <FieldDescription>Max 25 results per search.</FieldDescription>
          </Field>
          <Button
            type="submit"
            disabled={!query.trim() || !enabled || needsReauth || searchMut.isPending}
            className="shrink-0 self-start"
          >
            {searchMut.isPending ? <Loader2 className="animate-spin" /> : <Search />}
            Search
          </Button>
        </form>

        {results ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {results.length} shown
              {estimate != null ? ` · about ${estimate} match${estimate === 1 ? '' : 'es'}` : null}
            </p>
            {results.length === 0 ? (
              <p className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">No messages found.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {results.map((msg) => {
                  const active = selected?.id === msg.id;
                  return (
                    <li key={msg.id}>
                      <button
                        type="button"
                        className={cn(
                          'w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                          active && 'bg-muted/60',
                        )}
                        onClick={() => detailMut.mutate(msg.id)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 truncate text-sm font-medium">{msg.subject}</p>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {relativeTime(msg.date) ?? ''}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">{msg.from}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{msg.snippet}</p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {detailMut.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading message…
          </p>
        ) : null}

        {selected?.body_text != null ? (
          <div className="space-y-2 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">{selected.subject}</p>
              <p className="text-xs text-muted-foreground">{selected.from}</p>
            </div>
            <pre className="scrollbar-thin max-h-64 overflow-auto whitespace-pre-wrap text-xs text-foreground/90">
              {selected.body_text || selected.snippet || '(empty body)'}
            </pre>
          </div>
        ) : null}
      </Section>

      <Separator />

      <Section title="Disconnect">
        <Button type="button" variant="outline" onClick={() => setConfirmDisconnect(true)}>
          <Unplug />
          Disconnect Gmail
        </Button>
      </Section>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Gmail?</AlertDialogTitle>
            <AlertDialogDescription>
              NAO will delete the stored Google tokens for {config.google_email} and stop searching this inbox. You can
              connect again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnectMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                disconnectMut.mutate();
              }}
            >
              {disconnectMut.isPending ? <Loader2 className="animate-spin" /> : null}
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
