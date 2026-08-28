/**
 * Production dashboard / API origin (same host; nginx proxies /api → FastAPI).
 *
 * No trailing slash, no /api/v1 suffix.
 * Local Vite dev: temporarily set to http://localhost:5173 (or your LAN URL)
 * so the extension syncs from the open dashboard tab.
 */
export const DEFAULT_BACKEND_URL = "https://atomspace.it.com";
