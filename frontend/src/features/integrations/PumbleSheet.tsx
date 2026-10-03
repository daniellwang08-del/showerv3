import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Hash, Loader2, Lock, Plus, Trash2, Unplug, Zap } from 'lucide-react';
import { toast } from 'sonner';
import {
  deletePumbleIntegration,
  disconnectPumble,
  fetchPumbleChannels,
  savePumbleAutoPostSettings,
  savePumbleConfig,
  setPumbleAllEnabled,
  setPumbleIntegrationEnabled,
  verifyPumbleApiKey,
} from '@/api/pumbleApi';
import type { PumbleChannel, PumbleIntegration } from '@/types/pumble';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { SaveBar } from '@/components/app/SaveBar';
import { AutoPostSettings, useAutoPostDraft, type AutoPostValue } from './AutoPostSettings';
import { integrationKeys, invalidatePumble } from './queries';
import { InlineError, Section, SheetFrame } from './SheetFrame';
import { DEFAULT_AUTO_POST_THRESHOLD, errorDetail, pumbleStatus, type PumbleData } from './status';

export const PUMBLE_NAME = 'Pumble';
export const PUMBLE_BLURB = 'Post matching job URLs to channels as replies under a daily thread.';
export const PUMBLE_LOGO = '/integrations/pumble.svg';

type Pending = { kind: 'remove'; integration: PumbleIntegration } | { kind: 'disconnect' } | null;

