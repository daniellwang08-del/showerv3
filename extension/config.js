/**
 * Fallback backend URL when the dashboard has not synced one yet.
 *
 * - Local dev with Vite (recommended): open http://<lan-ip>:5173 once; the
 *   extension auto-syncs that origin and proxies API calls through Vite.
 * - Direct API only: set to http://localhost:8000 (or http://<lan-ip>:8000).
 *
 * No trailing slash, no /api/v1 suffix.
 */
export const DEFAULT_BACKEND_URL = "http://172.20.1.140:5173";
