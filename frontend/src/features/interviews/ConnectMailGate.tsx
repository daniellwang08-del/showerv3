import { CalendarClock, ListChecks, Loader2, Mail, ShieldCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { startMailConnect } from '@/api/interviewsApi';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const BENEFITS = [
  {
    icon: CalendarClock,
    title: 'Every interview on one calendar',
    text: 'Invites, reschedules and booking links are picked up from your inbox automatically.',
  },
  {
    icon: ListChecks,
    title: 'Stages and next steps per company',
    text: 'See where each process stands, what is left, and what you need to do next.',
  },
  {
    icon: ShieldCheck,
    title: 'Read-only and private',
    text: 'Only hiring emails are analysed. NAO never sends, deletes or stores your email bodies.',
  },
];

const PROVIDERS = ['Gmail', 'Outlook', 'Yahoo', 'iCloud', 'Exchange', 'Any IMAP'];

const PREVIEW = [
  { label: 'Screening', tone: 'bg-sky-500', cards: 2 },
  { label: 'Interviewing', tone: 'bg-violet-500', cards: 3 },
  { label: 'Final round', tone: 'bg-fuchsia-500', cards: 1 },
  { label: 'Offer', tone: 'bg-emerald-500', cards: 1 },
];

export function ConnectMailGate({
  serverConfigured,
  reconnect = false,
}: {
  serverConfigured: boolean;
  reconnect?: boolean;
}) {
  const [leaving, setLeaving] = useState(false);
  const connect = () => {
    setLeaving(true);
    startMailConnect();
  };

  return (
    <section
      aria-label="Connect your email"
      className="jobs-summary-card relative overflow-hidden rounded-2xl border bg-card/90 shadow-xs backdrop-blur-sm"
    >
      <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:items-center">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/5 px-2.5 py-1 text-xs font-medium text-brand">
            <Sparkles className="size-3.5" aria-hidden />
            {reconnect ? 'Reconnect required' : 'One step to unlock'}
          </span>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">
            {reconnect ? 'Reconnect your email' : 'Connect your email to track interviews'}
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {reconnect
              ? 'Your mail access expired or was revoked. Sign in again to keep your interview pipeline up to date.'
              : 'NAO reads your hiring emails and builds your interview pipeline: which companies you are talking to, what stage each one is at, and what is scheduled next.'}
          </p>

          <ul className="mt-6 space-y-4">
            {BENEFITS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <span
                  aria-hidden
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand"
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              className="rounded-full bg-gradient-to-r from-brand to-brand/80 px-5 shadow-md shadow-brand/25"
              disabled={!serverConfigured || leaving}
              onClick={connect}
            >
              {leaving ? <Loader2 className="animate-spin" /> : <Mail />}
              {reconnect ? 'Reconnect email' : 'Connect email'}
            </Button>
            <p className="text-xs text-muted-foreground">Secure sign-in with your provider. Takes under a minute.</p>
          </div>
          {!serverConfigured ? (
            <p role="status" className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
              Mail access isn't configured on this server yet. An admin needs to add the Nylas API key and client id.
            </p>
          ) : null}

          <div className="mt-6">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Works with</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {PROVIDERS.map((p) => (
                <li key={p} className="rounded-full border bg-background/60 px-2.5 py-1 text-xs font-medium">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div aria-hidden className="relative hidden select-none lg:block">
          <div className="absolute -inset-6 rounded-3xl bg-gradient-to-br from-brand/10 via-transparent to-fuchsia-500/10 blur-2xl" />
          <div className="relative grid grid-cols-4 gap-2.5 rounded-2xl border bg-background/70 p-3 shadow-sm backdrop-blur">
            {PREVIEW.map((col) => (
              <div key={col.label} className="min-w-0 space-y-2">
                <p className="flex items-center gap-1.5 truncate text-[10px] font-semibold text-muted-foreground">
                  <span className={cn('size-1.5 rounded-full', col.tone)} />
                  {col.label}
                </p>
                {Array.from({ length: col.cards }, (_, i) => (
                  <div key={i} className="space-y-1.5 rounded-lg border bg-card p-2">
                    <div className="h-2 w-3/4 rounded bg-foreground/15" />
                    <div className="h-1.5 w-1/2 rounded bg-muted-foreground/20" />
                    <div className="flex gap-0.5 pt-0.5">
                      {Array.from({ length: 6 }, (_, s) => (
                        <span key={s} className={cn('h-1 flex-1 rounded-full', s <= i + 1 ? col.tone : 'bg-muted')} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