export function PumbleSheet({ data }: { data: PumbleData }) {
  const qc = useQueryClient();
  const { status, config } = data;
  const available = status.integration_available !== false;
  const integrations = config.integrations ?? [];
  const configured = integrations.length > 0;
  const anyEnabled = integrations.some((i) => i.is_enabled !== false);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending>(null);

  const savedAutoPost: AutoPostValue = {
    threshold: config.auto_post_threshold ?? DEFAULT_AUTO_POST_THRESHOLD,
    filters: normalizeAutoPostFilters(config.auto_post_filters ?? integrations[0]?.auto_post_filters ?? null),
  };
  const draft = useAutoPostDraft(savedAutoPost);

  const patchConfig = (fn: (prev: PumbleData) => PumbleData) =>
    qc.setQueryData<PumbleData>(integrationKeys.pumble, (prev) => (prev ? fn(prev) : prev));

  const toggleAll = useMutation({
    mutationFn: (next: boolean) => setPumbleAllEnabled(next),
    onSuccess: (result, next) => {
      patchConfig((prev) => ({ ...prev, config: { ...prev.config, ...result } }));
      invalidatePumble(qc);
      toast.success(next ? 'Auto-post enabled for all Pumble destinations' : 'Auto-post paused. Connected destinations were kept.');
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to update auto-post setting.')),
  });

  const toggleOne = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) => setPumbleIntegrationEnabled(id, next),
    onSuccess: ({ integration }, { next }) => {
      patchConfig((prev) => ({
        ...prev,
        config: {
          ...prev.config,
          integrations: (prev.config.integrations ?? []).map((i) => (i.id === integration.id ? integration : i)),
        },
      }));
      invalidatePumble(qc);
      toast.success(next ? `Auto-post enabled for ${integration.label}` : `Auto-post paused for ${integration.label}`);
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to update destination.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deletePumbleIntegration(id),
    onSuccess: (_r, id) => {
      patchConfig((prev) => {
        const list = (prev.config.integrations ?? []).filter((i) => i.id !== id);
        return { ...prev, config: { ...prev.config, integrations: list, configured: list.length > 0 } };
      });
      invalidatePumble(qc);
      setPending(null);
      toast.success('Pumble destination removed');
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to remove destination.')),
  });

  const disconnectAll = useMutation({
    mutationFn: disconnectPumble,
    onSuccess: () => {
      patchConfig((prev) => ({ ...prev, config: { configured: false, integrations: [] } }));
      invalidatePumble(qc);
      draft.reset();
      setAdding(false);
      setPending(null);
      toast.success('All Pumble destinations disconnected');
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to disconnect Pumble.')),
  });

  const saveAutoPost = useMutation({
    mutationFn: () => savePumbleAutoPostSettings(draft.payload()),
    onSuccess: (result) => {
      patchConfig((prev) => ({
        ...prev,
        config: {
          ...prev.config,
          auto_post_threshold: result.auto_post_threshold,
          auto_post_filters: normalizeAutoPostFilters(result.auto_post_filters),
        },
      }));
      draft.reset();
      invalidatePumble(qc);
      toast.success(`Auto-post settings saved (score ≥ ${result.auto_post_threshold}) for all destinations`);
    },
    onError: (err) => toast.error(errorDetail(err, 'Failed to save auto-post settings.')),
  });

  const allChecked = toggleAll.isPending ? Boolean(toggleAll.variables) : anyEnabled;
  const removeBusy = remove.isPending || disconnectAll.isPending;

  return (
    <SheetFrame name={PUMBLE_NAME} description={PUMBLE_BLURB} logoSrc={PUMBLE_LOGO} status={pumbleStatus(data).kind}>
      <div className="space-y-6">
        {!available ? (
          <Alert>
            <AlertCircle />
            <AlertTitle>Pumble isn't available</AlertTitle>
            <AlertDescription>Pumble integration is currently unavailable on this server.</AlertDescription>
          </Alert>
        ) : null}

        <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
          Install the <strong className="font-medium text-foreground">API</strong> addon in Pumble, generate an API key,
          then add each workspace/channel you want to post to. For private channels, make sure the API addon bot is a
          member.
        </p>

        {configured ? (
          <>
            <Field orientation="horizontal">
              <div className="min-w-0 flex-1">
                <FieldLabel htmlFor="pumble-enabled">Auto-post after job analysis</FieldLabel>
                <FieldDescription className="mt-1 text-xs">
                  Turns auto-post on or off for all destinations without removing them. You can also pause individual
                  channels below.
                </FieldDescription>
              </div>
              <Switch
                id="pumble-enabled"
                checked={allChecked}
                disabled={!available || toggleAll.isPending}
                onCheckedChange={(next) => toggleAll.mutate(next)}
              />
            </Field>

            <Section
              title={`Destinations (${integrations.length})`}
              actions={
                !adding ? (
                  <Button variant="outline" size="sm" disabled={!available} onClick={() => setAdding(true)}>
                    <Plus />
                    Add destination
                  </Button>
                ) : null
              }
            >
              <ul className="divide-y rounded-xl border" aria-label="Pumble destinations">
                {integrations.map((integration) => {
                  const on = toggleOne.isPending && toggleOne.variables?.id === integration.id
                    ? toggleOne.variables.next
                    : integration.is_enabled !== false;
                  return (
                    <li key={integration.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                          <span className="font-medium">{integration.label}</span>
                          <span className="inline-flex items-center text-muted-foreground">
                            <Hash className="size-3.5" />
                            {integration.channel_name}
                          </span>
                          {!on ? <Badge variant="secondary">Paused</Badge> : null}
                        </p>
                        {integration.api_key_hint ? (
                          <p className="text-xs text-muted-foreground">Key {integration.api_key_hint}</p>
                        ) : null}
                      </div>
                      <Switch
                        size="sm"
                        checked={on}
                        aria-label={`Auto-post to ${integration.label}`}
                        disabled={toggleOne.isPending && toggleOne.variables?.id === integration.id}
                        onCheckedChange={(next) => toggleOne.mutate({ id: integration.id, next })}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${integration.label}`}
                        disabled={removeBusy}
                        onClick={() => setPending({ kind: 'remove', integration })}
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-muted-foreground">
                Daily header format: <code className="font-mono">M/D/YYYY (NAO post)</code>
              </p>
            </Section>
          </>
        ) : null}

        {available && (adding || !configured) ? (
          <AddDestination
            first={!configured}
            connectedChannelIds={new Set(integrations.map((i) => i.channel_id))}
            autoPostThreshold={draft.value.threshold}
            onCancel={configured ? () => setAdding(false) : undefined}
            onSaved={() => {
              setAdding(false);
              invalidatePumble(qc);
              toast.success('Pumble destination added');
            }}
          />
        ) : null}

        {configured ? (
          <>
            <Separator />
            <Section title="Auto-post settings">
              <AutoPostSettings
                value={draft.value}
                onChange={draft.setValue}
                disabled={saveAutoPost.isPending}
                description="Shared by all destinations. After match analysis, jobs must meet the score threshold and every active filter before posting to enabled channels."
              />
              {!draft.dirty ? (
                <p className="text-xs text-muted-foreground tabular-nums">Saved: score ≥ {savedAutoPost.threshold}</p>
              ) : null}
            </Section>
            <Separator />
            <Button variant="destructive" disabled={removeBusy} onClick={() => setPending({ kind: 'disconnect' })}>
              <Unplug />
              Disconnect all
            </Button>
          </>
        ) : null}

        <SaveBar
          dirty={draft.dirty && configured}
          saving={saveAutoPost.isPending}
          onSave={() => saveAutoPost.mutate()}
          onDiscard={draft.reset}
          saveLabel="Save auto-post settings"
        />
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !removeBusy && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'remove' ? `Remove ${pending.integration.label}?` : 'Disconnect all Pumble destinations?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'remove'
                ? `Jobs will no longer be posted to #${pending.integration.channel_name}. Messages already posted are not removed.`
                : `Job posting to Pumble will stop for all ${integrations.length} destination${integrations.length === 1 ? '' : 's'}. Messages already posted in Pumble are not removed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removeBusy}
              onClick={() => {
                if (pending?.kind === 'remove') remove.mutate(pending.integration.id);
                else disconnectAll.mutate();
              }}
            >
              {removeBusy ? 'Working…' : pending?.kind === 'remove' ? 'Remove' : 'Disconnect all'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SheetFrame>
  );
}

function AddDestination({
  first,
  connectedChannelIds,
  autoPostThreshold,
  onCancel,
  onSaved,
}: {
  first: boolean;
  connectedChannelIds: Set<string>;
  autoPostThreshold: number;
  onCancel?: () => void;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [keyError, setKeyError] = useState('');
  const [verified, setVerified] = useState<{ key: string; workspaceId: string | null; channels: PumbleChannel[] } | null>(null);
  const [channelId, setChannelId] = useState('');
  const [saveError, setSaveError] = useState('');

  const verify = useMutation({
    mutationFn: async (key: string) => {
      const result = await verifyPumbleApiKey(key);
      const channels = await fetchPumbleChannels(key);
      return { workspaceId: result.workspace_id ?? null, channels: channels.channels };
    },
    onMutate: () => {
      setKeyError('');
      setVerified(null);
      setChannelId('');
    },
    onSuccess: ({ workspaceId, channels }, key) => {
      const open = channels.filter((c) => !connectedChannelIds.has(c.id));
      if (open.length === 0) {
        setKeyError(
          channels.length === 0
            ? 'No channels found. Make sure the API addon is installed and you have channel access.'
            : 'All accessible channels are already connected. Use a different API key or workspace.',
        );
        return;
      }
      setVerified({ key, workspaceId, channels: open });
      setChannelId(open[0].id);
    },
    onError: (err) => setKeyError(errorDetail(err, 'Could not verify API key or load channels.')),
  });

  const save = useMutation({
    mutationFn: () => {
      const channel = verified?.channels.find((c) => c.id === channelId);
      if (!verified || !channel) throw new Error('Select a channel.');
      return savePumbleConfig({
        api_key: verified.key,
        channel_id: channel.id,
        channel_name: channel.name,
        workspace_id: verified.workspaceId,
        label: label.trim() || undefined,
        auto_post_threshold: autoPostThreshold,
      });
    },
    onMutate: () => setSaveError(''),
    onSuccess: onSaved,
    onError: (err) =>
      setSaveError(err instanceof Error && err.message === 'Select a channel.' ? err.message : errorDetail(err, 'Failed to save Pumble destination.')),
  });

  const selected = verified?.channels.find((c) => c.id === channelId);
  const channelItems = (verified?.channels ?? []).map((c) => ({
    value: c.id,
    label: c.is_private ? `${c.name} (private)` : `#${c.name}`,
  }));

  return (
    <Section
      title={first ? 'Connect your first destination' : 'Add another destination'}
      actions={
        onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null
      }
      className="rounded-xl border p-4"
    >
      <form
        noValidate
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const key = apiKey.trim();
          if (!key) {
            setKeyError('Enter your Pumble API key.');
            return;
          }
          verify.mutate(key);
        }}
      >
        <Field data-invalid={Boolean(keyError) || undefined}>
          <FieldLabel htmlFor="pumble-api-key">Pumble API key</FieldLabel>
          <Input
            id="pumble-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            aria-invalid={Boolean(keyError) || undefined}
            placeholder="Pumble → API → Add API key"
            onChange={(e) => {
              setApiKey(e.target.value);
              setKeyError('');
              setVerified(null);
            }}
          />
          {keyError ? <FieldError>{keyError}</FieldError> : null}
        </Field>
        <Button type="submit" variant={verified ? 'outline' : 'default'} disabled={verify.isPending}>
          {verify.isPending ? <Loader2 className="animate-spin" /> : <Zap />}
          {verify.isPending ? 'Verifying…' : 'Verify & load channels'}
        </Button>
      </form>

      {verified ? (
        <div className="space-y-3 border-t pt-4">
          <Field>
            <FieldLabel htmlFor="pumble-dest-label">Label (optional)</FieldLabel>
            <Input
              id="pumble-dest-label"
              value={label}
              placeholder="e.g. Team jobs, Recruiting workspace"
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="pumble-channel">Target channel</FieldLabel>
            <Select items={channelItems} value={channelId} onValueChange={(v) => setChannelId(String(v ?? ''))}>
              <SelectTrigger id="pumble-channel" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {channelItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected?.is_private ? (
              <FieldDescription className="flex items-center gap-1 text-xs">
                <Lock className="size-3" />
                Private channel — add the API addon bot to this channel in Pumble.
              </FieldDescription>
            ) : null}
          </Field>
          {saveError ? <InlineError>{saveError}</InlineError> : null}
          <Button disabled={save.isPending || !channelId} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            {save.isPending ? 'Saving…' : 'Save destination'}
          </Button>
        </div>
      ) : null}
    </Section>
  );
}
