import { Config } from '../lib/config'
import { CoordinationCoordinator } from '../lib/coordination/coordinator'
import { CoordinationParticipant } from '../lib/coordination/participant'
import { CoordinationState } from '../lib/coordination/types'
import type { Intent } from '../lib/coordination/types'
import type { RoundCommitment } from '../lib/nostr'
import {
  RelayPrivateMessageHarness,
  createConnectedNostr,
  createParticipant,
  fail,
  pass,
  teardown,
  waitFor,
  type ParticipantBundle,
} from './helpers'

const MIX_AMOUNT = Config.mixAmountShannons
const MIN_PARTICIPANTS = Config.minParticipants
const RELAY_PROPAGATION_MS = 800
const PRIVATE_SUBSCRIPTION_SETTLE_MS = 500
const ROUND_COMPLETE_TIMEOUT_MS = 5 * 60 * 1000
const DROPOUT_TIMEOUT_MS = Config.timeouts.outputCollectionMs + 30_000

async function main(): Promise<void> {
  console.log('=== CONIC CoinJoin Integration Test ===')

  await checkInfrastructure()

  const p1 = await createParticipant()
  const p2 = await createParticipant()
  const p3 = await createParticipant()
  const bundles = [p1, p2, p3]
  installRoundCommitmentCache(bundles)

  try {
    await runPhase1IntentPublishing(p1, p2, p3)
    const round = await runPhase2CoordinatorAssignment(p1, p2, p3)
    const txHash = await runPhase3FullCoinJoinFlow(round)
    await runPhase4PrivacyVerification(round.coordinator, p3, txHash)
    await runPhase5DropoutHandling()
  } finally {
    roundTeardown(roundsToTeardown)
    await Promise.all(bundles.map(teardown))
  }

  console.log('=== All SCs passed ===')
}

type LiveRound = {
  coordinator: CoordinationCoordinator
  coordinatorNostr: ParticipantBundle['nostr']
  participants: CoordinationParticipant[]
  bundles: ParticipantBundle[]
  harness: RelayPrivateMessageHarness
}

const roundsToTeardown = new Set<LiveRound>()

async function runPhase1IntentPublishing(
  p1: ParticipantBundle,
  p2: ParticipantBundle,
  p3: ParticipantBundle,
): Promise<void> {
  console.log('\n--- Phase 1: Intent Publishing (SC-1, SC-2) ---')

  const intentPayload = { amount: MIX_AMOUNT, minParticipants: MIN_PARTICIPANTS }
  const [id1, id2, id3] = await Promise.all([
    p1.nostr.publishIntent(intentPayload),
    p2.nostr.publishIntent(intentPayload),
    p3.nostr.publishIntent(intentPayload),
  ])

  for (const [label, id] of [
    ['p1', id1],
    ['p2', id2],
    ['p3', id3],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      fail('SC-2', `${label} intent ID is not a valid Nostr event ID: ${id}`)
    }
  }
  pass('SC-2', `Published intents ${id1.slice(0, 8)}…, ${id2.slice(0, 8)}…, ${id3.slice(0, 8)}…`)

  await new Promise((resolve) => setTimeout(resolve, RELAY_PROPAGATION_MS))

  const intents = await p3.nostr.listIntents()
  const found = intents.filter(
    (intent) => intent.amount === MIX_AMOUNT && intent.minParticipants === MIN_PARTICIPANTS,
  )
  if (found.length < MIN_PARTICIPANTS) {
    fail('SC-1', `Expected at least ${MIN_PARTICIPANTS} intents, got ${found.length}`)
  }

  p1.intent = found.find((intent) => intent.id === id1)
  p2.intent = found.find((intent) => intent.id === id2)
  p3.intent = found.find((intent) => intent.id === id3)

  if (!p1.intent || !p2.intent || !p3.intent) {
    fail('SC-1', 'Could not locate one or more published intents in relay results')
  }

  pass('SC-1', `listIntents() returned ${found.length} matching intents`)
}

