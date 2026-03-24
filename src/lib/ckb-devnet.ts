import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ccc } from '@ckb-ccc/core'

import { CkbService, type CoinjoinParticipant } from './ckb'

const TX_TIMEOUT_MS = Number(process.env.CKB_SMOKE_TX_TIMEOUT_MS ?? '120000')

export class DevnetCkbService extends CkbService {
  readonly #rpcUrl: string

  constructor(rpcUrl: string) {
    super(new ccc.ClientPublicTestnet({ url: rpcUrl }))
    this.#rpcUrl = rpcUrl
  }

  async waitForReady(): Promise<void> {
    const scriptsOverride = await tryLoadCccSystemScriptsFromOffckb()

    this.client = new ccc.ClientPublicTestnet({
      url: this.#rpcUrl,
      ...(scriptsOverride
        ? {
            scripts: scriptsOverride as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>,
          }
        : {}),
    })

    const maxAttempts = 30
    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        await this.client.getTip()
        return
      } catch {
        await sleep(2_000)
      }
    }

    throw new Error(`RPC not ready at ${this.#rpcUrl} after ${maxAttempts} attempts`)
  }

  async loadDevnetKeys(): Promise<string[]> {
    const keys = await loadOffckbDevnetPrivateKeys()

    const keyedBalances = await Promise.all(
      keys.map(async (privateKey) => {
        const signer = new ccc.SignerCkbPrivateKey(this.client, privateKey)
        const balance = BigInt(await signer.getBalance())

        return {
          privateKey,
          balance,
        }
      }),
    )

    return keyedBalances
      .filter(({ balance }) => balance > 0n)
      .sort((left, right) => {
        if (left.balance === right.balance) return 0
        return left.balance > right.balance ? -1 : 1
      })
      .map(({ privateKey }) => privateKey)
  }

  async createParticipant(
    privateKey: string,
    targetCapacity: bigint,
  ): Promise<CoinjoinParticipant> {
    return await super.createParticipant(privateKey, targetCapacity)
  }

  async smokeTransfer(senderKey: string, receiverKey: string, amount: bigint): Promise<string> {
    const senderSigner = new ccc.SignerCkbPrivateKey(this.client, senderKey)
    const receiverSigner = new ccc.SignerCkbPrivateKey(this.client, receiverKey)
    const receiverAddressObj = await receiverSigner.getRecommendedAddressObj()

    const tx = ccc.Transaction.from({
      outputs: [
        {
          lock: receiverAddressObj.script,
          capacity: amount,
        },
      ],
      outputsData: ['0x'],
    })

    await tx.completeInputsByCapacity(senderSigner)
    await tx.completeFeeBy(senderSigner, 1000)

    const txHash = await senderSigner.sendTransaction(tx)
    await this.client.waitTransaction(txHash, 0, TX_TIMEOUT_MS)
    return txHash
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function expandTilde(p: string): string {
  if (p === '~') return process.env.HOME ?? '/root'
  if (p.startsWith('~/')) {
    const home = process.env.HOME ?? '/root'
    return path.join(home, p.slice(2))
  }
  return p
}

function extractAllHex64(raw: string): string[] {
  const matches = [...raw.matchAll(/0x[a-fA-F0-9]{64}/g)].map((match) => match[0])
  return [...new Set(matches.map((key) => key.toLowerCase()))]
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
        if (keys.length >= 3) {
          return keys
        }
      } catch {
        // try next candidate
      }
    }
  }

  const rawAccounts = offckbAccountsOutput()
  const keys = extractAllHex64(rawAccounts)
  if (keys.length < 3) {
    throw new Error(`Unable to load enough offckb private keys. Extracted=${keys.length}`)
  }
  return keys
}

async function tryLoadCccSystemScriptsFromOffckb(): Promise<Record<string, unknown> | undefined> {
  let raw: string
  try {
    raw = runOffckbCommand(['system-scripts', '--export-style', 'ccc'])
  } catch {
    return undefined
  }

  try {
    const jsonStart = raw.indexOf('{')
    if (jsonStart !== -1) {
      raw = raw.substring(jsonStart)
    }
    const parsed = JSON.parse(raw) as unknown

    let scriptsObject = (parsed as { devnet?: unknown }).devnet ?? parsed
    if (
      typeof scriptsObject === 'object' &&
      scriptsObject !== null &&
      'scripts' in scriptsObject &&
      typeof (scriptsObject as { scripts?: unknown }).scripts === 'object'
    ) {
      scriptsObject = (scriptsObject as { scripts: unknown }).scripts
    }

    if (typeof scriptsObject !== 'object' || scriptsObject === null) return undefined

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

    if (!normalized[ccc.KnownScript.NervosDao]) {
      normalized[ccc.KnownScript.NervosDao] = {
        codeHash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
        hashType: 'type',
        cellDeps: [],
      }
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined
  } catch {
    return undefined
  }
}
