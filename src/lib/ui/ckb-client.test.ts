import { describe, expect, it } from 'vitest'

import { createCkbClient } from './ckb-client'

describe('createCkbClient', () => {
  it('uses the configured devnet RPC endpoint', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ scripts: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })

    const client = await createCkbClient({
      network: 'devnet',
      ckbRpcUrl: 'http://127.0.0.1:28114',
      nostrRelayUrl: 'ws://127.0.0.1:8080',
      mixAmountShannons: '100000000000',
      minParticipants: 3,
    })

    expect(client.url).toBe('http://127.0.0.1:28114')
  })

  it('uses the configured testnet RPC endpoint', async () => {
    const client = await createCkbClient({
      network: 'testnet',
      ckbRpcUrl: 'https://testnet.ckb.example/rpc',
      nostrRelayUrl: 'wss://relay.example',
      mixAmountShannons: '100000000000',
      minParticipants: 3,
    })

    expect(client.url).toBe('https://testnet.ckb.example/rpc')
  })
})
