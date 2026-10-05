import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { JOB_PARAM } from './useOpenJob';

const DetailContentPanel = lazy(() =>
  import('@/components/extraction/DetailContentPanel').then((m) => ({ default: m.DetailContentPanel })),
);

function DetailSkeleton() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** Right-side job detail, addressable from anywhere via `?job=<id>`. */
export function JobDetailSheet({ isAdmin }: { isAdmin: boolean }) {
  const [params, setParams] = useSearchParams();
  const jobId = params.get(JOB_PARAM);

  const close = () =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(JOB_PARAM);
      return next;
    });

  return (
    <Sheet open={!!jobId} onOpenChange={(open) => !open && close()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none data-[side=right]:md:w-[min(1000px,88vw)]"
      >
        <SheetTitle className="sr-only">Job details</SheetTitle>
        {jobId ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <Suspense fallback={<DetailSkeleton />}>
              <DetailContentPanel key={jobId} validJobId={jobId} onClose={close} isAdmin={isAdmin} />
            </Suspense>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