async function runPhase2CoordinatorAssignment(
  p1: ParticipantBundle,
  p2: ParticipantBundle,
  p3: ParticipantBundle,
): Promise<LiveRound> {
  console.log('\n--- Phase 2: Coordinator Assignment (SC-3) ---')

  const intents = await p3.nostr.listIntents()
  const matched = intents.filter(
    (intent) => intent.amount === MIX_AMOUNT && intent.minParticipants === MIN_PARTICIPANTS,
  )
  if (matched.length < MIN_PARTICIPANTS) {
    fail('SC-3', `Participant 3 only found ${matched.length} intents`)
  }

  const coordinatorNostr = await createConnectedNostr()
  const roundIntents: Intent[] = [p1.intent!, p2.intent!, p3.intent!]
  const coordinator = new CoordinationCoordinator({
    nostr: coordinatorNostr,
    privacy: p3.privacy,
    ckb: p3.ckb,
    intents: roundIntents,
  })
  installRoundCommitmentMirror([p1, p2, p3], coordinatorNostr)

  const participants = [p1, p2, p3].map(
    (bundle) =>
      new CoordinationParticipant({
        nostr: bundle.nostr,
        privacy: bundle.privacy,
        ckb: bundle.ckb,
        intent: bundle.intent!,
        coinjoinParticipant: bundle.coinjoinParticipant,
        privateKey: bundle.inputPrivateKey,
        changeAddress: bundle.changeAddress,
        outputAddress: bundle.outputAddress,
      }),
  )

  const harness = new RelayPrivateMessageHarness()
  for (const [index, bundle] of [p1, p2, p3].entries()) {
    harness.attachParticipant(bundle, participants[index]!)
  }
  harness.attachCoordinator(coordinator, coordinatorNostr)

  const round = {
    coordinator,
    coordinatorNostr,
    participants,
    bundles: [p1, p2, p3],
    harness,
  }
  roundsToTeardown.add(round)

  await new Promise((resolve) => setTimeout(resolve, PRIVATE_SUBSCRIPTION_SETTLE_MS))

  pass('SC-3', 'Participant 3 matched the intents and assumed the coordinator role')
  return round
}

async function runPhase3FullCoinJoinFlow(round: LiveRound): Promise<string> {
  console.log('\n--- Phase 3: Full CoinJoin Flow (SC-4) ---')
  const disposePhaseTrace = round.coordinator.on('phase_change', (phase) => {
    console.log(`[TRACE] phase=${phase}`)
  })

  let txHash: string | undefined
  let failureReason: string | undefined

  const outcome = new Promise<void>((resolve, reject) => {
    const disposeComplete = round.coordinator.on('round_complete', (hash) => {
      txHash = hash
      disposeFail()
      resolve()
    })
    const disposeFail = round.coordinator.on('round_failed', (reason) => {
      failureReason = reason
      disposeComplete()
      reject(new Error(reason))
    })
  })

  const roundStartFailure = round.coordinator.startRound().then(
    () => new Promise<never>(() => undefined),
    async (error) => {
      throw error
    },
  )

  await Promise.race([
    outcome,
    roundStartFailure,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('ROUND_COMPLETE_TIMEOUT')), ROUND_COMPLETE_TIMEOUT_MS)
    }),
  ]).catch((error) => {
    disposePhaseTrace()
    const participantStatus = round.participants
      .map((participant, index) => {
        const reason =
          participant.state === CoordinationState.FAILED
            ? ` reason=${participant.context.failureReason ?? 'unknown'}`
            : ''
        return `p${index + 1}:${participant.state}${reason}`
      })
      .join(', ')
    fail(
      'SC-4',
      `${failureReason ? `round_failed: ${failureReason}` : String(error)} | participants=${participantStatus}`,
    )
  })
  disposePhaseTrace()

  if (!txHash || !/^0x[a-f0-9]{64}$/.test(txHash)) {
    fail('SC-4', `Invalid or missing tx hash: ${String(txHash)}`)
  }
  pass('SC-4', `Round completed with tx hash ${txHash}`)

  await waitFor(
    async () => (await round.bundles[2]!.ckb.getTransaction(txHash!)) !== undefined,
    60_000,
    2_000,
    'tx confirmed on-chain',
  ).catch(() => fail('SC-4', 'TX was not confirmed on-chain within 60 seconds'))

  pass('SC-4', 'Transaction confirmed on-chain')
  return txHash
}

