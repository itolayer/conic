import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ccc } from '@ckb-ccc/core'

import type { CoinjoinParticipant } from '../ckb'
import { Config } from '../config'
import { CoordinationCoordinator } from './coordinator'
import { CoordinationState, type Intent } from './types'
import { deriveCoordinationId } from './utils'

const intents: Intent[] = [
  { id: 'intent-a', pubkey: 'alice', amount: 100_000_000_000n, minParticipants: 3, createdAt: 1 },
  { id: 'intent-b', pubkey: 'bob', amount: 100_000_000_000n, minParticipants: 3, createdAt: 2 },
  { id: 'intent-c', pubkey: 'carol', amount: 100_000_000_000n, minParticipants: 3, createdAt: 3 },
]

const retryableIntents: Intent[] = [
  ...intents,
  { id: 'intent-d', pubkey: 'dave', amount: 100_000_000_000n, minParticipants: 3, createdAt: 4 },
]

const participantSpec: CoinjoinParticipant = {
  mixLock: { codeHash: '0x1', hashType: 'type', args: '0x01' },
  changeLock: { codeHash: '0x1', hashType: 'type', args: '0x01' },
  cells: [] as never[],
  inputCapacity: 200_000_000_000n,
}

describe('CoordinationCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a round when N matching intents found', async () => {
    const deps = createDeps()
    const coordinator = new CoordinationCoordinator({
      ...deps,
      intents,
      participants: createParticipantMap(),
    })

    await coordinator.startRound()

    expect(coordinator.coordinationId).toBe(
      deriveCoordinationId(intents.map((intent) => intent.id)),
    )
    const proposals = deps.nostr.sendPrivateMessage.mock.calls.filter(
      ([, payload]) => payload.type === 'coordination_proposal',
    )
    expect(proposals).toHaveLength(3)
  })

  it('publishes round commitment before input_request', async () => {
    const order: string[] = []
    const deps = createDeps({
      onPublishRoundCommitment: () => order.push('commitment'),
      onSendPrivateMessage: (_recipient, payload) => order.push((payload as { type: string }).type),
    })
    const coordinator = new CoordinationCoordinator({
      ...deps,
      intents,
      participants: createParticipantMap(),
    })

    await coordinator.startRound()
    await coordinator.handleMessage('alice', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })
    await coordinator.handleMessage('bob', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })
    await coordinator.handleMessage('carol', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })

    expect(order.indexOf('commitment')).toBeLessThan(order.indexOf('input_request'))
  })

  it('sends input requests only after all heartbeat acknowledgements arrive', async () => {
    const deps = createDeps()
    const coordinator = new CoordinationCoordinator({
      ...deps,
      intents,
      participants: createParticipantMap(),
    })

    await coordinator.startRound()

    expect(
      deps.nostr.sendPrivateMessage.mock.calls.filter(
        ([, payload]) => payload.type === 'input_request',
      ),
    ).toHaveLength(0)

    await coordinator.handleMessage('alice', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })
    await coordinator.handleMessage('bob', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })

    expect(
      deps.nostr.sendPrivateMessage.mock.calls.filter(
        ([, payload]) => payload.type === 'input_request',
      ),
    ).toHaveLength(0)

    await coordinator.handleMessage('carol', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })

    expect(
      deps.nostr.sendPrivateMessage.mock.calls.filter(
        ([, payload]) => payload.type === 'input_request',
      ),
    ).toHaveLength(3)
    expect(coordinator.state).toBe(CoordinationState.INPUT_COLLECTION)
  })

  it('SC-6: retries with remaining participants on heartbeat timeout', async () => {
    const deps = createDeps()
    const coordinator = new CoordinationCoordinator({
      ...deps,
      intents: retryableIntents,
      participants: createParticipantMap(retryableIntents),
    })

    await coordinator.startRound()
    await coordinator.handleMessage('alice', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })
    await coordinator.handleMessage('bob', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })
    await coordinator.handleMessage('carol', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })

    vi.advanceTimersByTime(Config.timeouts.heartbeatMs)
    await vi.runOnlyPendingTimersAsync()

    expect(deps.nostr.publishRoundCommitment).toHaveBeenCalledTimes(2)
    expect(coordinator.state).not.toBe(CoordinationState.RETRY)
  })

  it('SC-6: fails gracefully on output collection timeout', async () => {
    const deps = createDeps()
    const coordinator = new CoordinationCoordinator({
      ...deps,
      intents,
      participants: createParticipantMap(),
    })

    await coordinator.startRound()
    for (const intent of intents) {
      await coordinator.handleMessage(intent.pubkey, {
        type: 'input_submission',
        coordination_id: coordinator.coordinationId!,
        inputs: [],
        change_address: `${intent.pubkey}-change`,
        blinded_token: new Uint8Array([1, 2, 3]),
      })
    }

    vi.advanceTimersByTime(Config.timeouts.outputCollectionMs)
    await vi.runOnlyPendingTimersAsync()

    expect(coordinator.state).toBe(CoordinationState.FAILED)
    expect(deps.nostr.sendPrivateMessage).toHaveBeenCalledWith(
      'alice',
      expect.objectContaining({ type: 'round_failed', reason: 'output_collection_timeout' }),
    )
  })

  it('fails instead of lingering in retry on input collection timeout', async () => {
    const deps = createDeps()
    const coordinator = new CoordinationCoordinator({
      ...deps,
      intents,
      participants: createParticipantMap(),
    })

    await coordinator.startRound()
    await coordinator.handleMessage('alice', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })
    await coordinator.handleMessage('bob', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })
    await coordinator.handleMessage('carol', {
      type: 'heartbeat_ack',
      coordination_id: coordinator.coordinationId!,
    })

    vi.advanceTimersByTime(Config.timeouts.inputCollectionMs)
    await vi.runOnlyPendingTimersAsync()

    expect(coordinator.state).toBe(CoordinationState.FAILED)
    expect(deps.nostr.sendPrivateMessage).toHaveBeenCalledWith(
      'alice',
      expect.objectContaining({ type: 'round_failed', reason: 'input_collection_timeout' }),
    )
  })

  it('does not log input-to-output mappings (SC-5)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const deps = createDeps()
    const coordinator = new CoordinationCoordinator({
      ...deps,
      intents,
      participants: createParticipantMap(),
    })

    await coordinator.startRound()

    expect(logSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })
})

