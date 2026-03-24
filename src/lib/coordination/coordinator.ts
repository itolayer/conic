import { ccc } from '@ckb-ccc/core'

import type { CkbService, CoinjoinParticipant, SignedWitnessEntry } from '../ckb'
import { Config } from '../config'
import type { NostrService } from '../nostr'
import type { PrivacyService } from '../privacy'
import { CoordinationState, type CoordinationMessage, type Intent } from './types'
import { deriveCoordinationId } from './utils'

type NostrLike = Pick<NostrService, 'publicKey' | 'publishRoundCommitment' | 'sendPrivateMessage'>

type PrivacyLike = Pick<
  PrivacyService,
  'generateRsaKeyPair' | 'exportPublicKey' | 'computeFingerprint' | 'blindSign'
>

type CkbLike = Pick<CkbService, 'assembleCoinjoinTx' | 'mergeWitnesses' | 'broadcast' | 'client'>

type CoordinatorOptions = {
  nostr: NostrLike
  privacy: PrivacyLike
  ckb: CkbLike
  intents: Intent[]
  participants?: Map<string, CoinjoinParticipant>
}

type InputSubmission = {
  intent: Intent
  blindedToken?: Uint8Array
  inputs?: CoinjoinParticipant['cells']
  changeAddress?: string
  signedWitnesses?: SignedWitnessEntry[]
}

type OutputSubmission = {
  outputAddress: string
}

type CoordinatorEventMap = {
  phase_change: [CoordinationState]
  round_complete: [string]
  round_failed: [string]
}

export class CoordinationCoordinator {
  readonly #nostr: NostrLike
  readonly #privacy: PrivacyLike
  readonly #ckb: CkbLike
  readonly #allIntents: Intent[]
  readonly #participantSpecs: Map<string, CoinjoinParticipant>

  #state: CoordinationState = CoordinationState.MATCHING
  #coordinationId?: string
  #rsaKeyPair?: CryptoKeyPair
  #roundPublicKey?: JsonWebKey | string
  #inputsByPubkey = new Map<string, InputSubmission>()
  #outputsByFreshKey = new Map<string, OutputSubmission>()
  #heartbeatAcks = new Set<string>()
  #timeoutHandle?: ReturnType<typeof setTimeout>
  #currentSigningTx?: Awaited<ReturnType<CkbLike['assembleCoinjoinTx']>>['unsignedTx']
  #signingQueue: Array<{ pubkey: string; inputIndices: number[] }> = []
  #eventHandlers = new Map<keyof CoordinatorEventMap, Set<(...args: unknown[]) => void>>()

  constructor({ nostr, privacy, ckb, intents, participants }: CoordinatorOptions) {
    this.#nostr = nostr
    this.#privacy = privacy
    this.#ckb = ckb
    this.#allIntents = intents
    this.#participantSpecs = participants ?? new Map()
  }

  get state(): CoordinationState {
    return this.#state
  }

  get coordinationId(): string | undefined {
    return this.#coordinationId
  }

  on<EventName extends keyof CoordinatorEventMap>(
    event: EventName,
    handler: (...args: CoordinatorEventMap[EventName]) => void,
  ): () => void {
    const handlers = this.#eventHandlers.get(event) ?? new Set()
    handlers.add(handler as (...args: unknown[]) => void)
    this.#eventHandlers.set(event, handlers)

    return () => {
      handlers.delete(handler as (...args: unknown[]) => void)
      if (handlers.size === 0) {
        this.#eventHandlers.delete(event)
      }
    }
  }

  debugState(): {
    inputsByPubkey: Map<string, InputSubmission>
    outputsByFreshKey: Map<string, string>
  } {
    return {
      inputsByPubkey: new Map(this.#inputsByPubkey),
      outputsByFreshKey: new Map(
        [...this.#outputsByFreshKey].map(([freshKey, submission]) => [
          freshKey,
          submission.outputAddress,
        ]),
      ),
    }
  }

  async startRound(intents = this.#allIntents): Promise<void> {
    if (intents.length < Config.minParticipants) {
      throw new Error('not enough intents to start a round')
    }

    this.#clearTimeout()
    this.#inputsByPubkey = new Map(
      intents.map((intent) => [intent.pubkey, { intent } satisfies InputSubmission]),
    )
    this.#outputsByFreshKey.clear()
    this.#heartbeatAcks.clear()

