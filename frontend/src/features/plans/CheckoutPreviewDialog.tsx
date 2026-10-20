import { Lock } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  BASE_RATE_CENTS,
  type CheckoutOffer,
  formatCount,
  formatRate,
  formatUsd,
  savingsCents,
  TEAM_PLAN,
  totalCents,
} from './plansModel';

export function CheckoutPreviewDialog({ offer, onClose }: { offer: CheckoutOffer | null; onClose: () => void }) {
  return (
    <Dialog open={offer !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {offer?.kind === 'credits' ? (
          <>
            <DialogHeader>
              <DialogTitle>Buy {offer.pkg.name} credits</DialogTitle>
              <DialogDescription>
                One-time purchase. The package goes to your store: add it to your balance or give it to someone by email.
              </DialogDescription>
            </DialogHeader>

            <dl className="divide-y divide-border/60 rounded-xl border border-border/60 bg-muted/30 text-sm">
              <Row label="Credits" value={formatCount(offer.pkg.credits)} />
              <Row label="Price per job" value={formatRate(offer.pkg.rateCents)} />
              {savingsCents(offer.pkg) > 0 ? (
                <Row
                  label={`Saved vs ${formatRate(BASE_RATE_CENTS)} per job`}
                  value={`-${formatUsd(savingsCents(offer.pkg))}`}
                  tone="text-status-ready"
                />
              ) : null}
              <Row label="Total" value={formatUsd(totalCents(offer.pkg))} strong />
            </dl>
          </>
        ) : offer?.kind === 'team' ? (
          <>
            <DialogHeader>
              <DialogTitle>Buy a TEAM package</DialogTitle>
              <DialogDescription>
                One-time purchase. Use it to open one team space, or give it to the person who will lead the team.
              </DialogDescription>
            </DialogHeader>

            <dl className="divide-y divide-border/60 rounded-xl border border-border/60 bg-muted/30 text-sm">
              <Row label="Team spaces" value="1" />
              <Row label="Members" value="No limit" />
              <Row label="Total" value={formatUsd(TEAM_PLAN.priceCents)} strong />
            </dl>
          </>
        ) : null}

        {offer ? (
          <>
            <Alert>
              <Lock />
              <AlertTitle>Checkout opens soon</AlertTitle>
              <AlertDescription>Payments are being set up. Nothing has been charged.</AlertDescription>
            </Alert>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button disabled>Continue to payment</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <dt className={strong ? 'font-semibold' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-base font-semibold' : 'font-medium'} ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}
