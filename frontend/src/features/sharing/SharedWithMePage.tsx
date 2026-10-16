import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MessageSquareQuote, Timer, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchIncomingShares } from '@/api/reportShareApi';
import { PageLayout } from '@/components/app/PageLayout';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { IncomingShare } from '@/types/reportShare';
import { relativeAgo } from '../interviews/interviewsModel';
import { INCOMING_SHARES_KEY, initials, sharedReportPath, shortDate } from './shareModel';

/** Every report other NAO users shared with the signed-in account. */
export function SharedWithMePage() {
  const query = useQuery({ queryKey: INCOMING_SHARES_KEY, queryFn: fetchIncomingShares, staleTime: 60_000 });
  const shares = query.data?.shares ?? [];

  return (
    <PageLayout
      title="Shared with me"
      description="Job search reports other people shared with your account. Each one is live and read only."
      width="wide"
    >
      {query.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading shared reports">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      ) : query.isError ? (
        <div className="rounded-2xl border border-dashed px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">Could not load shared reports.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : shares.length ? (
        <ul aria-label="Shared reports" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shares.map((share) => (
            <SharedCard key={share.id} share={share} />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/60 px-6 py-12 text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand">
            <Users className="size-5" aria-hidden />
          </span>
          <h2 className="mt-3 text-sm font-semibold">Nothing shared with you yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            When someone shares their job search report with your account email, it shows up here. You can share yours from
            the Interviews page.
          </p>
          <Link to="/app/interviews" className={buttonVariants({ variant: 'outline', size: 'sm', className: 'mt-4' })}>
            Go to Interviews
          </Link>
        </div>
      )}
    </PageLayout>
  );
}

function SharedCard({ share }: { share: IncomingShare }) {
  return (
    <li>
      <Link
        to={sharedReportPath(share.id)}
        className="group flex h-full flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs transition-colors outline-none hover:border-brand/40 hover:bg-brand/[0.03] focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand/20 to-brand/5 text-sm font-semibold text-brand"
          >
            {initials(share.owner_name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{share.owner_name}</p>
            <p className="truncate text-xs text-muted-foreground">{share.owner_headline || 'Job search report'}</p>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
        </div>
        {share.message ? (
          <p className="flex gap-2 text-xs text-muted-foreground">
            <MessageSquareQuote className="mt-px size-3.5 shrink-0 text-brand" aria-hidden />
            <span className="line-clamp-2">{share.message}</span>
          </p>
        ) : null}
        <p className="mt-auto flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          <span>Shared {relativeAgo(share.shared_at) ?? shortDate(share.shared_at)}</span>
          {share.expires_at ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <Timer className="size-3" aria-hidden />
                Until {shortDate(share.expires_at)}
              </span>
            </>
          ) : null}
          {!share.last_viewed_at ? (
            <span className="ml-auto rounded-full bg-brand/10 px-1.5 py-0.5 font-semibold text-brand">New</span>
          ) : null}
        </p>
      </Link>
    </li>
  );
}
