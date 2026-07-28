import { ChartColumnIncreasing } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { DataManagementAnalyticsSection } from '../components/data-management/DataManagementAnalyticsSection';
import { DataManagementOpsSection } from '../components/data-management/DataManagementOpsSection';

export function DataAnalysisManagementPage() {
  return (
    <PageScrollArea>
      <div className="w-full space-y-4 px-3 py-4 sm:space-y-5 sm:px-5 sm:py-5">
        <PageHeader
          icon={ChartColumnIncreasing}
          gradient="from-slate-700 to-slate-900"
          title="Data Analysis & Management"
          description="Analyze jobs added to Atomspace, user activity, and scrape platforms - then delete or revalidate by period and filters."
        />
        <DataManagementAnalyticsSection />
        <DataManagementOpsSection />
      </div>
    </PageScrollArea>
  );
}

/** @deprecated Use DataAnalysisManagementPage */
export const DataManagementPage = DataAnalysisManagementPage;
