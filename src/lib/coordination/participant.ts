import type { CoinjoinParticipant, CkbService } from '../ckb'
import { Config } from '../config'
import type { NostrService, RoundCommitment } from '../nostr'
import type { PrivacyService } from '../privacy'
import {
  CoordinationState,
  type BlindSignatureMessage,
  type CoordinationMessage,
  type CoordinationProposalMessage,
  type HeartbeatMessage,
  type InputRequestMessage,
  type Intent,
  type ParticipantContext,
  type RoundCompleteMessage,
  type RoundFailedMessage,
  type TxProposalMessage,
} from './types'
import { deriveCoordinationId } from './utils'

const ROUND_COMMITMENT_RETRY_ATTEMPTS = 120
const ROUND_COMMITMENT_RETRY_DELAY_MS = 250

type NostrLike = Pick<NostrService, 'publicKey' | 'sendPrivateMessage' | 'getRoundCommitment'>
type PrivacyLike = Pick<
  PrivacyService,
  'blind' | 'finalize' | 'computeFingerprint' | 'importPublicKey'
>
type CkbLike = Pick<CkbService, 'signInputs' | 'createParticipant'>

type CoordinationParticipantOptions = {
  nostr: NostrLike
  privacy: PrivacyLike
  ckb: CkbLike
  intent: Intent
  coinjoinParticipant?: CoinjoinParticipant
  privateKey?: string
  inputIndices?: number[]
  changeAddress?: string
  outputAddress?: string
}

export class CoordinationParticipant {
  readonly #nostr: NostrLike
  readonly #privacy: PrivacyLike
  readonly #ckb: CkbLike
  readonly #intent: Intent
  readonly #coinjoinParticipant?: CoinjoinParticipant
  readonly #privateKey?: string
  readonly #inputIndices: number[]
  readonly #changeAddress: string
  readonly #outputAddress: string

  #context: ParticipantContext
  #heartbeatTimer?: ReturnType<typeof setTimeout>
  #phaseTimer?: ReturnType<typeof setTimeout>
  #pendingHeartbeat?: HeartbeatMessage
  #pendingInputRequest?: InputRequestMessage

