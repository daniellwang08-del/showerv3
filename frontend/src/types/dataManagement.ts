export interface DataManagementMonth {
  year: number;
  month: number;
  label: string;
}

export interface AppliedVsFetchedDay {
  date: string;
  applied_count: number;
  fetched_count: number;
  /** @deprecated alias of fetched_count */
  posted_count?: number;
}

export interface AppliedVsFetchedSeries {
  year: number;
  month: number;
  timezone: string;
  days: AppliedVsFetchedDay[];
  totals: {
    applied_count: number;
    fetched_count: number;
    posted_count?: number;
  };
}

/** @deprecated use AppliedVsFetchedSeries */
export type AppliedVsPostedSeries = AppliedVsFetchedSeries;
/** @deprecated use AppliedVsFetchedDay */
export type AppliedVsPostedDay = AppliedVsFetchedDay;

export interface RemoteVsFetchedDay {
  date: string;
  remote_count: number;
  fetched_count: number;
  posted_count?: number;
}

export interface RemoteVsFetchedSeries {
  year: number;
  month: number;
  timezone: string;
  days: RemoteVsFetchedDay[];
  totals: {
    remote_count: number;
    fetched_count: number;
    posted_count?: number;
  };
}

/** @deprecated use RemoteVsFetchedSeries */
export type RemoteVsPostedSeries = RemoteVsFetchedSeries;

export interface AnalysisUser {
  id: string;
  email: string;
  name: string;
}

/** Per-user chart metrics. Sheet/Pumble are system-wide (Distribution chart). */
export type UserActivityMetric = 'board_added' | 'applied';

export interface MultiSeriesMeta {
  key: string;
  label: string;
  user_id?: string;
  metric?: string;
  platform?: string | null;
  kind?: string;
}

export interface MultiSeriesResult {
  year: number;
  month: number;
  timezone: string;
  days: Array<Record<string, string | number>>;
  series: MultiSeriesMeta[];
  totals: Record<string, number>;
  platforms?: string[];
  spiders?: string[];
}

export interface PipelineSeriesResult extends MultiSeriesResult {
  totals: Record<string, number> & { backlog_now?: number };
}
