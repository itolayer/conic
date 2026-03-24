import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ccc } from '@ckb-ccc/core'

const RPC_URL = process.env.CKB_RPC_URL ?? 'http://127.0.0.1:28114'

const AMOUNT_CKB = ccc.fixedPointFrom(process.env.CKB_SMOKE_AMOUNT_CKB ?? '100')

const SENDER_INDEX = Number(process.env.CKB_SMOKE_SENDER_INDEX ?? '0')
const RECEIVER_INDEX = Number(process.env.CKB_SMOKE_RECEIVER_INDEX ?? '1')
const TX_TIMEOUT_MS = Number(process.env.CKB_SMOKE_TX_TIMEOUT_MS ?? '120000')

function expandTilde(p: string): string {
  if (p === '~') return process.env.HOME ?? '/root'
  if (p.startsWith('~/')) {
    const home = process.env.HOME ?? '/root'
    return path.join(home, p.slice(2))
  }
  return p
}

function extractAllHex64(raw: string): string[] {
  // Private keys, hashes, and other 32-byte fields can look similar.
  // In offckb's key files/accounts output, the private keys are expected to be
  // 0x-prefixed 32-byte hex strings, so we extract those and select by index.
  const matches = [...raw.matchAll(/0x[a-fA-F0-9]{64}/g)].map((m) => m[0])
  return [...new Set(matches.map((k) => k.toLowerCase()))]
}

function runOffckbCommand(args: string[]): string {
  try {
    return execFileSync('offckb', args, { encoding: 'utf8' })
  } catch {
    return execFileSync('docker', ['exec', 'conic-ckb-node', 'offckb', ...args], {
      encoding: 'utf8',
    })
  }
}

function offckbConfigListOutput(): unknown {
  const out = runOffckbCommand(['config', 'list'])
  // the output may contain prefix logs like "config file: ...". Need to parse JSON strictly.
  const jsonStart = out.indexOf('{')
  if (jsonStart !== -1) {
    return JSON.parse(out.substring(jsonStart))
  }
  return JSON.parse(out)
}

function offckbAccountsOutput(): string {
  return runOffckbCommand(['accounts'])
}

async function loadOffckbDevnetPrivateKeys(): Promise<string[]> {
  const configList = offckbConfigListOutput() as {
    devnet?: { dataPath?: string }
  }

  const dataPath = configList.devnet?.dataPath ? expandTilde(configList.devnet.dataPath) : undefined

  if (dataPath) {
    const candidateKeysPaths = [
      path.join(dataPath, 'account', 'keys'),
      path.join(dataPath, 'account', 'keys.json'),
      path.join(dataPath, 'account', 'keys.txt'),
    ]

    for (const candidate of candidateKeysPaths) {
      try {
        const raw = await fs.readFile(candidate, 'utf8')
        const keys = extractAllHex64(raw)
        if (keys.length > Math.max(SENDER_INDEX, RECEIVER_INDEX)) {
          return keys
        }
      } catch {
        // try next candidate
      }
    }
  }

  // Fallback: ask offckb to print accounts, then extract private keys by regex.
  // This keeps the smoke test resilient against unknown key file formats.
  const rawAccounts = offckbAccountsOutput()
  const keys = extractAllHex64(rawAccounts)
  if (keys.length <= Math.max(SENDER_INDEX, RECEIVER_INDEX)) {
    throw new Error(
      `Unable to load enough offckb private keys. Extracted=${keys.length}, senderIndex=${SENDER_INDEX}, receiverIndex=${RECEIVER_INDEX}`,
    )
  }
  return keys
}

