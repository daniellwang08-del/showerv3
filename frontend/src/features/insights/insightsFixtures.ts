import type { ScraperStats } from '@/types/scraper';

export function makeStats(over: Partial<ScraperStats> = {}): ScraperStats {
  return {
    total_jobs: 200,
    total_remote: 80,
    unapplied_remote_jobs: 60,
    today_scraped: 12,
    today_remote: 5,
    today_posted: 0,
    my_jobs: 7,
    extracted_jobs: 150,
    ready_jobs: 40,
    today_ready_jobs: 3,
    today_available_jobs: 6,
    best_jobs: 25,
    good_jobs: 50,
    qualified_jobs: 70,
    scored_jobs: 120,
    avg_match_score: 64,
    available_jobs: 90,
    applied_jobs: 30,
    applied_today: 2,
    sheet_posted_jobs: 0,
    pumble_posted_jobs: 0,
    trends: {
      labels: ['2026-09-27', '2026-09-28'],
      ready: [1, 2],
      available: [3, 4],
      remote: [5],
      best: [7, 8],
    },
    sources: [],
    recent_runs: [],
    ...over,
  };
}

export const emptyStats = (): ScraperStats =>
  makeStats({
    total_jobs: 0,
    total_remote: 0,
    unapplied_remote_jobs: 0,
    today_scraped: 0,
    today_remote: 0,
    my_jobs: 0,
    ready_jobs: 0,
    applied_jobs: 0,
    applied_today: 0,
    trends: undefined,
  });
