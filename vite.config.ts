import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { execFileSync } from 'node:child_process'
import { ccc } from '@ckb-ccc/core'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'conic-devnet-config',
      configureServer(server) {
        server.middlewares.use('/api/devnet-config', (_req, res) => {
          try {
            const raw = runOffckbCommand(['system-scripts', '--export-style', 'ccc'])
            const jsonStart = raw.indexOf('{')
            const parsed = JSON.parse(jsonStart === -1 ? raw : raw.slice(jsonStart)) as {
              devnet?: { scripts?: Record<string, unknown> } | Record<string, unknown>
              scripts?: Record<string, unknown>
            }
            const topLevel =
              typeof parsed.devnet === 'object' && parsed.devnet !== null ? parsed.devnet : parsed
            const scripts =
              typeof topLevel === 'object' &&
              topLevel !== null &&
              'scripts' in topLevel &&
              typeof topLevel.scripts === 'object' &&
              topLevel.scripts !== null
                ? topLevel.scripts
                : topLevel

            const normalized = normalizeDevnetScripts(scripts as Record<string, unknown>)

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ scripts: normalized }))
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            )
          }
        })
      },
    },
  ],
  test: {
    dir: 'src',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})

function runOffckbCommand(args: string[]): string {
  try {
    return execFileSync('offckb', args, { encoding: 'utf8' })
  } catch {
    return execFileSync('docker', ['exec', 'conic-ckb-node', 'offckb', ...args], {
      encoding: 'utf8',
    })
  }
}

function normalizeDevnetScripts(scripts: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...scripts }

  if (!normalized[ccc.KnownScript.NervosDao]) {
    normalized[ccc.KnownScript.NervosDao] = {
      codeHash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
      hashType: 'type',
      cellDeps: [],
    }
  }

  return normalized
}
