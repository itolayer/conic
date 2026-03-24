import { ccc } from '@ckb-ccc/core'

import { DevnetCkbService } from '../lib/ckb-devnet'
import { Config } from '../lib/config'
import { CoordinationCoordinator } from '../lib/coordination/coordinator'
import { CoordinationParticipant } from '../lib/coordination/participant'
import type { CoordinationMessage, Intent } from '../lib/coordination/types'
import { NostrService } from '../lib/nostr'
import { PrivacyService } from '../lib/privacy'

export interface ParticipantBundle {
  nostr: NostrService
  privacy: PrivacyService
  ckb: DevnetCkbService
  inputPrivateKey: string
  outputPrivateKey: string
  changeAddress: string
  outputAddress: string
  coinjoinParticipant: Awaited<ReturnType<DevnetCkbService['createParticipant']>>
  intent?: Intent
}

let keyPoolPromise: Promise<string[]> | undefined
let keyCursor = 0

export class RelayPrivateMessageHarness {
  readonly #handlers = new Map<
    NostrService,
    Array<{
      acceptedTypes: Set<CoordinationMessage['type']>
      handle: (senderPubkey: string, message: CoordinationMessage) => Promise<void> | void
    }>
  >()
  readonly #restoreFns: Array<() => void> = []
  readonly #attachedNostr = new WeakSet<NostrService>()
  readonly #deliveryQueue = new WeakMap<NostrService, Promise<void>>()

  attachParticipant(bundle: ParticipantBundle, participant: CoordinationParticipant): void {
    this.#attach(bundle.nostr, participantMessageTypes, async (_senderPubkey, message) => {
      await participant.handleMessage(message)
    })
  }

  attachCoordinator(coordinator: CoordinationCoordinator, nostr: NostrService): void {
    this.#attach(nostr, coordinatorMessageTypes, async (senderPubkey, message) => {
      await coordinator.handleMessage(senderPubkey, message)
    })
  }

  restore(): void {
    while (this.#restoreFns.length > 0) {
      this.#restoreFns.pop()?.()
    }
    this.#handlers.clear()
  }

  #attach(
    nostr: NostrService,
    acceptedTypes: CoordinationMessage['type'][],
    handle: (senderPubkey: string, message: CoordinationMessage) => Promise<void> | void,
  ): void {
    const accepted = new Set(acceptedTypes)
    const handlers = this.#handlers.get(nostr) ?? []
    handlers.push({ acceptedTypes: accepted, handle })
    this.#handlers.set(nostr, handlers)

    if (this.#attachedNostr.has(nostr)) {
      return
    }

    const unsubscribe = nostr.onPrivateMessage((payload, senderPubkey) => {
      const message = payload as CoordinationMessage
      const previous = this.#deliveryQueue.get(nostr) ?? Promise.resolve()
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const currentHandlers = this.#handlers.get(nostr) ?? []
          for (const handlerEntry of currentHandlers) {
            if (!handlerEntry.acceptedTypes.has(message.type)) {
              continue
            }

            await handlerEntry.handle(senderPubkey ?? '', message)
          }
        })
      this.#deliveryQueue.set(nostr, next)
    })

    this.#restoreFns.push(unsubscribe)
    this.#attachedNostr.add(nostr)
  }
}

export async function createParticipant(): Promise<ParticipantBundle> {
  const [inputPrivateKey, outputPrivateKey] = await allocateKeys(2)

  const nostr = new NostrService()
  const privacy = new PrivacyService()
  const ckb = new DevnetCkbService(Config.ckbRpcUrl)

  await Promise.all([nostr.connect(Config.nostrRelayUrl), ckb.waitForReady()])

  const inputSigner = new ccc.SignerCkbPrivateKey(ckb.client, inputPrivateKey)
  const outputSigner = new ccc.SignerCkbPrivateKey(ckb.client, outputPrivateKey)
  const changeAddress = (await inputSigner.getRecommendedAddressObj()).toString()
  const outputAddress = (await outputSigner.getRecommendedAddressObj()).toString()
  const coinjoinParticipant = await ckb.createParticipant(
    inputPrivateKey,
    Config.mixAmountShannons + Config.minCellCapacityCkb + 10_000n,
  )

  return {
    nostr,
    privacy,
    ckb,
    inputPrivateKey,
    outputPrivateKey,
    changeAddress,
    outputAddress,
    coinjoinParticipant,
  }
}

export async function createConnectedNostr(): Promise<NostrService> {
  const nostr = new NostrService()
  await nostr.connect(Config.nostrRelayUrl)
  return nostr
}

export async function teardown(bundle: ParticipantBundle): Promise<void> {
  await bundle.nostr.disconnect().catch(() => undefined)
}

export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 200,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out waiting for: ${label}`)
}

export function pass(sc: string, msg: string): void {
  console.log(`[${sc}] PASS ${msg}`)
}

export function fail(sc: string, msg: string): never {
  throw new Error(`[${sc}] FAIL ${msg}`)
}

async function allocateKeys(count: number): Promise<string[]> {
  const allKeys = await loadKeyPool()
  if (allKeys.length < count) {
    throw new Error(`Not enough devnet keys available. Need ${count}, have ${allKeys.length}`)
  }

  const selected: string[] = []
  for (let i = 0; i < count; i += 1) {
    selected.push(allKeys[keyCursor % allKeys.length]!)
    keyCursor += 1
  }

  return selected
}

async function loadKeyPool(): Promise<string[]> {
  keyPoolPromise ??= (async () => {
    const ckb = new DevnetCkbService(Config.ckbRpcUrl)
    await ckb.waitForReady()
    return await ckb.loadDevnetKeys()
  })()

  return await keyPoolPromise
}

const participantMessageTypes: CoordinationMessage['type'][] = [
  'coordination_proposal',
  'heartbeat',
  'input_request',
  'blind_signature',
  'tx_proposal',
  'round_complete',
  'round_failed',
]

const coordinatorMessageTypes: CoordinationMessage['type'][] = [
  'heartbeat_ack',
  'input_submission',
  'output_submission',
  'tx_signature',
]
