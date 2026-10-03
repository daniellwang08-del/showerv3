// Job lists shown in the panel. Each maps to a server dashboard view, so
// filtering and paging happen in the database, not in the browser.

export const LISTS = {
  ready: {
    title: "Ready to apply",
    hint: "Tailored resume built, not applied yet",
    view: "ready",
    count: "ready",
    sort: "match_score",
    empty: "Nothing is ready yet. Jobs show up here once their tailored resume is built.",
  },
  today: {
    title: "New today",
    hint: "Added to your pool today",
    view: "today",
    count: "today",
    empty: "No new jobs today yet.",
  },
  needs: {
    title: "Needs resume",
    hint: "Description ready, tailored resume not built",
    view: "available",
    count: "available",
    tailor: true,
    empty: "Every analyzed job already has a tailored resume.",
  },
  remote: {
    title: "Remote",
    hint: "Remote roles in your pool",
    view: "all",
    remoteOnly: true,
    count: "remote",
    empty: "No remote jobs match these filters.",
  },
  mine: {
    title: "Added by you",
    hint: "Jobs you submitted by URL",
    view: "mine",
    count: "mine",
    empty: "You have not added any jobs yet. Paste job links on Home to add them.",
  },
  all: {
    title: "All jobs",
    hint: "Everything in your pool",
    view: "all",
    count: "all",
    empty: "No jobs match these filters.",
  },
  applied: {
    title: "Applied today",
    hint: "Marked applied today",
    view: "applied_today",
    count: "applied_today",
    sort: "applied_at",
    empty: "You have not applied to anything today yet.",
  },
};

export const SORTS = [
  { value: "created_at", label: "Newest" },
  { value: "match_score", label: "Best match" },
  { value: "posted_date", label: "Recently posted" },
  { value: "company", label: "Company A to Z" },
];

export const MIN_SCORES = [
  { value: 0, label: "Any match" },
  { value: 50, label: "50+" },
  { value: 65, label: "65+" },
  { value: 80, label: "80+" },
];

/** Server query for a list, its filters, and a page. */
export function listQuery(listId, filters, page, perPage, timezone) {
  const def = LISTS[listId] || LISTS.all;
  const sort = filters.sort || def.sort || "created_at";
  return {
    view: def.view,
    page,
    per_page: perPage,
    sort,
    order: sort === "company" ? "asc" : "desc",
    q: (filters.q || "").trim() || undefined,
    remote_only: def.remoteOnly || filters.remoteOnly || undefined,
    min_match_score: filters.minScore || undefined,
    timezone,
  };
}

export function queryKey(query) {
  return JSON.stringify(query);
}
