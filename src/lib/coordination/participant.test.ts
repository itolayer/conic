import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CoordinationParticipant } from './participant'
import { CoordinationState, type Intent } from './types'
import { deriveCoordinationId } from './utils'

const intent: Intent = {
  id: 'intent-self',
  pubkey: 'participant-pubkey',
  amount: 100_000_000_000n,
  minParticipants: 3,
  createdAt: 1,
}

const rsaJwk: JsonWebKey = {
  kty: 'RSA',
  n: 'test-n',
  e: 'AQAB',
}

describe('CoordinationParticipant', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('ignores proposal if own intent not in matched_intents', async () => {
    const deps = createDeps()
    const participant = new CoordinationParticipant({ ...deps, intent })

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: ['intent-a', 'intent-b', 'intent-c'],
      coordinator_pubkey: 'coordinator',
    })

    expect(participant.state).toBe(CoordinationState.MATCHING)
    expect(participant.context.matchedIntents).toEqual([])
  })

  it('ignores input request if coordination_id does not match derived value', async () => {
    const deps = createDeps()
    const participant = new CoordinationParticipant({ ...deps, intent })

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: ['intent-self', 'intent-b', 'intent-c'],
      coordinator_pubkey: 'coordinator',
    })

    await participant.handleMessage({
      type: 'input_request',
      coordination_id: 'not-the-derived-id',
      rsa_public_key: rsaJwk,
    })

    expect(participant.state).toBe(CoordinationState.PROPOSING)
    expect(participant.context.failureReason).toBeUndefined()
  })

  it('rejects if RSA key fingerprint mismatches public commitment', async () => {
    const deps = createDeps({
      fingerprint: 'wrong-fingerprint',
      roundCommitmentFingerprint: 'expected-fingerprint',
    })
    const participant = new CoordinationParticipant({ ...deps, intent })
    const matchedIntents = ['intent-self', 'intent-b', 'intent-c']

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: matchedIntents,
      coordinator_pubkey: 'coordinator',
    })

    await participant.handleMessage({
      type: 'input_request',
      coordination_id: deriveCoordinationId(matchedIntents),
      rsa_public_key: rsaJwk,
    })

    expect(participant.state).toBe(CoordinationState.FAILED)
    expect(participant.context.failureReason).toContain('fingerprint mismatch')
  })

  it('retries round commitment lookup until it becomes available', async () => {
    const deps = createDeps()
    deps.nostr.getRoundCommitment = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({
        id: 'commitment',
        pubkey: 'coordinator',
        coordinationId: 'coordination',
        matchedIntents: ['intent-self', 'intent-b', 'intent-c'],
        rsaPubkeyFingerprint: 'fingerprint',
        createdAt: 1,
      })

    const participant = new CoordinationParticipant({
      ...deps,
      intent,
      coinjoinParticipant: {
        mixLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        changeLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        cells: [] as never[],
        inputCapacity: 100n,
      },
    })
    const matchedIntents = ['intent-self', 'intent-b', 'intent-c']
    const coordinationId = deriveCoordinationId(matchedIntents)

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: matchedIntents,
      coordinator_pubkey: 'coordinator',
    })
    await participant.handleMessage({
      type: 'heartbeat',
      coordination_id: coordinationId,
      status: 'waiting',
    })

    const requestPromise = participant.handleMessage({
      type: 'input_request',
      coordination_id: coordinationId,
      rsa_public_key: rsaJwk,
    })

    await vi.advanceTimersByTimeAsync(500)
    await requestPromise

    expect(participant.state).toBe(CoordinationState.INPUT_COLLECTION)
    expect(deps.nostr.getRoundCommitment).toHaveBeenCalledTimes(3)
  })

  it('completes blinding flow on valid proposal', async () => {
    const deps = createDeps()
    const participant = new CoordinationParticipant({
      ...deps,
      intent,
      coinjoinParticipant: {
        mixLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        changeLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        cells: [] as never[],
        inputCapacity: 100n,
      },
    })
    const matchedIntents = ['intent-self', 'intent-b', 'intent-c']
    const coordinationId = deriveCoordinationId(matchedIntents)

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: matchedIntents,
      coordinator_pubkey: 'coordinator',
    })
    await participant.handleMessage({
      type: 'heartbeat',
      coordination_id: coordinationId,
      status: 'waiting',
    })
    await participant.handleMessage({
      type: 'input_request',
      coordination_id: coordinationId,
      rsa_public_key: rsaJwk,
    })

    expect(deps.nostr.sendPrivateMessage).toHaveBeenCalledWith(
      'coordinator',
      expect.objectContaining({
        type: 'input_submission',
        coordination_id: coordinationId,
      }),
    )

    await participant.handleMessage({
      type: 'blind_signature',
      coordination_id: coordinationId,
      signed_blinded_token: new Uint8Array([7, 8, 9]),
    })

    expect(participant.state).toBe(CoordinationState.OUTPUT_COLLECTION)
    expect(participant.context.outputIdentityPubkey).toBeTruthy()
    expect(participant.context.outputIdentityPubkey).not.toBe(deps.nostr.publicKey)
    expect(deps.nostr.sendPrivateMessage).toHaveBeenLastCalledWith(
      'coordinator',
      expect.objectContaining({
        type: 'output_submission',
        coordination_id: coordinationId,
      }),
    )
  })

  it('handles heartbeat arriving before proposal', async () => {
    const deps = createDeps()
    const participant = new CoordinationParticipant({ ...deps, intent })
    const matchedIntents = ['intent-self', 'intent-b', 'intent-c']
    const coordinationId = deriveCoordinationId(matchedIntents)

    await participant.handleMessage({
      type: 'heartbeat',
      coordination_id: coordinationId,
      status: 'waiting',
    })
    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: matchedIntents,
      coordinator_pubkey: 'coordinator',
    })

    expect(participant.state).toBe(CoordinationState.HEARTBEAT)
    expect(deps.nostr.sendPrivateMessage).toHaveBeenCalledWith('coordinator', {
      type: 'heartbeat_ack',
      coordination_id: coordinationId,
    })
  })

  it('ignores duplicate proposals and heartbeats after entering input collection', async () => {
    const deps = createDeps()
    const participant = new CoordinationParticipant({
      ...deps,
      intent,
      coinjoinParticipant: {
        mixLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        changeLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        cells: [] as never[],
        inputCapacity: 100n,
      },
    })
    const matchedIntents = ['intent-self', 'intent-b', 'intent-c']
    const coordinationId = deriveCoordinationId(matchedIntents)

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: matchedIntents,
      coordinator_pubkey: 'coordinator',
    })
    await participant.handleMessage({
      type: 'heartbeat',
      coordination_id: coordinationId,
      status: 'waiting',
    })
    await participant.handleMessage({
      type: 'input_request',
      coordination_id: coordinationId,
      rsa_public_key: rsaJwk,
    })

    expect(participant.state).toBe(CoordinationState.INPUT_COLLECTION)
    expect(deps.nostr.sendPrivateMessage).toHaveBeenCalledTimes(2)

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: matchedIntents,
      coordinator_pubkey: 'coordinator',
    })
    await participant.handleMessage({
      type: 'heartbeat',
      coordination_id: coordinationId,
      status: 'waiting',
    })

    expect(participant.state).toBe(CoordinationState.INPUT_COLLECTION)
    expect(deps.nostr.sendPrivateMessage).toHaveBeenCalledTimes(2)
  })

  it('handles input request arriving before proposal', async () => {
    const deps = createDeps()
    const participant = new CoordinationParticipant({
      ...deps,
      intent,
      coinjoinParticipant: {
        mixLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        changeLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        cells: [] as never[],
        inputCapacity: 100n,
      },
    })
    const matchedIntents = ['intent-self', 'intent-b', 'intent-c']
    const coordinationId = deriveCoordinationId(matchedIntents)

    await participant.handleMessage({
      type: 'input_request',
      coordination_id: coordinationId,
      rsa_public_key: rsaJwk,
    })
    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: matchedIntents,
      coordinator_pubkey: 'coordinator',
    })

    expect(participant.state).toBe(CoordinationState.INPUT_COLLECTION)
    expect(deps.nostr.sendPrivateMessage).toHaveBeenCalledWith(
      'coordinator',
      expect.objectContaining({
        type: 'input_submission',
        coordination_id: coordinationId,
      }),
    )
  })

  it('abandons round if no heartbeat within 10s of proposal (§6.2)', async () => {
    const deps = createDeps()
    const participant = new CoordinationParticipant({ ...deps, intent })

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: ['intent-self', 'intent-b', 'intent-c'],
      coordinator_pubkey: 'coordinator',
    })

    vi.advanceTimersByTime(10_000)
    await vi.runOnlyPendingTimersAsync()

    expect(participant.state).toBe(CoordinationState.FAILED)
    expect(participant.context.intent.id).toBe(intent.id)
  })

  it('abandons round if coordinator message overdue by 2x phase timeout (§6.2)', async () => {
    const deps = createDeps()
    const participant = new CoordinationParticipant({ ...deps, intent })
    const matchedIntents = ['intent-self', 'intent-b', 'intent-c']
    const coordinationId = deriveCoordinationId(matchedIntents)

    await participant.handleMessage({
      type: 'coordination_proposal',
      matched_intents: matchedIntents,
      coordinator_pubkey: 'coordinator',
    })
    await participant.handleMessage({
      type: 'heartbeat',
      coordination_id: coordinationId,
      status: 'waiting',
    })
    await participant.handleMessage({
      type: 'input_request',
      coordination_id: coordinationId,
      rsa_public_key: rsaJwk,
    })

    vi.advanceTimersByTime(60_000)
    await vi.runOnlyPendingTimersAsync()

    expect(participant.state).toBe(CoordinationState.FAILED)
    expect(participant.context.failureReason).toContain('coordinator message overdue')
  })
})

