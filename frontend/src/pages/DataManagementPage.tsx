import { ChartColumnIncreasing } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import { DataManagementAnalyticsSection } from '../components/data-management/DataManagementAnalyticsSection';
import { JobCleanupSection } from '../components/data-management/JobCleanupSection';
import { pagePad } from '../ui/tokens';

export function DataAnalysisManagementPage() {
  return (
    <PageScrollArea>
      <div className={pagePad}>
        <PageHeader
          icon={ChartColumnIncreasing}
          title="Data Analysis"
          description="Review jobs added to Atomspace, user activity, and scrape platforms — then purge stale or unwanted jobs by age or regex pattern."
        />
        <DataManagementAnalyticsSection />
        <JobCleanupSection />
      </div>
    </PageScrollArea>
  );
}
