const nodeEnv =
  typeof process !== 'undefined' && typeof process.env === 'object' ? process.env : undefined

const viteEnv = typeof import.meta !== 'undefined' ? import.meta.env : undefined

function readEnv(name: string): string | undefined {
  return nodeEnv?.[name] ?? viteEnv?.[`VITE_${name}`]
}

export const Config = {
  nostrRelayUrl: readEnv('NOSTR_RELAY_URL') ?? 'ws://127.0.0.1:8080',
  ckbRpcUrl: readEnv('CKB_RPC_URL') ?? 'http://127.0.0.1:28114',
  mixAmountShannons: BigInt(readEnv('MIX_AMOUNT') ?? '100000000000'),
  minParticipants: Number(readEnv('MIN_PARTICIPANTS') ?? '3'),
  minCellCapacityCkb: 6_100_000_000n,
  timeouts: {
    heartbeatMs: 10_000,
    inputCollectionMs: 30_000,
    blindingMs: 30_000,
    outputCollectionMs: 90_000,
    signatureCollectionMs: 90_000,
    broadcastingMs: 120_000,
  },
} as const