async function runPhase4PrivacyVerification(
  coordinator: CoordinationCoordinator,
  observer: ParticipantBundle,
  txHash: string,
): Promise<void> {
  console.log('\n--- Phase 4: Privacy Verification (SC-5) ---')

  const confirmedTx = await observer.ckb.getTransaction(txHash)
  if (!confirmedTx) {
    fail('SC-5', 'Unable to fetch confirmed transaction')
  }

  const mixOutputs = confirmedTx.outputs.filter((output) => output.capacity === MIX_AMOUNT)
  if (mixOutputs.length !== MIN_PARTICIPANTS) {
    fail(
      'SC-5',
      `Expected ${MIN_PARTICIPANTS} equal mix outputs of ${MIX_AMOUNT}, found ${mixOutputs.length}`,
    )
  }
  pass('SC-5', `Confirmed ${mixOutputs.length} equal-capacity mix outputs`)

  const state = coordinator.debugState()
  if (state.inputsByPubkey.size !== MIN_PARTICIPANTS) {
    fail('SC-5', `inputsByPubkey has ${state.inputsByPubkey.size} entries`)
  }
  if (state.outputsByFreshKey.size !== MIN_PARTICIPANTS) {
    fail('SC-5', `outputsByFreshKey has ${state.outputsByFreshKey.size} entries`)
  }

  const participantPubkeys = new Set(state.inputsByPubkey.keys())
  for (const [freshKey, outputAddress] of state.outputsByFreshKey) {
    if (participantPubkeys.has(freshKey)) {
      fail('SC-5', `Fresh output key ${freshKey.slice(0, 8)}… overlaps an input pubkey`)
    }

    for (const inputPubkey of participantPubkeys) {
      if (outputAddress.includes(inputPubkey)) {
        fail('SC-5', `Output address for ${freshKey.slice(0, 8)}… leaks input pubkey material`)
      }
    }
  }

  pass('SC-5', 'Coordinator state keeps inputs and fresh outputs in separate keyspaces')
}

async function runPhase5DropoutHandling(): Promise<void> {
  console.log('\n--- Phase 5: Dropout Handling (SC-6) ---')

  const d1 = await createParticipant()
  const d2 = await createParticipant()
  const d3 = await createParticipant()
  const bundles = [d1, d2, d3]
  installRoundCommitmentCache(bundles)

  try {
    await runPhase1IntentPublishing(d1, d2, d3)

    const coordinatorNostr = await createConnectedNostr()
    const coordinator = new CoordinationCoordinator({
      nostr: coordinatorNostr,
      privacy: d3.privacy,
      ckb: d3.ckb,
      intents: [d1.intent!, d2.intent!, d3.intent!],
    })
    installRoundCommitmentMirror([d1, d2, d3], coordinatorNostr)

    const participants = [d1, d2, d3].map(
      (bundle) =>
        new CoordinationParticipant({
          nostr: bundle.nostr,
          privacy: bundle.privacy,
          ckb: bundle.ckb,
          intent: bundle.intent!,
          coinjoinParticipant: bundle.coinjoinParticipant,
          privateKey: bundle.inputPrivateKey,
          changeAddress: bundle.changeAddress,
          outputAddress: bundle.outputAddress,
        }),
    )

    const harness = new RelayPrivateMessageHarness()
    harness.attachParticipant(d1, participants[0]!)
    harness.attachParticipant(d2, participants[1]!)
    harness.attachParticipant(d3, participants[2]!)
    harness.attachCoordinator(coordinator, coordinatorNostr)

    await new Promise((resolve) => setTimeout(resolve, PRIVATE_SUBSCRIPTION_SETTLE_MS))

    let dropoutTriggered = false
    const disposePhaseTrace = coordinator.on('phase_change', async (phase) => {
      console.log(`[TRACE] dropout-phase=${phase}`)
      if (phase === 'INPUT_COLLECTION' && !dropoutTriggered) {
        dropoutTriggered = true
        await d2.nostr.disconnect().catch(() => undefined)
      }
    })

    let roundFailedReason: string | undefined
    const outcome = new Promise<void>((resolve, reject) => {
      const disposeComplete = coordinator.on('round_complete', (hash) => {
        reject(new Error(`Unexpected round_complete ${hash}`))
      })
      const disposeFail = coordinator.on('round_failed', (reason) => {
        roundFailedReason = reason
        disposeComplete()
        resolve()
      })
      void disposeFail
    })

    const roundStartFailure = coordinator.startRound().then(
      () => new Promise<never>(() => undefined),
      async (error) => {
        throw error
      },
    )

    await Promise.race([
      outcome,
      roundStartFailure,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`SC-6 timeout after ${DROPOUT_TIMEOUT_MS}ms`)),
          DROPOUT_TIMEOUT_MS,
        )
      }),
    ]).catch((error) => {
      disposePhaseTrace()
      fail('SC-6', String(error))
    })
    disposePhaseTrace()

    if (!roundFailedReason) {
      fail('SC-6', 'Coordinator did not emit a failure reason')
    }
    pass('SC-6', `Dropout detected and round failed gracefully: ${roundFailedReason}`)

    harness.restore()
    coordinator.destroy()
    await coordinatorNostr.disconnect().catch(() => undefined)
    for (const participant of participants) {
      participant.destroy()
    }
  } finally {
    await Promise.all(bundles.map(teardown))
  }
}

