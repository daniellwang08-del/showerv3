import { useSearchParams } from 'react-router-dom';
import { ChartColumnIncreasing, Eraser } from 'lucide-react';
import { PageLayout } from '@/components/app/PageLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AnalyticsPanel } from './AnalyticsPanel';
import { CleanupPanel } from './CleanupPanel';

const TABS = ['analytics', 'cleanup'] as const;
type DataTab = (typeof TABS)[number];

const isTab = (v: string | null): v is DataTab => TABS.includes(v as DataTab);

export function AdminDataPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab: DataTab = isTab(raw) ? raw : 'analytics';

  const setTab = (value: unknown) => {
    const next = String(value);
    if (!isTab(next)) return;
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === 'analytics') params.delete('tab');
        else params.set('tab', next);
        return params;
      },
      { replace: true },
    );
  };

  return (
    <PageLayout
      title="Data"
      description="Review jobs added to NAO, user activity, and scrape platforms — then purge stale or unwanted jobs by age or pattern."
      width="wide"
    >
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList>
          <TabsTrigger value="analytics" className="px-3">
            <ChartColumnIncreasing aria-hidden />
            Analytics
          </TabsTrigger>
          <TabsTrigger value="cleanup" className="px-3">
            <Eraser aria-hidden />
            Cleanup
          </TabsTrigger>
        </TabsList>
        <TabsContent value="analytics">
          <AnalyticsPanel />
        </TabsContent>
        <TabsContent value="cleanup">
          <CleanupPanel />
        </TabsContent>
      </Tabs>
    </PageLayout>
  );
}