async function tryLoadCccSystemScriptsFromOffckb(): Promise<Record<string, unknown> | undefined> {
  // Best-effort for local runs. If it fails, we can still fall back to CCC's
  // built-in system script mappings for testnet.
  let raw: string
  try {
    raw = runOffckbCommand(['system-scripts', '--export-style', 'ccc'])
  } catch (e) {
    console.warn('WARN: Failed to export system scripts from offckb:', e)
    return undefined
  }

  try {
    const jsonStart = raw.indexOf('{')
    if (jsonStart !== -1) {
      raw = raw.substring(jsonStart)
    }
    const parsed = JSON.parse(raw) as unknown

    let scriptsObject = (parsed as { devnet?: unknown })?.devnet ?? parsed
    if (
      typeof scriptsObject === 'object' &&
      scriptsObject !== null &&
      'scripts' in scriptsObject &&
      typeof (scriptsObject as { scripts?: unknown }).scripts === 'object'
    ) {
      scriptsObject = (scriptsObject as { scripts: unknown }).scripts
    }

    if (typeof scriptsObject !== 'object' || scriptsObject === null) return undefined

    // Normalize: only keep the scripts that CCC knows about.
    const normalized: Record<string, unknown> = {}
    const scriptsRecord = scriptsObject as Record<string, unknown>
    const nestedScripts =
      typeof (scriptsObject as { scripts?: unknown }).scripts === 'object' &&
      (scriptsObject as { scripts?: unknown }).scripts !== null
        ? (scriptsObject as { scripts: Record<string, unknown> }).scripts
        : undefined

    for (const known of Object.values(ccc.KnownScript) as string[]) {
      const found = scriptsRecord[known] ?? nestedScripts?.[known]
      if (found !== undefined) normalized[known] = found
    }

    // TODO ask OffCKB to export Nervos DAO script for CCC
    if (!normalized[ccc.KnownScript.NervosDao]) {
      normalized[ccc.KnownScript.NervosDao] = {
        codeHash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
        hashType: 'type',
        cellDeps: [],
      }
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined
  } catch (e) {
    console.warn('WARN: Failed to parse exported system scripts:', e)
    return undefined
  }
}

async function waitForRpcReady(client: ccc.ClientPublicTestnet): Promise<void> {
  const maxAttempts = 30
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await client.getTip()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw new Error(`RPC not ready at ${RPC_URL} after ${maxAttempts} attempts`)
}

async function main(): Promise<void> {
  if (!Number.isInteger(SENDER_INDEX) || SENDER_INDEX < 0) {
    throw new Error(`Invalid CKB_SMOKE_SENDER_INDEX=${process.env.CKB_SMOKE_SENDER_INDEX}`)
  }
  if (!Number.isInteger(RECEIVER_INDEX) || RECEIVER_INDEX < 0) {
    throw new Error(`Invalid CKB_SMOKE_RECEIVER_INDEX=${process.env.CKB_SMOKE_RECEIVER_INDEX}`)
  }

  const scriptsOverride = await tryLoadCccSystemScriptsFromOffckb()

  const client = new ccc.ClientPublicTestnet({
    url: RPC_URL,
    ...(scriptsOverride
      ? {
          scripts: scriptsOverride as unknown as Record<
            ccc.KnownScript,
            ccc.ScriptInfoLike | undefined
          >,
        }
      : {}),
  })

  await waitForRpcReady(client)

  const privateKeys = await loadOffckbDevnetPrivateKeys()
  const senderPk = privateKeys[SENDER_INDEX]
  const receiverPk = privateKeys[RECEIVER_INDEX]

  if (!senderPk || !receiverPk) {
    throw new Error(
      `Missing private keys. senderPk=${String(Boolean(senderPk))}, receiverPk=${String(
        Boolean(receiverPk),
      )}`,
    )
  }

  const senderSigner = new ccc.SignerCkbPrivateKey(client, senderPk)
  const receiverSigner = new ccc.SignerCkbPrivateKey(client, receiverPk)
  const receiverAddressObj = await receiverSigner.getRecommendedAddressObj()

  const tx = ccc.Transaction.from({
    outputs: [
      {
        lock: receiverAddressObj.script,
        capacity: AMOUNT_CKB,
      },
    ],
    outputsData: ['0x'],
  })

  await tx.completeInputsByCapacity(senderSigner)
  await tx.completeFeeBy(senderSigner, 1000)

  const txHash = await senderSigner.sendTransaction(tx)
  await client.waitTransaction(txHash, 0, TX_TIMEOUT_MS)
  console.log(txHash)

  process.exit(0)
}

main().catch((err) => {
  console.error('Smoke test failed:', err)
  process.exit(1)
})
