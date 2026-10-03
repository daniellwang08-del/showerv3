import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, Loader2, Pencil, Replace, Unplug, Zap } from 'lucide-react';
import { toast } from 'sonner';
import {
  disconnectSheets,
  saveSheetsAutoPostSettings,
  setSheetsEnabled,
  verifySpreadsheet,
} from '@/api/googleSheetsApi';
import type { SheetsConfig, SheetsConfigSaveResult } from '@/types/googleSheets';
import { normalizeAutoPostFilters } from '@/types/autoPostFilters';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { SaveBar } from '@/components/app/SaveBar';
import { AutoPostSettings, useAutoPostDraft } from './AutoPostSettings';
import { integrationKeys, invalidateSheets } from './queries';
import { CopyButton, InlineError, Section, SheetFrame, Step } from './SheetFrame';
import { TabGroupsEditor } from './TabGroupsEditor';
import { DEFAULT_AUTO_POST_THRESHOLD, errorDetail, sheetsStatus, type SheetsData } from './status';

export const SHEETS_NAME = 'Google Sheets';
export const SHEETS_BLURB = 'Post matching job URLs to spreadsheet tabs in round-robin groups.';
export const SHEETS_LOGO = '/integrations/google-sheets.svg';

const SHEETS_URL_RE = /docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+/;

type Mode = { kind: 'view' } | { kind: 'setup'; changing: boolean } | { kind: 'groups'; tabs: string[] };

type ConfigLike = Omit<SheetsConfig, 'configured'> & { spreadsheet_url: string };

export function GoogleSheetsSheet({ data }: { data: SheetsData }) {
  const qc = useQueryClient();
  const { status, config } = data;
  const configured = Boolean(config.configured);
  const serverReady = Boolean(status.server_configured);
  const [mode, setMode] = useState<Mode>(configured ? { kind: 'view' } : { kind: 'setup', changing: false });
  const effectiveMode: Mode = !configured && mode.kind !== 'setup' ? { kind: 'setup', changing: false } : mode;

  const writeConfig = (next: ConfigLike) =>
    qc.setQueryData<SheetsData>(integrationKeys.sheets, (prev) =>
      prev ? { ...prev, config: { ...prev.config, ...next, configured: true } } : prev,
    );

  const onSaved = (result: SheetsConfigSaveResult) => {
    writeConfig({
      spreadsheet_url: result.spreadsheet_url,
      tab_groups: result.tab_groups,
      auto_post_threshold: result.auto_post_threshold,
      is_enabled: result.is_enabled ?? true,
      group_count: result.group_count,
      assigned_tab_count: result.assigned_tab_count,
    });
    invalidateSheets(qc);
    toast.success('Google Sheets configuration saved');
    setMode({ kind: 'view' });
  };

  const savedThreshold = config.auto_post_threshold ?? DEFAULT_AUTO_POST_THRESHOLD;

  let body;
  if (!serverReady && !configured) {
    body = <ServerNotConfigured />;
  } else if (effectiveMode.kind === 'setup') {
    body = (
      <SetupFlow
        serviceAccountEmail={status.service_account_email}
        autoPostThreshold={savedThreshold}
        onSaved={onSaved}
        onCancel={effectiveMode.changing ? () => setMode({ kind: 'view' }) : undefined}
      />
    );
  } else if (effectiveMode.kind === 'groups') {
    body = (
      <TabGroupsEditor
        spreadsheetUrl={config.spreadsheet_url ?? ''}
        tabs={effectiveMode.tabs}
        initialGroups={config.tab_groups ?? []}
        autoPostThreshold={savedThreshold}
        onSaved={onSaved}
        onCancel={() => setMode({ kind: 'view' })}
      />
    );
  } else {
    body = (
      <ConnectedSheets
        data={data}
        writeConfig={writeConfig}
        onEditGroups={(tabs) => setMode({ kind: 'groups', tabs })}
        onChangeSheet={() => setMode({ kind: 'setup', changing: true })}
      />
    );
  }

  return (
    <SheetFrame name={SHEETS_NAME} description={SHEETS_BLURB} logoSrc={SHEETS_LOGO} status={sheetsStatus(data).kind}>
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
      <AlertCircle />
      <AlertTitle>Google Sheets isn't configured on this server</AlertTitle>
      <AlertDescription>
        An administrator needs to set <code className="font-mono text-xs">GOOGLE_SHEETS_CREDENTIALS_PATH</code> and place
        the service account JSON on the server before anyone can connect a sheet.
      </AlertDescription>
    </Alert>
  );
}