function createDeps(overrides?: { fingerprint?: string; roundCommitmentFingerprint?: string }) {
  const fingerprint = overrides?.fingerprint ?? 'fingerprint'
  const roundCommitmentFingerprint = overrides?.roundCommitmentFingerprint ?? fingerprint

  return {
    nostr: {
      publicKey: 'participant-nostr-pubkey',
      sendPrivateMessage: vi.fn(async () => undefined),
      getRoundCommitment: vi.fn(async () => ({
        id: 'commitment',
        pubkey: 'coordinator',
        coordinationId: 'coordination',
        matchedIntents: ['intent-self', 'intent-b', 'intent-c'],
        rsaPubkeyFingerprint: roundCommitmentFingerprint,
        createdAt: 1,
      })),
    },
    privacy: {
      importPublicKey: vi.fn(async () => ({ type: 'public' }) as unknown as CryptoKey),
      computeFingerprint: vi.fn(async () => fingerprint),
      blind: vi.fn(async () => ({
        blindedMessage: new Uint8Array([1, 2, 3]),
        blindInverse: new Uint8Array([4, 5, 6]),
        preparedMessage: new Uint8Array([9, 9, 9]),
      })),
      finalize: vi.fn(async () => new Uint8Array([7, 8, 9])),
    },
    ckb: {
      createParticipant: vi.fn(async () => ({
        mixLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        changeLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        cells: [] as never[],
        inputCapacity: 100n,
      })),
      signInputs: vi.fn(async () => []),
    },
  }
}
