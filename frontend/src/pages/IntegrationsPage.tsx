import { Puzzle } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '../components/layout/PageHeader';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { GoogleSheetsSettingsSection } from '../components/settings/GoogleSheetsSettingsSection';
import { PumbleSettingsSection } from '../components/settings/PumbleSettingsSection';

/** SettingsCard-shaped shell that uses an integration logo instead of a Lucide icon. */
function IntegrationCard({
  name,
  blurb,
  logoSrc,
  children,
}: {
  name: string;
  blurb: string;
  logoSrc: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm sm:p-4 md:p-5">
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-50 ring-1 ring-slate-200/80">
          <img src={logoSrc} alt="" className="h-5 w-5 object-contain" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-bold leading-tight text-slate-900">{name}</h2>
          <p className="mt-0.5 text-xs leading-snug text-slate-500">{blurb}</p>
        </div>
      </div>
      <div className="mt-2.5 min-w-0">{children}</div>
    </section>
  );
}

export function IntegrationsPage() {
  return (
    <PageScrollArea>
      <div className="w-full space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5">
        <PageHeader
          icon={Puzzle}
          gradient="from-slate-700 to-slate-900"
          title="Integrations"
          description="Connect Google Sheets and Pumble to auto-post jobs by match score, work mode, and excluded companies."
        />

        <div className="grid items-start gap-3 sm:gap-4 xl:grid-cols-2">
          <IntegrationCard
            name="Google Sheets"
            blurb="Post job URLs to spreadsheet tabs via round-robin groups."
            logoSrc="/integrations/google-sheets.svg"
          >
            <GoogleSheetsSettingsSection variant="page" />
          </IntegrationCard>

          <IntegrationCard
            name="Pumble"
            blurb="Post job URLs to channels as thread replies under a daily header."
            logoSrc="/integrations/pumble.svg"
          >
            <PumbleSettingsSection variant="page" />
          </IntegrationCard>
        </div>
      </div>
    </PageScrollArea>
  );
}