function SetupFlow({
  serviceAccountEmail,
  autoPostThreshold,
  onSaved,
  onCancel,
}: {
  serviceAccountEmail: string | null;
  autoPostThreshold: number;
  onSaved: (result: SheetsConfigSaveResult) => void;
  onCancel?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [verified, setVerified] = useState<{ url: string; tabs: string[] } | null>(null);

  const verify = useMutation({
    mutationFn: (u: string) => verifySpreadsheet(u),
    onSuccess: (result, u) => setVerified({ url: u, tabs: result.tabs }),
    onError: (err) => setUrlError(errorDetail(err, 'Could not access the spreadsheet.')),
  });

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError('Enter a Google Sheet URL.');
      return;
    }
    if (!SHEETS_URL_RE.test(trimmed)) {
      setUrlError('Enter a valid Google Sheets URL (docs.google.com/spreadsheets/d/…).');
      return;
    }
    setUrlError('');
    setVerified(null);
    verify.mutate(trimmed);
  };

  return (
    <div className="space-y-5">
      <ol className="space-y-6">
        <Step n={1} title="Share your spreadsheet">
          {serviceAccountEmail ? (
            <>
              <p className="text-sm text-muted-foreground">
                In Google Sheets, click Share and add this address as an <strong className="font-medium text-foreground">Editor</strong>:
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border bg-muted px-2.5 py-1.5 font-mono text-xs">
                  {serviceAccountEmail}
                </code>
                <CopyButton value={serviceAccountEmail} label="Copy service account email" />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Share the spreadsheet with the server's service account as an Editor.</p>
          )}
        </Step>
        <Step n={2} title="Paste the spreadsheet URL" done={Boolean(verified)}>
          <form
            noValidate
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Field data-invalid={Boolean(urlError) || undefined}>
              <FieldLabel htmlFor="sheets-url">Google Sheet URL</FieldLabel>
              <Input
                id="sheets-url"
                type="url"
                value={url}
                aria-invalid={Boolean(urlError) || undefined}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError('');
                  setVerified(null);
                }}
              />
              {urlError ? <FieldError>{urlError}</FieldError> : null}
              {verified ? (
                <FieldDescription className="text-xs">
                  Verified · {verified.tabs.length} tab{verified.tabs.length === 1 ? '' : 's'} found
                </FieldDescription>
              ) : null}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant={verified ? 'outline' : 'default'} disabled={verify.isPending}>
                {verify.isPending ? <Loader2 className="animate-spin" /> : <Zap />}
                {verify.isPending ? 'Verifying…' : 'Verify'}
              </Button>
              {onCancel && !verified ? (
                <Button type="button" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        </Step>
        <Step n={3} title="Assign tabs to groups">
          {verified ? (
            <TabGroupsEditor
              key={verified.url}
              spreadsheetUrl={verified.url}
              tabs={verified.tabs}
              initialGroups={[]}
              autoPostThreshold={autoPostThreshold}
              onSaved={onSaved}
              onCancel={onCancel}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Verify the spreadsheet to load its tabs.</p>
          )}
        </Step>
      </ol>
    </div>
  );
}