async function checkInfrastructure(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(Config.nostrRelayUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`Nostr relay not reachable at ${Config.nostrRelayUrl}`))
    }, 3_000)
    ws.onopen = () => {
      clearTimeout(timer)
      ws.close()
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`Nostr relay not reachable at ${Config.nostrRelayUrl}`))
    }
  })

  await fetch(Config.ckbRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'get_tip_block_number',
      params: [],
    }),
  }).catch(() => {
    fail('PREFLIGHT', `CKB devnet not reachable at ${Config.ckbRpcUrl}`)
  })

  pass('PREFLIGHT', 'Nostr relay reachable and CKB devnet RPC responding')
}

function roundTeardown(rounds: Set<LiveRound>): void {
  for (const round of rounds) {
    round.harness.restore()
    round.coordinator.destroy()
    void round.coordinatorNostr.disconnect().catch(() => undefined)
    for (const participant of round.participants) {
      participant.destroy()
    }
    rounds.delete(round)
  }
}

function installRoundCommitmentCache(bundles: ParticipantBundle[]): void {
  const cache = new Map<string, Promise<RoundCommitment | undefined>>()

  for (const bundle of bundles) {
    const target = bundle.nostr
    const original = target.getRoundCommitment.bind(bundle.nostr)

    target.getRoundCommitment = async (coordinationId: string) => {
      const existing = cache.get(coordinationId)
      if (existing) {
        return await existing
      }

      const pending = (async () => {
        const result = await original(coordinationId)
        if (result === undefined) {
          cache.delete(coordinationId)
        }
        return result
      })()
      cache.set(coordinationId, pending)
      return await pending
    }
  }
}

function installRoundCommitmentMirror(
  bundles: ParticipantBundle[],
  coordinatorNostr: ParticipantBundle['nostr'],
): void {
  const mirrored = new Map<string, RoundCommitment>()

  const coordinatorTarget = coordinatorNostr
  const originalPublish = coordinatorTarget.publishRoundCommitment.bind(coordinatorNostr)

  coordinatorTarget.publishRoundCommitment = async (params) => {
    const id = await originalPublish(params)
    mirrored.set(params.coordinationId, {
      id,
      pubkey: coordinatorNostr.publicKey,
      coordinationId: params.coordinationId,
      matchedIntents: [...params.matchedIntents],
      rsaPubkeyFingerprint: params.rsaPubkeyFingerprint,
      createdAt: Math.floor(Date.now() / 1000),
    })
    return id
  }

  for (const bundle of bundles) {
    const target = bundle.nostr
    const originalGet = target.getRoundCommitment.bind(bundle.nostr)
    target.getRoundCommitment = async (coordinationId: string) => {
      return mirrored.get(coordinationId) ?? (await originalGet(coordinationId))
    }
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
