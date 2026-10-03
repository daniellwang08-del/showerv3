import { defineConfig, type ConfigEnv, type UserConfig } from 'vite'
import { visualizer } from 'rollup-plugin-visualizer'
import base from './vite.config'

/** `npx vite build -c vite.analyze.config.ts` → stats.html bundle treemap. */
export default defineConfig((env: ConfigEnv) => {
  const config = (typeof base === 'function' ? base(env) : base) as UserConfig
  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      visualizer({
        filename: process.env.ANALYZE_OUT || 'stats.html',
        template: (process.env.ANALYZE_TEMPLATE as 'treemap' | 'raw-data') || 'treemap',
        gzipSize: true,
      }),
    ],
  }
})
