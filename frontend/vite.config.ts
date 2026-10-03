import { defineConfig, loadEnv, createLogger } from 'vite'
import type { ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  return false
}

function detectLanHost(): string | undefined {
  // IMPORTANT: trim() defends against the Windows CMD trap where
  //   `set LAN_HOST=%VALUE% && npm run dev`
  // captures the space before `&&` into the value. Without this trim,
  // a stray space produced HMR URLs like `ws://172.20.1.140%20:5173/...`
  // which silently broke websocket reconnection.
  const fromEnv = (process.env.VITE_HMR_HOST || process.env.LAN_HOST || '').trim()
  if (fromEnv) return fromEnv

  const candidates: string[] = []
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal && net.address) {
        candidates.push(net.address.trim())
      }
    }
  }
  return candidates.find(isPrivateIpv4) ?? candidates[0]
}

/**
 * When the backend API restarts (uvicorn --reload after a backend edit) or is
 * briefly down, the proxied TCP connection is reset by the upstream. http-proxy
 * emits an 'error' event; if it is unhandled Vite prints a noisy
 * `read ECONNRESET` stack trace, and the browser sees a hung/aborted request.
 *
 * These upstream drops are expected in dev, so we handle them: log one concise
 * line and, for HTTP, return a clean 503 the client can retry. WebSocket sockets
 * are just closed quietly (the client reconnects on its own).
 */
const EXPECTED_UPSTREAM_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'])

const BENIGN_UPSTREAM_CODE_RE = /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT)\b/

/**
 * Vite attaches its OWN proxy 'error' handlers (for http, ws, and the per-socket
 * ws upgrade) in addition to ours, and each logs a full stack trace via
 * `config.logger.error`. When the backend restarts (uvicorn --reload) those are
 * just expected upstream drops, so we filter out that specific noise while letting
 * every other error through. Our own handler still logs one concise line + serves
 * a clean 503 / closes the socket, so nothing is silently swallowed.
 */
function isBenignProxyNoise(msg: unknown): boolean {
  if (typeof msg !== 'string') return false
  return /proxy.*error/is.test(msg) && BENIGN_UPSTREAM_CODE_RE.test(msg)
}

function createQuietLogger() {
  const logger = createLogger()
  const baseError = logger.error
  logger.error = (msg, options) => {
    if (isBenignProxyNoise(msg)) return
    baseError(msg, options)
  }
  return logger
}

function attachProxyErrorHandler(proxy: { on(event: 'error', listener: (err: NodeJS.ErrnoException, req: IncomingMessage, res: ServerResponse | Socket) => void): void }, label: string) {
  proxy.on('error', (err, _req, res) => {
    const code = err.code
    if (code && EXPECTED_UPSTREAM_CODES.has(code)) {
      console.warn(`[vite] ${label} upstream unavailable (${code}) - backend restarting or down; client will retry.`)
    } else {
      console.error(`[vite] ${label} proxy error:`, err.message)
    }

    // ServerResponse (HTTP) → send a clean 503 instead of leaving the socket hung.
    if (res && 'writeHead' in res) {
      const httpRes = res as ServerResponse
      if (!httpRes.headersSent) {
        try {
          httpRes.writeHead(503, { 'Content-Type': 'application/json' })
        } catch {
          /* headers already flushed */
        }
      }
      try {
        httpRes.end(JSON.stringify({ detail: 'Backend temporarily unavailable (restarting). Please retry.' }))
      } catch {
        /* response already closed */
      }
      return
    }

    // net.Socket (WebSocket upgrade) → close quietly; the WS client reconnects.
    if (res && 'destroy' in res) {
      try {
        ;(res as Socket).destroy()
      } catch {
        /* socket already gone */
      }
    }
  })
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000'
  const wsTarget = apiTarget.replace(/^http/i, 'ws')
  const lanHost = detectLanHost()
  const port = Number(env.VITE_DEV_PORT || 5173)

  const proxy: Record<string, ProxyOptions> = {
    '/api/v1/ws': {
      target: wsTarget,
      ws: true,
      changeOrigin: true,
      configure: (p) => attachProxyErrorHandler(p, '/api/v1/ws (ws)'),
    },
    '/api': {
      target: apiTarget,
      changeOrigin: true,
      configure: (p) => attachProxyErrorHandler(p, '/api'),
    },
  }

  return {
    plugins: [
      react({
        babel: { plugins: [['babel-plugin-react-compiler', {}]] },
      }),
    ],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    build: {
      rollupOptions: {
        output: {
          // Only vendors every route needs get named chunks; route-only libraries
          // (recharts, markdown, stripe) must stay unassigned so Rollup keeps them
          // behind their lazy pages instead of hoisting them into the entry.
          manualChunks(id) {
            const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id)
            if (!m) return undefined
            const pkg = m[1].replace('\\', '/')
            if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'react'
            if (pkg === 'react-router' || pkg === 'react-router-dom' || pkg.startsWith('@tanstack/query') || pkg === '@tanstack/react-query') return 'framework'
            if (pkg.startsWith('@base-ui/') || pkg.startsWith('@floating-ui/') || pkg === 'sonner') return 'ui'
            return undefined
          },
        },
      },
    },
    customLogger: createQuietLogger(),
    server: {
      host: '0.0.0.0',
      port,
      strictPort: true,
      // HMR must use the LAN IP when clients open http://172.x.x.x:5173
      hmr: lanHost
        ? { host: lanHost, port, protocol: 'ws' }
        : { clientPort: port },
      proxy,
    },
    preview: {
      host: '0.0.0.0',
      port,
      strictPort: true,
      proxy,
    },
  }
})