function ConnectedSheets({
  data,
  writeConfig,
  onEditGroups,
  onChangeSheet,
}: {
  data: SheetsData;
  writeConfig: (next: ConfigLike) => void;
  onEditGroups: (tabs: string[]) => void;
  onChangeSheet: () => void;
}) {
  const qc = useQueryClient();
  const { config, status } = data;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [groupsError, setGroupsError] = useState('');
  const enabled = config.is_enabled !== false;
  const savedAutoPost = {
    threshold: config.auto_post_threshold ?? DEFAULT_AUTO_POST_THRESHOLD,
    filters: normalizeAutoPostFilters(config.auto_post_filters),
  };
  const draft = useAutoPostDraft(savedAutoPost);

  const toggle = useMutation({
    mutationFn: (next: boolean) => setSheetsEnabled(next),
    onSuccess: (result, next) => {
      writeConfig(result);
      invalidateSheets(qc);
      toast.success(next ? 'Auto-post after job analysis enabled' : 'Auto-post paused. Your spreadsheet connection was kept.');
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to update auto-post setting.')),
  });

  const saveAutoPost = useMutation({
    mutationFn: () => saveSheetsAutoPostSettings(draft.payload()),
    onSuccess: (result) => {
      writeConfig({
        ...result,
        auto_post_filters: normalizeAutoPostFilters(result.auto_post_filters),
        is_enabled: result.is_enabled ?? enabled,
      });
      draft.reset();
      invalidateSheets(qc);
      toast.success(`Auto-post settings saved (score ≥ ${result.auto_post_threshold})`);
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to save auto-post settings.')),
  });

  const loadTabs = useMutation({
    mutationFn: () => verifySpreadsheet(config.spreadsheet_url ?? ''),
    onMutate: () => setGroupsError(''),
    onSuccess: (result) => onEditGroups(result.tabs),
    onError: (err) => setGroupsError(errorDetail(err, 'Could not refresh spreadsheet tabs.')),
  });

  const disconnect = useMutation({
    mutationFn: disconnectSheets,
    onSuccess: () => {
      qc.setQueryData<SheetsData>(integrationKeys.sheets, (prev) => (prev ? { ...prev, config: { configured: false } } : prev));
      invalidateSheets(qc);
      setConfirmOpen(false);
      toast.success('Google Sheets disconnected');
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to disconnect Google Sheets.')),
  });

  const checked = toggle.isPending ? Boolean(toggle.variables) : enabled;
  const tabs = config.assigned_tab_count ?? 0;
  const groups = config.group_count ?? 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1 rounded-xl border p-4">
        <p className="text-sm font-medium">{checked ? 'Connected · Auto-post on' : 'Connected · Auto-post paused'}</p>
        <p className="text-sm text-muted-foreground tabular-nums">
          {tabs} tab{tabs === 1 ? '' : 's'} in {groups} group{groups === 1 ? '' : 's'}
        </p>
        {config.spreadsheet_url ? (
          <a
            href={config.spreadsheet_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 text-sm text-brand hover:underline"
          >
            <span className="truncate">Open spreadsheet</span>
            <ExternalLink className="size-3.5 shrink-0" />
          </a>
        ) : null}
      </div>

      <Field orientation="horizontal">
        <div className="min-w-0 flex-1">
          <FieldLabel htmlFor="sheets-enabled">Auto-post after job analysis</FieldLabel>
          <FieldDescription className="mt-1 text-xs">
            When off, your spreadsheet stays connected, only automatic posting pauses. Manual “Post to Google Sheet”
            still works.
          </FieldDescription>
        </div>
        <Switch
          id="sheets-enabled"
          checked={checked}
          disabled={toggle.isPending || !status.server_configured}
          onCheckedChange={(next) => toggle.mutate(next)}
        />
      </Field>

      <Separator />

      <Section title="Auto-post settings">
        <AutoPostSettings
          value={draft.value}
          onChange={draft.setValue}
          disabled={saveAutoPost.isPending}
          description={
            checked
              ? 'After match analysis, jobs must meet the score threshold and every active filter before they are written to your sheet.'
              : 'Auto-post is paused. Save settings now so they’re ready when you turn auto-post back on.'
          }
        />
        {!draft.dirty ? (
          <p className="text-xs text-muted-foreground tabular-nums">Saved: score ≥ {savedAutoPost.threshold}</p>
        ) : null}
      </Section>

      <Separator />

      <Section title="Spreadsheet">
        {groupsError ? <InlineError>{groupsError}</InlineError> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={loadTabs.isPending} onClick={() => loadTabs.mutate()}>
            {loadTabs.isPending ? <Loader2 className="animate-spin" /> : <Pencil />}
            Edit tab groups
          </Button>
          <Button variant="outline" onClick={onChangeSheet}>
            <Replace />
            Change sheet
          </Button>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            <Unplug />
            Disconnect
          </Button>
        </div>
      </Section>

      <SaveBar
        dirty={draft.dirty}
        saving={saveAutoPost.isPending}
        onSave={() => saveAutoPost.mutate()}
        onDiscard={draft.reset}
        saveLabel="Save auto-post settings"
      />

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !disconnect.isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Google Sheets?</AlertDialogTitle>
            <AlertDialogDescription>
              Job posting to the sheet will stop. URLs already written to the spreadsheet are not removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
