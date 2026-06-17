import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import os from 'node:os'

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000'
  const wsTarget = apiTarget.replace(/^http/i, 'ws')
  const lanHost = detectLanHost()
  const port = Number(env.VITE_DEV_PORT || 5173)

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port,
      strictPort: true,
      // HMR must use the LAN IP when clients open http://172.x.x.x:5173
      hmr: lanHost
        ? { host: lanHost, port, protocol: 'ws' }
        : { clientPort: port },
      proxy: {
        '/api/v1/ws': {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
        },
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: '0.0.0.0',
      port,
      strictPort: true,
      proxy: {
        '/api/v1/ws': {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
        },
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