function createDeps(overrides?: {
  onPublishRoundCommitment?: () => void
  onSendPrivateMessage?: (recipient: string, payload: Record<string, unknown>) => void
}) {
  return {
    nostr: {
      publicKey: 'coordinator-pubkey',
      publishRoundCommitment: vi.fn(async () => {
        overrides?.onPublishRoundCommitment?.()
        return 'commitment-id'
      }),
      sendPrivateMessage: vi.fn(async (recipient: string, payload: Record<string, unknown>) => {
        overrides?.onSendPrivateMessage?.(recipient, payload)
      }),
    },
    privacy: {
      generateRsaKeyPair: vi.fn(
        async () => ({ publicKey: {} as CryptoKey, privateKey: {} as CryptoKey }) as CryptoKeyPair,
      ),
      exportPublicKey: vi.fn(async () => ({ kty: 'RSA', n: 'n', e: 'AQAB' })),
      computeFingerprint: vi.fn(async () => 'fingerprint'),
      blindSign: vi.fn(async () => new Uint8Array([9, 9, 9])),
    },
    ckb: {
      client: {
        addressPrefix: 'ckt',
      } as ccc.ClientPublicTestnet,
      assembleCoinjoinTx: vi.fn(async () => ({
        unsignedTx: ccc.Transaction.from({ outputs: [], outputsData: [] }),
        mixOutputs: [],
        changeOutputs: [],
        inputsByParticipant: new Map<number, number[]>(),
        totalInputCapacity: 1n,
        totalOutputCapacity: 0n,
      })),
      mergeWitnesses: vi.fn((tx) => tx),
      broadcast: vi.fn(async () => '0xtxhash'),
    },
  }
}

function createParticipantMap(sourceIntents = intents): Map<string, CoinjoinParticipant> {
  return new Map(sourceIntents.map((intent) => [intent.pubkey, participantSpec]))
}