  constructor({
    nostr,
    privacy,
    ckb,
    intent,
    coinjoinParticipant,
    privateKey,
    inputIndices,
    changeAddress,
    outputAddress,
  }: CoordinationParticipantOptions) {
    this.#nostr = nostr
    this.#privacy = privacy
    this.#ckb = ckb
    this.#intent = intent
    this.#coinjoinParticipant = coinjoinParticipant
    this.#privateKey = privateKey
    this.#inputIndices = inputIndices ?? []
    this.#changeAddress = changeAddress ?? intent.pubkey
    this.#outputAddress = outputAddress ?? intent.pubkey

    this.#context = {
      state: CoordinationState.MATCHING,
      intent,
      matchedIntents: [],
      coinjoinParticipant,
    }
  }

  get state(): CoordinationState {
    return this.#context.state
  }

  get context(): Readonly<ParticipantContext> {
    return this.#context
  }

  async handleMessage(message: CoordinationMessage): Promise<void> {
    switch (message.type) {
      case 'coordination_proposal':
        await this.#handleProposal(message)
        return
      case 'heartbeat':
        await this.#handleHeartbeat(message)
        return
      case 'input_request':
        await this.#handleInputRequest(message)
        return
      case 'blind_signature':
        await this.#handleBlindSignature(message)
        return
      case 'tx_proposal':
        await this.#handleTxProposal(message)
        return
      case 'round_complete':
        this.#handleRoundComplete(message)
        return
      case 'round_failed':
        this.#handleRoundFailed(message)
        return
      case 'heartbeat_ack':
      case 'input_submission':
      case 'output_submission':
      case 'tx_signature':
        return
    }
  }

  destroy(): void {
    this.#clearTimers()
  }

  async #handleProposal(message: CoordinationProposalMessage): Promise<void> {
    if (!message.matched_intents.includes(this.#intent.id)) {
      return
    }

    const proposalCoordinationId = deriveCoordinationId(message.matched_intents)
    if (
      this.#context.coordinationId === proposalCoordinationId &&
      this.#context.state !== CoordinationState.MATCHING
    ) {
      return
    }
    if (
      this.#context.coordinationId &&
      this.#context.coordinationId !== proposalCoordinationId &&
      this.#context.state !== CoordinationState.MATCHING
    ) {
      return
    }

    this.#context = {
      ...this.#context,
      state: CoordinationState.PROPOSING,
      coordinationId: proposalCoordinationId,
      matchedIntents: [...message.matched_intents],
      coordinatorPubkey: message.coordinator_pubkey,
      failureReason: undefined,
    }

    this.#startHeartbeatTimeout()
    await this.#flushPendingMessages(proposalCoordinationId)
  }

  async #handleHeartbeat(message: HeartbeatMessage): Promise<void> {
    if (!this.#context.coordinatorPubkey) {
      this.#pendingHeartbeat = message
      return
    }
    if (this.#context.coordinationId && this.#context.coordinationId !== message.coordination_id) {
      return
    }
    if (
      this.#context.state !== CoordinationState.PROPOSING &&
      this.#context.state !== CoordinationState.HEARTBEAT
    ) {
      return
    }

    this.#clearHeartbeatTimeout()
    this.#context = {
      ...this.#context,
      state: CoordinationState.HEARTBEAT,
      coordinationId: message.coordination_id,
      lastHeartbeatAt: Date.now(),
      failureReason: undefined,
    }

    await this.#nostr.sendPrivateMessage(this.#requireCoordinatorPubkey(), {
      type: 'heartbeat_ack',
      coordination_id: message.coordination_id,
    })
  }

  async #handleInputRequest(message: InputRequestMessage): Promise<void> {
    if (!this.#context.coordinatorPubkey || this.#context.matchedIntents.length === 0) {
      this.#pendingInputRequest = message
      return
    }
    if (this.#context.coordinationId && this.#context.coordinationId !== message.coordination_id) {
      return
    }
    if (
      this.#context.state !== CoordinationState.HEARTBEAT &&
      this.#context.state !== CoordinationState.PROPOSING
    ) {
      return
    }

    try {
      const refreshedParticipant =
        this.#privateKey !== undefined
          ? await this.#ckb.createParticipant(
              this.#privateKey,
              this.#intent.amount + Config.minCellCapacityCkb + 10_000n,
            )
          : this.#coinjoinParticipant

      const verification = await this.#verifyProposal(message)
      const token = crypto.getRandomValues(new Uint8Array(32))
      const { blindedMessage, blindInverse, preparedMessage } = await this.#privacy.blind(
        verification.publicKey,
        token,
      )

      this.#context = {
        ...this.#context,
        state: CoordinationState.INPUT_COLLECTION,
        coordinationId: message.coordination_id,
        rsaPublicKey: message.rsa_public_key,
        rsaPubkeyFingerprint: verification.commitment.rsaPubkeyFingerprint,
        blindedToken: blindedMessage,
        blindInverse,
        preparedToken: preparedMessage,
        coinjoinParticipant: refreshedParticipant,
        failureReason: undefined,
      }

      this.#startPhaseTimeout(CoordinationState.INPUT_COLLECTION)

      await this.#nostr.sendPrivateMessage(this.#requireCoordinatorPubkey(), {
        type: 'input_submission',
        coordination_id: message.coordination_id,
        inputs: refreshedParticipant?.cells ?? [],
        change_address: this.#changeAddress,
        blinded_token: blindedMessage,
      })
    } catch (error) {
      this.#abort(error instanceof Error ? error.message : String(error))
    }
  }

  async #handleBlindSignature(message: BlindSignatureMessage): Promise<void> {
    if (!this.#context.coordinationId || message.coordination_id !== this.#context.coordinationId) {
      return
    }
    if (this.#context.state !== CoordinationState.INPUT_COLLECTION) {
      return
    }

    if (
      !this.#context.preparedToken ||
      !this.#context.blindInverse ||
      !this.#context.rsaPublicKey
    ) {
      this.#abort('blind signature received before blinding context was prepared')
      return
    }

    try {
      const publicKey = await this.#parsePublicKey(this.#context.rsaPublicKey)
      const signature = await this.#privacy.finalize(
        publicKey,
        this.#context.preparedToken,
        normalizeBytes(message.signed_blinded_token),
        this.#context.blindInverse,
      )
      const outputIdentityPubkey = randomHex(32)

      this.#context = {
        ...this.#context,
        state: CoordinationState.OUTPUT_COLLECTION,
        outputIdentityPubkey,
        failureReason: undefined,
      }

      this.#startPhaseTimeout(CoordinationState.OUTPUT_COLLECTION)

      await this.#nostr.sendPrivateMessage(this.#requireCoordinatorPubkey(), {
        type: 'output_submission',
        coordination_id: this.#requireCoordinationId(),
        unblinded_token: signature,
        output_address: this.#outputAddress,
        output_identity_pubkey: outputIdentityPubkey,
      })
    } catch (error) {
      this.#abort(error instanceof Error ? error.message : String(error))
    }
  }

  async #handleTxProposal(message: TxProposalMessage): Promise<void> {
    if (!this.#context.coordinationId || message.coordination_id !== this.#context.coordinationId) {
      return
    }
    if (
      this.#context.state !== CoordinationState.OUTPUT_COLLECTION &&
      this.#context.state !== CoordinationState.SIGNING
    ) {
      return
    }

    if (!this.#privateKey) {
      this.#abort('cannot sign transaction without participant private key')
      return
    }

    const inputIndices = message.input_indices ?? this.#inputIndices
    if (inputIndices.length === 0) {
      this.#abort('tx proposal missing participant input indices')
      return
    }

    try {
      const witnesses = await this.#ckb.signInputs(
        message.unsigned_tx_hex as unknown as Parameters<CkbLike['signInputs']>[0],
        this.#privateKey,
        inputIndices,
      )

      this.#context = {
        ...this.#context,
        state: CoordinationState.SIGNING,
        failureReason: undefined,
      }

      this.#startPhaseTimeout(CoordinationState.SIGNING)

      await this.#nostr.sendPrivateMessage(this.#requireCoordinatorPubkey(), {
        type: 'tx_signature',
        coordination_id: message.coordination_id,
        input_indices: inputIndices,
        signed_witnesses: witnesses,
        witnesses: witnesses.map(({ witness }) => witness),
      })
    } catch (error) {
      this.#abort(error instanceof Error ? error.message : String(error))
    }
  }

  #handleRoundComplete(message: RoundCompleteMessage): void {
    if (this.#context.coordinationId && message.coordination_id !== this.#context.coordinationId) {
      return
    }

    this.#clearTimers()
    this.#context = {
      ...this.#context,
      state: CoordinationState.COMPLETE,
      coordinationId: message.coordination_id,
      failureReason: undefined,
    }
  }

  #handleRoundFailed(message: RoundFailedMessage): void {
    if (this.#context.coordinationId && message.coordination_id !== this.#context.coordinationId) {
      return
    }

    this.#abort(message.reason)
  }

  async #verifyProposal(message: InputRequestMessage): Promise<{
    publicKey: CryptoKey
    commitment: RoundCommitment
  }> {
    const matchedIntents = this.#context.matchedIntents
    const expectedCoordinationId = deriveCoordinationId(matchedIntents)

    if (expectedCoordinationId !== message.coordination_id) {
      throw new Error('coordination_id does not match derived value')
    }

    if (!matchedIntents.includes(this.#intent.id)) {
      throw new Error('participant intent missing from matched_intents')
    }

    const commitment = await this.#waitForRoundCommitment(message.coordination_id)
    if (!commitment) {
      throw new Error('round commitment missing')
    }

    const publicKey = await this.#parsePublicKey(message.rsa_public_key)
    const fingerprint = await this.#privacy.computeFingerprint(publicKey)
    if (fingerprint !== commitment.rsaPubkeyFingerprint) {
      throw new Error('RSA key fingerprint mismatch')
    }

    return {
      publicKey,
      commitment,
    }
  }

  async #parsePublicKey(rsaPublicKey: JsonWebKey | string): Promise<CryptoKey> {
    const jwk =
      typeof rsaPublicKey === 'string' ? (JSON.parse(rsaPublicKey) as JsonWebKey) : rsaPublicKey
    return this.#privacy.importPublicKey(jwk)
  }

  #startHeartbeatTimeout(): void {
    this.#clearHeartbeatTimeout()
    this.#heartbeatTimer = setTimeout(() => {
      this.#abort('coordinator heartbeat timeout')
    }, Config.timeouts.heartbeatMs)
  }

  #startPhaseTimeout(state: CoordinationState): void {
    this.#clearPhaseTimeout()
    const baseTimeout = phaseBaseTimeout(state)
    if (baseTimeout === undefined) return

    this.#phaseTimer = setTimeout(() => {
      this.#abort(`coordinator message overdue during ${state}`)
    }, baseTimeout * 2)
  }

  #clearTimers(): void {
    this.#clearHeartbeatTimeout()
    this.#clearPhaseTimeout()
  }

  #clearHeartbeatTimeout(): void {
    if (this.#heartbeatTimer) {
      clearTimeout(this.#heartbeatTimer)
      this.#heartbeatTimer = undefined
    }
  }

  #clearPhaseTimeout(): void {
    if (this.#phaseTimer) {
      clearTimeout(this.#phaseTimer)
      this.#phaseTimer = undefined
    }
  }

  #abort(reason: string): void {
    this.#clearTimers()
    this.#context = {
      ...this.#context,
      state: CoordinationState.FAILED,
      failureReason: reason,
    }
  }

  async #flushPendingMessages(coordinationId: string): Promise<void> {
    if (this.#pendingHeartbeat?.coordination_id === coordinationId) {
      const pendingHeartbeat = this.#pendingHeartbeat
      this.#pendingHeartbeat = undefined
      await this.#handleHeartbeat(pendingHeartbeat)
    }

    if (this.#pendingInputRequest?.coordination_id === coordinationId) {
      const pendingInputRequest = this.#pendingInputRequest
      this.#pendingInputRequest = undefined
      await this.#handleInputRequest(pendingInputRequest)
    }
  }

  async #waitForRoundCommitment(coordinationId: string): Promise<RoundCommitment | undefined> {
    for (let attempt = 0; attempt < ROUND_COMMITMENT_RETRY_ATTEMPTS; attempt += 1) {
      const commitment = await this.#nostr.getRoundCommitment(coordinationId)
      if (commitment) {
        return commitment
      }

      if (attempt < ROUND_COMMITMENT_RETRY_ATTEMPTS - 1) {
        await delay(ROUND_COMMITMENT_RETRY_DELAY_MS)
      }
    }

    return undefined
  }

  #requireCoordinatorPubkey(): string {
    if (!this.#context.coordinatorPubkey) {
      throw new Error('coordinator pubkey is not set')
    }

    return this.#context.coordinatorPubkey
  }

  #requireCoordinationId(): string {
    if (!this.#context.coordinationId) {
      throw new Error('coordination_id is not set')
    }

    return this.#context.coordinationId
  }
}

function phaseBaseTimeout(state: CoordinationState): number | undefined {
  switch (state) {
    case CoordinationState.INPUT_COLLECTION:
      return Config.timeouts.blindingMs
    case CoordinationState.OUTPUT_COLLECTION:
      return Config.timeouts.outputCollectionMs
    case CoordinationState.SIGNING:
      return Config.timeouts.signatureCollectionMs
    default:
      return undefined
  }
}

function normalizeBytes(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value
  }

  return new TextEncoder().encode(value)
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