    this.#coordinationId = deriveCoordinationId(intents.map((intent) => intent.id))
    this.#rsaKeyPair = await this.#privacy.generateRsaKeyPair()
    this.#roundPublicKey = await this.#privacy.exportPublicKey(this.#rsaKeyPair.publicKey)
    const fingerprint = await this.#privacy.computeFingerprint(this.#rsaKeyPair.publicKey)

    this.#enterPhase(CoordinationState.PROPOSING)

    await this.#nostr.publishRoundCommitment({
      coordinationId: this.#coordinationId,
      matchedIntents: intents.map((intent) => intent.id),
      rsaPubkeyFingerprint: fingerprint,
    })

    this.#enterPhase(CoordinationState.HEARTBEAT)
    this.#startTimeout(CoordinationState.HEARTBEAT)

    for (const intent of intents) {
      await this.#nostr.sendPrivateMessage(intent.pubkey, {
        type: 'coordination_proposal',
        matched_intents: intents.map((candidate) => candidate.id),
        coordinator_pubkey: this.#nostr.publicKey,
      })
      await this.#nostr.sendPrivateMessage(intent.pubkey, {
        type: 'heartbeat',
        coordination_id: this.#coordinationId,
        status: 'waiting_for_ack',
      })
    }
  }

  async handleMessage(senderPubkey: string, message: CoordinationMessage): Promise<void> {
    switch (message.type) {
      case 'heartbeat_ack':
        if (this.#state !== CoordinationState.HEARTBEAT) {
          return
        }
        if (message.coordination_id !== this.#requireCoordinationId()) {
          return
        }
        this.#heartbeatAcks.add(senderPubkey)
        if (this.#heartbeatAcks.size >= this.#inputsByPubkey.size) {
          this.#enterPhase(CoordinationState.INPUT_COLLECTION)
          this.#startTimeout(CoordinationState.INPUT_COLLECTION)
          await this.#requestInputs()
        }
        return
      case 'input_submission':
        if (
          this.#state !== CoordinationState.HEARTBEAT &&
          this.#state !== CoordinationState.INPUT_COLLECTION
        ) {
          return
        }
        if (message.coordination_id !== this.#requireCoordinationId()) {
          return
        }
        this.#recordInputSubmission(senderPubkey, {
          blindedToken: normalizeBytes(message.blinded_token),
          inputs: message.inputs,
          changeAddress: message.change_address,
        })
        await this.#maybeFinishInputCollection()
        return
      case 'output_submission':
        if (
          this.#state !== CoordinationState.BLINDING &&
          this.#state !== CoordinationState.OUTPUT_COLLECTION
        ) {
          return
        }
        if (message.coordination_id !== this.#requireCoordinationId()) {
          return
        }
        this.#recordOutputSubmission(message.output_identity_pubkey ?? senderPubkey, {
          outputAddress: message.output_address,
        })
        await this.#maybeFinishOutputCollection()
        return
      case 'tx_signature':
        if (this.#state !== CoordinationState.SIGNING) {
          return
        }
        if (message.coordination_id !== this.#requireCoordinationId()) {
          return
        }
        await this.#applySignature(senderPubkey, message)
        return
      case 'coordination_proposal':
      case 'heartbeat':
      case 'input_request':
      case 'blind_signature':
      case 'tx_proposal':
      case 'round_complete':
      case 'round_failed':
        return
    }
  }

  destroy(): void {
    this.#clearTimeout()
  }

  async #maybeFinishInputCollection(): Promise<void> {
    if (![...this.#inputsByPubkey.values()].every((entry) => entry.blindedToken)) {
      return
    }

    this.#enterPhase(CoordinationState.BLINDING)
    this.#startTimeout(CoordinationState.BLINDING)

    for (const [pubkey, submission] of this.#inputsByPubkey) {
      await this.#nostr.sendPrivateMessage(pubkey, {
        type: 'blind_signature',
        coordination_id: this.#requireCoordinationId(),
        signed_blinded_token: await this.#privacy.blindSign(
          this.#requireKeyPair().privateKey,
          submission.blindedToken!,
        ),
      })
    }

    this.#enterPhase(CoordinationState.OUTPUT_COLLECTION)
    this.#startTimeout(CoordinationState.OUTPUT_COLLECTION)
  }

  async #maybeFinishOutputCollection(): Promise<void> {
    if (this.#outputsByFreshKey.size < this.#inputsByPubkey.size) {
      return
    }

    this.#enterPhase(CoordinationState.TX_ASSEMBLY)

    const mixLocks = await Promise.all(
      [...this.#outputsByFreshKey.values()].map(async ({ outputAddress }) => {
        const parsed = await ccc.Address.fromString(outputAddress, this.#ckb.client)
        return parsed.script
      }),
    )

    const participants = await Promise.all(
      [...this.#inputsByPubkey.values()].map(async (entry, index) => {
        const participant = this.#participantSpecs.get(entry.intent.pubkey)
        const cells = entry.inputs ?? participant?.cells
        if (!cells || cells.length === 0) {
          throw new Error(`missing participant inputs for ${entry.intent.pubkey}`)
        }

        const changeAddress = entry.changeAddress
        if (!changeAddress) {
          throw new Error(`missing participant change address for ${entry.intent.pubkey}`)
        }

        const changeLock = (await ccc.Address.fromString(changeAddress, this.#ckb.client)).script
        const inputCapacity =
          participant?.inputCapacity ??
          cells.reduce((sum, cell) => sum + BigInt(cell.cellOutput.capacity), 0n)

        const mixLock = mixLocks[index]
        if (!mixLock) {
          throw new Error(`missing mix output for participant index ${index}`)
        }

        return {
          mixLock,
          changeLock,
          cells,
          inputCapacity,
        } satisfies CoinjoinParticipant
      }),
    )

    const firstSubmission = this.#inputsByPubkey.values().next().value as
      | InputSubmission
      | undefined
    if (!firstSubmission) {
      throw new Error('no participant submissions available for tx assembly')
    }

    const assembled = await this.#ckb.assembleCoinjoinTx({
      participants,
      mixAmount: firstSubmission.intent.amount,
      feeRatePerKb: 1000n,
    })

    this.#currentSigningTx = assembled.unsignedTx
    this.#enterPhase(CoordinationState.SIGNING)
    this.#startTimeout(CoordinationState.SIGNING)
    this.#signingQueue = [...this.#inputsByPubkey.keys()]
      .map((pubkey, participantIndex) => ({
        pubkey,
        inputIndices: assembled.inputsByParticipant.get(participantIndex) ?? [],
      }))
      .sort((left, right) => {
        const leftFirst = left.inputIndices[0] ?? -1
        const rightFirst = right.inputIndices[0] ?? -1
        return rightFirst - leftFirst
      })

    await this.#requestNextSignature()
  }

  async #applySignature(
    senderPubkey: string,
    message: Extract<CoordinationMessage, { type: 'tx_signature' }>,
  ): Promise<void> {
    const nextSigner = this.#signingQueue[0]
    if (!nextSigner || nextSigner.pubkey !== senderPubkey) {
      return
    }

    const signedWitnesses =
      message.signed_witnesses?.map(({ index, witness }) => ({ index, witness })) ??
      message.witnesses.map((witness, index) => ({
        index: message.input_indices?.[index] ?? index,
        witness,
      }))

    this.#recordInputSubmission(senderPubkey, {
      signedWitnesses,
    })
    this.#currentSigningTx = this.#ckb.mergeWitnesses(this.#requireCurrentSigningTx(), [
      signedWitnesses,
    ])
    this.#signingQueue.shift()

    if (this.#signingQueue.length > 0) {
      await this.#requestNextSignature()
      return
    }

    this.#enterPhase(CoordinationState.BROADCASTING)
    this.#startTimeout(CoordinationState.BROADCASTING)
    const txHash = await this.#ckb.broadcast(this.#requireCurrentSigningTx())

    this.#enterPhase(CoordinationState.COMPLETE)
    this.#clearTimeout()

    for (const [pubkey] of this.#inputsByPubkey) {
      await this.#nostr.sendPrivateMessage(pubkey, {
        type: 'round_complete',
        coordination_id: this.#requireCoordinationId(),
        tx_hash: txHash,
      })
    }

    this.#emit('round_complete', txHash)
  }

  async #requestNextSignature(): Promise<void> {
    const nextSigner = this.#signingQueue[0]
    if (!nextSigner) {
      return
    }

    this.#startTimeout(CoordinationState.SIGNING)
    await this.#nostr.sendPrivateMessage(nextSigner.pubkey, {
      type: 'tx_proposal',
      coordination_id: this.#requireCoordinationId(),
      unsigned_tx_hex: this.#requireCurrentSigningTx(),
      input_indices: nextSigner.inputIndices,
    })
  }

  async #requestInputs(): Promise<void> {
    for (const [pubkey] of this.#inputsByPubkey) {
      await this.#nostr.sendPrivateMessage(pubkey, {
        type: 'input_request',
        coordination_id: this.#requireCoordinationId(),
        rsa_public_key: this.#requireRoundPublicKey(),
      })
    }
  }

  #recordInputSubmission(senderPubkey: string, partial: Partial<InputSubmission>): void {
    const existing = this.#inputsByPubkey.get(senderPubkey)
    if (!existing) return
    this.#inputsByPubkey.set(senderPubkey, {
      ...existing,
      ...partial,
    })
  }

  #recordOutputSubmission(senderPubkey: string, partial: OutputSubmission): void {
    this.#outputsByFreshKey.set(senderPubkey, partial)
  }

  #startTimeout(state: CoordinationState): void {
    this.#clearTimeout()
    const timeoutMs = timeoutForState(state)
    if (timeoutMs === undefined) return

    this.#timeoutHandle = setTimeout(() => {
      void this.#handleTimeout(state)
    }, timeoutMs)
  }

  async #handleTimeout(state: CoordinationState): Promise<void> {
    switch (state) {
      case CoordinationState.HEARTBEAT: {
        const acknowledged = this.#allIntents.filter((intent) =>
          this.#heartbeatAcks.has(intent.pubkey),
        )
        if (acknowledged.length >= Config.minParticipants) {
          await this.startRound(acknowledged)
          return
        }

        await this.#broadcastRoundFailure('heartbeat_timeout')
        this.#enterPhase(CoordinationState.FAILED)
        return
      }
      case CoordinationState.OUTPUT_COLLECTION:
        await this.#broadcastRoundFailure('output_collection_timeout')
        this.#enterPhase(CoordinationState.FAILED)
        return
      case CoordinationState.INPUT_COLLECTION:
      case CoordinationState.BLINDING:
      case CoordinationState.SIGNING:
      case CoordinationState.TX_ASSEMBLY:
      case CoordinationState.BROADCASTING:
        await this.#broadcastRoundFailure(`${state.toLowerCase()}_timeout`)
        this.#enterPhase(CoordinationState.FAILED)
        return
      default:
        return
    }
  }

  async #broadcastRoundFailure(reason: string): Promise<void> {
    this.#clearTimeout()
    for (const [pubkey] of this.#inputsByPubkey) {
      await this.#nostr.sendPrivateMessage(pubkey, {
        type: 'round_failed',
        coordination_id: this.#requireCoordinationId(),
        reason,
      })
    }

    this.#emit('round_failed', reason)
  }

  #enterPhase(phase: CoordinationState): void {
    this.#state = phase
    this.#emit('phase_change', phase)
  }

  #emit<EventName extends keyof CoordinatorEventMap>(
    event: EventName,
    ...args: CoordinatorEventMap[EventName]
  ): void {
    const handlers = this.#eventHandlers.get(event)
    if (!handlers) return

    for (const handler of handlers) {
      handler(...args)
    }
  }

  #clearTimeout(): void {
    if (this.#timeoutHandle) {
      clearTimeout(this.#timeoutHandle)
      this.#timeoutHandle = undefined
    }
  }

  #requireCoordinationId(): string {
    if (!this.#coordinationId) {
      throw new Error('coordination_id is not set')
    }

    return this.#coordinationId
  }

  #requireKeyPair(): CryptoKeyPair {
    if (!this.#rsaKeyPair) {
      throw new Error('RSA keypair is not ready')
    }

    return this.#rsaKeyPair
  }

  #requireRoundPublicKey(): JsonWebKey | string {
    if (!this.#roundPublicKey) {
      throw new Error('round public key is not ready')
    }

    return this.#roundPublicKey
  }

  #requireCurrentSigningTx() {
    if (!this.#currentSigningTx) {
      throw new Error('current signing transaction is not ready')
    }

    return this.#currentSigningTx
  }
}

function timeoutForState(state: CoordinationState): number | undefined {
  switch (state) {
    case CoordinationState.HEARTBEAT:
      return Config.timeouts.heartbeatMs
    case CoordinationState.INPUT_COLLECTION:
      return Config.timeouts.inputCollectionMs
    case CoordinationState.BLINDING:
      return Config.timeouts.blindingMs
    case CoordinationState.OUTPUT_COLLECTION:
      return Config.timeouts.outputCollectionMs
    case CoordinationState.SIGNING:
      return Config.timeouts.signatureCollectionMs
    case CoordinationState.BROADCASTING:
      return Config.timeouts.broadcastingMs
    default:
      return undefined
  }
}

function normalizeBytes(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) return value
  return new TextEncoder().encode(value)
}
