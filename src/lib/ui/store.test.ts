// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { resetConicUiStore, selectActiveConfig, useConicStore } from './store'

describe('conic UI store', () => {
  beforeEach(() => {
    localStorage.clear()
    resetConicUiStore()
  })

  it('starts with devnet defaults', () => {
    const active = selectActiveConfig(useConicStore.getState())

    expect(active.network).toBe('devnet')
    expect(active.ckbRpcUrl).toBe('http://127.0.0.1:28114')
    expect(active.nostrRelayUrl).toBe('ws://127.0.0.1:8080')
  })

  it('keeps per-network endpoint profiles when switching networks', () => {
    useConicStore.getState().setNetwork('testnet')
    useConicStore.getState().updateEndpoint('ckbRpcUrl', 'https://testnet.ckb.dev/rpc')
    useConicStore.getState().updateEndpoint('nostrRelayUrl', 'wss://relay.example')

    let active = selectActiveConfig(useConicStore.getState())
    expect(active.network).toBe('testnet')
    expect(active.ckbRpcUrl).toBe('https://testnet.ckb.dev/rpc')
    expect(active.nostrRelayUrl).toBe('wss://relay.example')

    useConicStore.getState().setNetwork('devnet')
    active = selectActiveConfig(useConicStore.getState())
    expect(active.ckbRpcUrl).toBe('http://127.0.0.1:28114')
    expect(active.nostrRelayUrl).toBe('ws://127.0.0.1:8080')

    useConicStore.getState().setNetwork('testnet')
    active = selectActiveConfig(useConicStore.getState())
    expect(active.ckbRpcUrl).toBe('https://testnet.ckb.dev/rpc')
    expect(active.nostrRelayUrl).toBe('wss://relay.example')
  })
})
