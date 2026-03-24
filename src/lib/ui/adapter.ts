import { ccc } from '@ckb-ccc/core'

import { CkbService, type CoinjoinParticipant, type ConfirmedTransactionSummary } from '../ckb'
import { CoordinationCoordinator } from '../coordination/coordinator'
import { CoordinationParticipant } from '../coordination/participant'
import { CoordinationState, type CoordinationMessage, type Intent } from '../coordination/types'
import { compareProposals, deriveCoordinationId } from '../coordination/utils'
import { NostrService, type Intent as NostrIntent } from '../nostr'
import {
  type AutopilotStatus,
  type PolicyInterpretation,
  PolicyService,
  type PrivacyPolicy,
} from '../policy'
import { PrivacyService } from '../privacy'
import { createCkbClient, type UiCkbClient } from './ckb-client'
import type {
  ActiveUiConfig,
  BalanceSnapshot,
  ConnectionSnapshot,
  PreparedSession,
  PublishIntentDraft,
  RoundStatus,
  UiAdapterEvent,
  UiIntentRecord,
} from './types'

const RECENT_WINDOW_SECONDS = 10 * 60
const MATCH_COHORT_WINDOW_SECONDS = 60
const BALANCE_CELL_LIMIT = 100
const INTENT_POLL_INTERVAL_MS = 3_000
const AUTOPILOT_RETRY_MS = 5_000
const DEFAULT_CELL_FILTER = {
  scriptLenRange: [0, 1] as [number, number],
  outputDataLenRange: [0, 1] as [number, number],
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export class UiWorkflowAdapter {
  #nostr?: NostrService
  #ckb?: UiCkbClient
  #ckbService?: CkbService
  #privacy = new PrivacyService()
  #policy = new PolicyService()
  #listeners = new Set<(event: UiAdapterEvent) => void>()
  #lastConfig?: ActiveUiConfig
  #privateMessageUnsubscribe?: () => void
  #intentPollHandle?: ReturnType<typeof setInterval>
  #privateKey?: string
  #receiverAddress = ''
  #ckbAddress?: string
  #activeIntent?: Intent
  #participant?: CoordinationParticipant
  #coordinator?: CoordinationCoordinator
  #participantSpec?: CoinjoinParticipant
  #participantPhase: RoundStatus['participantPhase'] = 'IDLE'
  #coordinatorPhase: RoundStatus['coordinatorPhase'] = 'IDLE'
  #coordinationId?: string
  #startingCoordination = false
  #roundSetupInFlight = false
  #autopilotPolicy?: PrivacyPolicy
  #autopilotStatus: AutopilotStatus = buildIdleAutopilotStatus()
  #autopilotRetryHandle?: ReturnType<typeof setTimeout>
  #autopilotSyncInFlight = false
  #participantSetupPromise?: Promise<void>
  #pendingParticipantMessages: Array<{
    senderPubkey: string
    message: CoordinationMessage
  }> = []

  subscribe(listener: (event: UiAdapterEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async connect(config: ActiveUiConfig): Promise<ConnectionSnapshot> {
    this.#emit({
      type: 'connection',
      snapshot: { status: 'connecting' },
      message: `Connecting to ${config.network} infrastructure`,
    })

    try {
      await this.disconnect()

      const nostr = new NostrService()
      await nostr.connect(config.nostrRelayUrl)

      const ckb = await createCkbClient(config)
      const ckbService = new CkbService(ckb)
      const tip = await ckb.getTip()

      this.#nostr = nostr
      this.#ckb = ckb
      this.#ckbService = ckbService
      this.#lastConfig = config
      this.#privateMessageUnsubscribe = nostr.onPrivateMessage((message, senderPubkey) => {
        void this.#handlePrivateMessage(senderPubkey ?? '', message as CoordinationMessage)
      })
      this.#intentPollHandle = setInterval(() => {
        void this.refreshRecentIntents()
      }, INTENT_POLL_INTERVAL_MS)

      const snapshot = {
        status: 'connected',
        nostrPublicKey: nostr.publicKey,
        ckbTip: stringifyTip(tip),
        connectedAt: Date.now(),
      } satisfies ConnectionSnapshot

      this.#emit({
        type: 'connection',
        snapshot,
        message: `Connected to ${config.network} relay and CKB RPC`,
      })

      await this.refreshRecentIntents()

      return snapshot
    } catch (error) {
      const snapshot = {
        status: 'failed',
        lastError: normalizeError(error),
      } satisfies ConnectionSnapshot

      this.#emit({
        type: 'connection',
        snapshot,
        message: snapshot.lastError,
      })
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.#clearAutopilotRetry()
    this.#privateMessageUnsubscribe?.()
    this.#privateMessageUnsubscribe = undefined

    if (this.#intentPollHandle) {
      clearInterval(this.#intentPollHandle)
      this.#intentPollHandle = undefined
    }

    await this.#nostr?.disconnect()
    this.#nostr = undefined
    this.#ckb = undefined
    this.#ckbService = undefined
    this.#activeIntent = undefined
    this.#participant = undefined
    this.#coordinator = undefined
    this.#participantSpec = undefined
    this.#participantPhase = 'IDLE'
    this.#coordinatorPhase = 'IDLE'
    this.#coordinationId = undefined
    this.#pendingParticipantMessages = []
    this.#autopilotPolicy = undefined
    if (this.#autopilotStatus.armed || this.#autopilotStatus.phase !== 'idle') {
      this.#emitAutopilot(
        buildIdleAutopilotStatus(),
        'Autopilot reset because the session disconnected.',
      )
    }

    this.#emit({
      type: 'connection',
      snapshot: { status: 'idle' },
      message: 'Disconnected from local services',
    })
  }

  async prepareSession({
    privateKey,
    receiverAddress,
  }: {
    privateKey: string
    receiverAddress: string
  }): Promise<PreparedSession> {
    const ckb = this.#requireCkb()
    const signer = new ccc.SignerCkbPrivateKey(ckb, privateKey)
    const address = (await signer.getRecommendedAddressObj()).toString()
    this.#privateKey = privateKey
    this.#receiverAddress = receiverAddress
    this.#ckbAddress = address

    if (receiverAddress) {
      await ccc.Address.fromString(receiverAddress, ckb)
    }

    const balance = await this.#readBalanceForAddress(address)
    this.#emit({
      type: 'session',
      ckbAddress: address,
      balance,
      message: 'Prepared session key and refreshed balance',
    })
    await this.#syncAutopilot('session_ready')

    return {
      ckbAddress: address,
      balance,
    }
  }

  async interpretPolicy(rawPrompt: string): Promise<PolicyInterpretation> {
    this.#emit({
      type: 'policy',
      status: 'interpreting',
      message: 'Interpreting privacy goal with the policy agent',
    })

    try {
      const interpretation = await this.#policy.interpret(rawPrompt)
      this.#emit({
        type: 'policy',
        status: 'ready',
        interpretation,
        message: interpretation.supported
          ? 'Policy agent produced a deterministic CoinJoin policy'
          : 'Policy agent flagged the request as unsupported for this demo',
        level: interpretation.supported ? 'success' : 'warning',
      })
      return interpretation
    } catch (error) {
      const message = normalizeError(error)
      this.#emit({
        type: 'policy',
        status: 'error',
        message,
        level: 'error',
      })
      throw error
    }
  }

  async armAutopilot({
    policy,
    receiverAddress,
  }: {
    policy: PrivacyPolicy
    receiverAddress: string
  }): Promise<void> {
    if (!receiverAddress.trim()) {
      throw new Error('Receiver address is required')
    }

    if (this.#ckb) {
      await ccc.Address.fromString(receiverAddress.trim(), this.#ckb)
    }

    this.#autopilotPolicy = policy
    this.#receiverAddress = receiverAddress.trim()
    this.#clearAutopilotRetry()
    this.#emitAutopilot(
      {
        armed: true,
        phase: 'armed_waiting_session',
        lastAction: 'Autopilot armed. Waiting for session readiness before publishing.',
      },
      'Autopilot armed',
      'success',
    )
    await this.#syncAutopilot('armed')
  }

  async disarmAutopilot(reason = 'Autopilot disarmed by user.'): Promise<void> {
    this.#clearAutopilotRetry()
    this.#autopilotPolicy = undefined

    if (this.#activeIntent && this.#nostr) {
      await this.#nostr.deleteEvent(this.#activeIntent.id).catch(() => undefined)
      this.#activeIntent = undefined
    }

    this.#emitAutopilot(
      {
        armed: false,
        phase: 'idle',
        lastAction: reason,
      },
      reason,
      'info',
    )

    if (this.#nostr) {
      await this.refreshRecentIntents().catch(() => undefined)
    }
  }

  async publishIntent(draft: PublishIntentDraft): Promise<void> {
    await this.#publishIntent(draft, 'manual')
  }

  async #publishIntent(draft: PublishIntentDraft, source: 'manual' | 'autopilot'): Promise<void> {
    const nostr = this.#requireNostr()
    const ckb = this.#requireCkb()
    if (!this.#privateKey) {
      throw new Error('Enter a CKB private key before publishing an intent')
    }
    if (!draft.receiverAddress) {
      throw new Error('Receiver address is required')
    }
    await ccc.Address.fromString(draft.receiverAddress, ckb)
    this.#receiverAddress = draft.receiverAddress

    if (this.#activeIntent) {
      await nostr.deleteEvent(this.#activeIntent.id)
      this.#activeIntent = undefined
    }

    const intentId = await nostr.publishIntent({
      amount: draft.amount,
      minParticipants: draft.minParticipants,
      minReputation: draft.minReputation,
    })

    this.#activeIntent = {
      id: intentId,
      pubkey: nostr.publicKey,
      amount: draft.amount,
      minParticipants: draft.minParticipants,
      minReputation: draft.minReputation,
      createdAt: Math.floor(Date.now() / 1000),
    }

    this.#participant = undefined
    this.#coordinator = undefined
    this.#participantSpec = undefined
    this.#participantPhase = CoordinationState.MATCHING
    this.#coordinatorPhase = 'IDLE'
    this.#pendingParticipantMessages = []
    this.#coordinationId = undefined

    if (source === 'autopilot') {
      this.#emitAutopilot(
        {
          ...this.#autopilotStatus,
          armed: true,
          phase: 'waiting_for_peers',
          lastAction: `Published ${formatIntentSummary(this.#activeIntent)} and started watching for peers.`,
          retryAt: undefined,
        },
        'Autopilot published a CoinJoin intent and is watching for peers',
        'success',
      )
    }

    await this.refreshRecentIntents()
  }

  async refreshRecentIntents(): Promise<UiIntentRecord[]> {
    const nostr = this.#requireNostr()
    const config = this.#requireConfig()
    const intents = (await nostr.listIntents()).filter((intent) => isRecent(intent.createdAt))
    const mapped = intents
      .sort(compareRecentIntentsDesc)
      .map((intent) => mapIntent(intent, nostr.publicKey, config))

    this.#emit({
      type: 'intents',
      intents: mapped,
      activeIntentId: this.#activeIntent?.id,
      message: `Loaded ${mapped.length} recent intents`,
    })

    try {
      await this.#maybeRunRound(intents)
    } catch (error) {
      this.#emit({
        type: 'notice',
        level: 'error',
        title: 'Round Debug',
        detail: `Round candidate evaluation failed: ${normalizeError(error)}`,
      })
    }

    await this.#syncAutopilot('refresh')
    return mapped
  }

  async deleteActiveIntent(): Promise<void> {
    const nostr = this.#requireNostr()
    if (!this.#activeIntent) return

    await nostr.deleteEvent(this.#activeIntent.id)
    this.#activeIntent = undefined
    this.#emit({
      type: 'notice',
      level: 'info',
      title: 'Intent Deleted',
      detail: 'Removed the current tab intent from the relay.',
    })
    await this.refreshRecentIntents()
  }

  #requireNostr(): NostrService {
    if (!this.#nostr) {
      throw new Error('Connect to a Nostr relay before publishing or listing intents')
    }

    return this.#nostr
  }

  #requireCkb(): UiCkbClient {
    if (!this.#ckb) {
      throw new Error('Connect to a CKB RPC before preparing a session')
    }

    return this.#ckb
  }

  #requireConfig(): ActiveUiConfig {
    if (!this.#lastConfig) {
      throw new Error('No active UI config available')
    }

    return this.#lastConfig
  }

  async #handlePrivateMessage(senderPubkey: string, message: CoordinationMessage): Promise<void> {
    this.#emit({
      type: 'notice',
      level: 'info',
      title: 'Round Debug',
      detail: `received_private_message type=${message.type} from=${shortKey(senderPubkey) ?? 'unknown'}`,
    })

    if (this.#participant) {
      await this.#dispatchToParticipant(message)
    } else if (shouldQueueForParticipant(message) && this.#activeIntent) {
      await this.#ensureParticipantReady('message').catch(() => undefined)
      if (this.#participant) {
        await this.#dispatchToParticipant(message)
      } else {
        this.#pendingParticipantMessages.push({ senderPubkey, message })
        if (this.#pendingParticipantMessages.length > 12) {
          this.#pendingParticipantMessages.shift()
        }
        this.#emit({
          type: 'notice',
          level: 'warning',
          title: 'Round Debug',
          detail: `queued message type=${message.type} until participant is ready`,
        })
      }
    }

    if (this.#coordinator) {
      await this.#coordinator.handleMessage(senderPubkey, message)
    }

    if (
      message.type === 'round_complete' &&
      (!this.#coordinationId || message.coordination_id === this.#coordinationId)
    ) {
      await this.#finalizeSuccessfulRound(message.tx_hash)
      return
    }

    if (
      message.type === 'round_failed' &&
      (!this.#coordinationId || message.coordination_id === this.#coordinationId)
    ) {
      await this.#finalizeFailedRound(message.reason)
    }
  }

  async #maybeRunRound(intents: NostrIntent[]): Promise<void> {
    if (
      !this.#activeIntent ||
      !this.#privateKey ||
      !this.#ckbAddress ||
      this.#startingCoordination ||
      this.#roundSetupInFlight
    ) {
      return
    }
    if (
      this.#participantPhase !== 'IDLE' &&
      this.#participantPhase !== CoordinationState.MATCHING
    ) {
      return
    }

    const compatible = intents
      .filter(
        (intent) =>
          intent.amount === this.#activeIntent!.amount &&
          intent.minParticipants === this.#activeIntent!.minParticipants &&
          intent.minReputation === this.#activeIntent!.minReputation &&
          isWithinMatchCohort(intent.createdAt, this.#activeIntent!.createdAt),
      )
      .sort(compareRecentIntentsDesc)

    const uniqueCompatible = collapseToLatestPerPubkey(compatible)

    const targetSize = this.#activeIntent.minParticipants
    this.#emit({
      type: 'notice',
      level: 'info',
      title: 'Round Debug',
      detail: [
        `candidate_scan compatible=${uniqueCompatible.length}/${intents.length}`,
        `target=${targetSize}`,
        `active=${shortId(this.#activeIntent.id)}`,
        `selected=${
          uniqueCompatible
            .slice(0, targetSize)
            .map((intent) => shortId(intent.id))
            .join(',') || 'none'
        }`,
      ].join(' '),
    })

    if (uniqueCompatible.length < targetSize) {
      if (this.#autopilotStatus.armed) {
        this.#emitAutopilot(
          {
            ...this.#autopilotStatus,
            armed: true,
            phase: 'waiting_for_peers',
            lastAction: `Watching relay for ${targetSize - uniqueCompatible.length} more compatible peers.`,
            retryAt: undefined,
          },
          `Autopilot is waiting for ${targetSize - uniqueCompatible.length} more compatible peers`,
        )
      }
      this.#emitRound(
        `Waiting for ${targetSize - uniqueCompatible.length} more compatible intents`,
        {
          role: 'participant',
          participantPhase: CoordinationState.MATCHING,
          coordinatorPhase: 'IDLE',
          failureReason: undefined,
        },
      )
      return
    }

    this.#roundSetupInFlight = true
    try {
      await this.#ensureParticipantReady('poll')

      const selected = uniqueCompatible.slice(0, targetSize)
      if (!selected.some((intent) => intent.id === this.#activeIntent?.id)) {
        this.#emit({
          type: 'notice',
          level: 'warning',
          title: 'Round Debug',
          detail: `active intent ${shortId(this.#activeIntent.id)} not selected in current round window`,
        })
        return
      }

      const coordinationId = deriveCoordinationId(selected.map((intent) => intent.id))
      this.#coordinationId = coordinationId
      const elected = selected[0]
      const electedSelf = elected?.pubkey === this.#requireNostr().publicKey
      this.#emit({
        type: 'notice',
        level: electedSelf ? 'success' : 'info',
        title: 'Round Debug',
        detail: [
          `election coordination=${shortId(coordinationId)}`,
          `elected=${shortKey(elected?.pubkey) ?? 'none'}`,
          `current=${shortKey(this.#requireNostr().publicKey)}`,
          `am_elected=${electedSelf ? 'yes' : 'no'}`,
        ].join(' '),
      })
      this.#emitRound(
        electedSelf
          ? 'This tab is the elected coordinator'
          : 'Compatible round found; waiting for coordinator messages',
        {
          role: electedSelf ? 'coordinator' : 'participant',
          coordinationId,
          participantPhase: this.#participantPhase,
        },
      )

      if (!electedSelf || this.#coordinator) {
        return
      }

      this.#startingCoordination = true
      try {
        this.#emit({
          type: 'notice',
          level: 'info',
          title: 'Round Debug',
          detail: `checking existing round commitment for ${shortId(coordinationId)}`,
        })
        const existingCommitment = await this.#requireNostr().getRoundCommitment(coordinationId)
        if (existingCommitment) {
          this.#emit({
            type: 'notice',
            level: 'warning',
            title: 'Round Debug',
            detail: `existing round commitment found id=${shortId(existingCommitment.id)} coordinator=${shortKey(existingCommitment.pubkey)}`,
          })
          return
        }

        const participantMap = new Map<string, CoinjoinParticipant>()
        participantMap.set(this.#activeIntent.pubkey, this.#participantSpec!)
        this.#emit({
          type: 'notice',
          level: 'info',
          title: 'Round Debug',
          detail: `constructing coordinator participantCount=${participantMap.size} selected=${selected.length}`,
        })
        this.#coordinator = new CoordinationCoordinator({
          nostr: this.#requireNostr(),
          privacy: this.#privacy,
          ckb: this.#requireCkbService(),
          intents: selected.map(toCoordinationIntent),
          participants: participantMap,
        })
        this.#coordinator.on('phase_change', (phase) => {
          this.#coordinatorPhase = phase
          if (this.#autopilotStatus.armed && phase !== CoordinationState.COMPLETE) {
            this.#emitAutopilot(
              {
                ...this.#autopilotStatus,
                armed: true,
                phase: 'round_active',
                lastAction: `Coordinator phase is now ${phase}.`,
                retryAt: undefined,
              },
              `Autopilot coordinator phase -> ${phase}`,
            )
          }
          this.#emitRound(`Coordinator phase -> ${phase}`, {
            role: 'coordinator',
            coordinatorPhase: phase,
            coordinationId,
          })
        })
        this.#coordinator.on('round_failed', (reason) => {
          void this.#finalizeFailedRound(reason, true)
        })

        this.#emit({
          type: 'notice',
          level: 'info',
          title: 'Round Debug',
          detail: `calling coordinator.startRound intents=${selected.map((intent) => shortId(intent.id)).join(',')}`,
        })
        await this.#coordinator.startRound(selected.map(toCoordinationIntent))
        this.#emit({
          type: 'notice',
          level: 'success',
          title: 'Round Debug',
          detail: `coordinator.startRound returned coordination=${shortId(coordinationId)}`,
        })
      } finally {
        this.#startingCoordination = false
      }
    } catch (error) {
      this.#emit({
        type: 'notice',
        level: 'error',
        title: 'Round Debug',
        detail: `coordinator start failed: ${normalizeError(error)}`,
      })
      throw error
    } finally {
      this.#roundSetupInFlight = false
    }
  }

  async #ensureParticipantReady(trigger: 'poll' | 'message'): Promise<void> {
    if (this.#participant) {
      return
    }
    if (!this.#activeIntent || !this.#privateKey || !this.#ckbAddress) {
      return
    }
    if (this.#participantSetupPromise) {
      await this.#participantSetupPromise
      return
    }

    this.#participantSetupPromise = (async () => {
      this.#emit({
        type: 'notice',
        level: 'info',
        title: 'Round Debug',
        detail:
          trigger === 'message'
            ? `preparing participant from incoming message for ${shortId(this.#activeIntent?.id)}`
            : `building participant spec for ${shortId(this.#activeIntent?.id)}`,
      })
      this.#participantSpec = await this.#createParticipantSpec(
        this.#privateKey!,
        this.#activeIntent!.amount + 6_100_000_000n + 10_000n,
      )
      this.#participant = new CoordinationParticipant({
        nostr: this.#requireNostr(),
        privacy: this.#privacy,
        ckb: this.#requireCkbService(),
        intent: toCoordinationIntent(this.#activeIntent!),
        coinjoinParticipant: this.#participantSpec,
        privateKey: this.#privateKey!,
        changeAddress: this.#ckbAddress!,
        outputAddress: this.#receiverAddress,
      })
      this.#participantPhase = CoordinationState.MATCHING
      this.#emit({
        type: 'notice',
        level: 'success',
        title: 'Round Debug',
        detail: `participant spec ready cells=${this.#participantSpec.cells.length} inputCapacity=${this.#participantSpec.inputCapacity.toString()}`,
      })
      await this.#drainPendingParticipantMessages()
    })()

    try {
      await this.#participantSetupPromise
    } finally {
      this.#participantSetupPromise = undefined
    }
  }

  async #finalizeSuccessfulRound(txHash: string): Promise<void> {
    const summary = await this.#requireCkbService().getTransaction(txHash)
    const highlighted = summary
      ? highlightSummary(summary, this.#ckbAddress, this.#receiverAddress)
      : undefined
    const participant = this.#participant
    const coordinator = this.#coordinator

    if (this.#activeIntent) {
      await this.#requireNostr()
        .deleteEvent(this.#activeIntent.id)
        .catch(() => undefined)
    }

    this.#emitRound(
      `Round completed: ${txHash}`,
      {
        role: this.#coordinator ? 'coordinator' : 'participant',
        participantPhase: CoordinationState.COMPLETE,
        coordinatorPhase: this.#coordinator ? CoordinationState.COMPLETE : this.#coordinatorPhase,
        txHash,
        completedTxSummary: highlighted,
        failureReason: undefined,
      },
      'success',
    )

    this.#activeIntent = undefined
    participant?.destroy()
    coordinator?.destroy()
    await this.#rotateIdentity()
    this.#participant = undefined
    this.#coordinator = undefined
    this.#participantSpec = undefined
    this.#participantPhase = 'IDLE'
    this.#coordinatorPhase = 'IDLE'
    this.#coordinationId = undefined
    this.#pendingParticipantMessages = []
    if (this.#autopilotStatus.armed) {
      this.#clearAutopilotRetry()
      this.#autopilotPolicy = undefined
      this.#emitAutopilot(
        {
          armed: false,
          phase: 'completed',
          lastAction: `Autopilot completed one CoinJoin round: ${txHash}`,
        },
        'Autopilot completed one CoinJoin round and auto-disarmed',
        'success',
      )
    }
    await this.refreshRecentIntents().catch(() => undefined)
  }

  async #finalizeFailedRound(reason: string, coordinatorFailed = false): Promise<void> {
    if (!this.#activeIntent && !this.#participant && !this.#coordinator) {
      return
    }
    const participant = this.#participant
    const coordinator = this.#coordinator

    if (this.#activeIntent) {
      await this.#requireNostr()
        .deleteEvent(this.#activeIntent.id)
        .catch(() => undefined)
    }

    this.#emitRound(
      `Round failed: ${reason}`,
      {
        role: coordinatorFailed ? 'coordinator' : this.#coordinator ? 'coordinator' : 'participant',
        participantPhase: CoordinationState.FAILED,
        coordinatorPhase: coordinatorFailed
          ? CoordinationState.FAILED
          : this.#coordinator
            ? this.#coordinatorPhase
            : 'IDLE',
        failureReason: reason,
      },
      'error',
    )

    this.#activeIntent = undefined
    participant?.destroy()
    coordinator?.destroy()
    this.#participant = undefined
    this.#coordinator = undefined
    this.#participantSpec = undefined
    this.#participantPhase = 'IDLE'
    this.#coordinatorPhase = 'IDLE'
    this.#coordinationId = undefined
    this.#pendingParticipantMessages = []
    if (this.#autopilotStatus.armed) {
      this.#scheduleAutopilotRetry(reason)
    }
    await this.refreshRecentIntents().catch(() => undefined)
  }

  async #rotateIdentity(): Promise<void> {
    const config = this.#requireConfig()
    await this.#requireNostr().disconnect()
    this.#privateMessageUnsubscribe?.()
    this.#privateMessageUnsubscribe = undefined

    const nostr = new NostrService()
    await nostr.connect(config.nostrRelayUrl)
    this.#nostr = nostr
    this.#privateMessageUnsubscribe = nostr.onPrivateMessage((message, senderPubkey) => {
      void this.#handlePrivateMessage(senderPubkey ?? '', message as CoordinationMessage)
    })

    this.#emit({
      type: 'connection',
      snapshot: {
        status: 'connected',
        nostrPublicKey: nostr.publicKey,
      },
      message: 'Rotated Nostr identity after round completion',
    })
  }

  async #readBalanceForAddress(address: string): Promise<BalanceSnapshot> {
    const ckb = this.#requireCkb()
    const parsed = await ccc.Address.fromString(address, ckb)
    let total = 0n
    let scanned = 0

    for await (const cell of ckb.findCells(
      {
        script: parsed.script,
        scriptType: 'lock',
        scriptSearchMode: 'exact',
        filter: DEFAULT_CELL_FILTER,
        withData: false,
      },
      'asc',
    )) {
      total += BigInt(cell.cellOutput.capacity)
      scanned += 1
      if (scanned >= BALANCE_CELL_LIMIT) {
        return {
          display: `> ${formatShannons(total)}`,
          isLowerBound: true,
          scannedCells: scanned,
        }
      }
    }

    return {
      display: formatShannons(total),
      isLowerBound: false,
      scannedCells: scanned,
    }
  }

  async #createParticipantSpec(
    privateKey: string,
    targetCapacity: bigint,
  ): Promise<CoinjoinParticipant> {
    return await this.#requireCkbService().createParticipant(privateKey, targetCapacity)
  }

  #requireCkbService(): CkbService {
    if (!this.#ckbService) {
      throw new Error('CKB service not initialized')
    }

    return this.#ckbService
  }

  #emitRound(
    message: string,
    round: Partial<RoundStatus> = {},
    level: 'info' | 'success' | 'warning' | 'error' = 'info',
  ): void {
    this.#emit({
      type: 'round',
      round: {
        coordinationId: this.#coordinationId,
        role: this.#coordinator ? 'coordinator' : this.#participant ? 'participant' : 'idle',
        participantPhase: this.#participantPhase,
        coordinatorPhase: this.#coordinatorPhase,
        ...round,
      },
      message,
      level,
    })
  }

  #emit(event: UiAdapterEvent): void {
    for (const listener of this.#listeners) {
      listener(event)
    }
  }

  async #dispatchToParticipant(message: CoordinationMessage): Promise<void> {
    if (!this.#participant) return

    const previousParticipantPhase = this.#participant.state
    await this.#participant.handleMessage(message)
    if (this.#participant.state !== previousParticipantPhase) {
      this.#participantPhase = this.#participant.state
      if (
        this.#autopilotStatus.armed &&
        this.#participant.state !== CoordinationState.MATCHING &&
        this.#participant.state !== CoordinationState.FAILED &&
        this.#participant.state !== CoordinationState.COMPLETE
      ) {
        this.#emitAutopilot(
          {
            ...this.#autopilotStatus,
            armed: true,
            phase: 'round_active',
            lastAction: `Participant phase is now ${this.#participant.state}.`,
            retryAt: undefined,
          },
          `Autopilot participant phase -> ${this.#participant.state}`,
        )
      }
      this.#emitRound(`Participant phase -> ${this.#participant.state}`)
      if (this.#participant.state === CoordinationState.FAILED) {
        this.#emit({
          type: 'notice',
          level: 'error',
          title: 'Round Debug',
          detail: `participant failure reason=${this.#participant.context.failureReason ?? 'unknown'}`,
        })
      }
    }
  }

  async #drainPendingParticipantMessages(): Promise<void> {
    if (!this.#participant || this.#pendingParticipantMessages.length === 0) {
      return
    }

    const pending = [...this.#pendingParticipantMessages]
    this.#pendingParticipantMessages = []
    this.#emit({
      type: 'notice',
      level: 'info',
      title: 'Round Debug',
      detail: `replaying ${pending.length} queued participant messages`,
    })

    for (const entry of pending) {
      await this.#dispatchToParticipant(entry.message)
    }
  }

  async #syncAutopilot(trigger: string): Promise<void> {
    if (!this.#autopilotStatus.armed || this.#autopilotSyncInFlight) {
      return
    }

    this.#autopilotSyncInFlight = true
    try {
      if (!this.#autopilotPolicy) {
        return
      }

      if (this.#autopilotRetryHandle) {
        return
      }

      if (!this.#nostr || !this.#ckb || !this.#privateKey || !this.#ckbAddress) {
        this.#emitAutopilot(
          {
            ...this.#autopilotStatus,
            armed: true,
            phase: 'armed_waiting_session',
            lastAction: 'Autopilot is waiting for the relay, RPC, and wallet session to be ready.',
            retryAt: undefined,
          },
          'Autopilot is waiting for a ready session',
        )
        return
      }

      if (!this.#receiverAddress) {
        this.#emitAutopilot(
          {
            ...this.#autopilotStatus,
            armed: true,
            phase: 'awaiting_receiver',
            lastAction: 'Enter a receiver address before autopilot can publish.',
            retryAt: undefined,
          },
          'Autopilot is waiting for a receiver address',
          'warning',
        )
        return
      }

      if (this.#participant || this.#coordinator || this.#coordinationId) {
        this.#emitAutopilot(
          {
            ...this.#autopilotStatus,
            armed: true,
            phase: 'round_active',
            lastAction: `Autopilot is tracking an active round (${trigger}).`,
            retryAt: undefined,
          },
          'Autopilot is tracking an active round',
        )
        return
      }

      if (!intentMatchesPolicy(this.#activeIntent, this.#autopilotPolicy)) {
        this.#emitAutopilot(
          {
            ...this.#autopilotStatus,
            armed: true,
            phase: 'publishing',
            lastAction: 'Publishing a CoinJoin intent from the parsed policy.',
            retryAt: undefined,
          },
          'Autopilot is publishing a CoinJoin intent',
        )
        await this.#publishIntent(
          {
            amount: BigInt(this.#autopilotPolicy.mixAmountShannons),
            minParticipants: this.#autopilotPolicy.minParticipants,
            minReputation: 0,
            receiverAddress: this.#receiverAddress,
          },
          'autopilot',
        )
        return
      }

      this.#emitAutopilot(
        {
          ...this.#autopilotStatus,
          armed: true,
          phase: 'waiting_for_peers',
          lastAction: `Autopilot is watching for a ${this.#autopilotPolicy.minParticipants}-peer CoinJoin cohort.`,
          retryAt: undefined,
        },
        'Autopilot is watching the relay for compatible peers',
      )
    } finally {
      this.#autopilotSyncInFlight = false
    }
  }

  #scheduleAutopilotRetry(reason: string): void {
    if (!this.#autopilotStatus.armed || !this.#autopilotPolicy) {
      return
    }

    this.#clearAutopilotRetry()
    const retryAt = Date.now() + AUTOPILOT_RETRY_MS
    this.#emitAutopilot(
      {
        ...this.#autopilotStatus,
        armed: true,
        phase: 'retry_scheduled',
        lastAction: `Round failed (${reason}). Autopilot will retry shortly.`,
        retryAt,
      },
      'Autopilot scheduled a retry after the failed round',
      'warning',
    )

    this.#autopilotRetryHandle = setTimeout(() => {
      this.#autopilotRetryHandle = undefined
      void this.#syncAutopilot('retry')
    }, AUTOPILOT_RETRY_MS)
  }

  #clearAutopilotRetry(): void {
    if (this.#autopilotRetryHandle) {
      clearTimeout(this.#autopilotRetryHandle)
      this.#autopilotRetryHandle = undefined
    }
  }

  #emitAutopilot(
    status: AutopilotStatus,
    message: string,
    level: 'info' | 'success' | 'warning' | 'error' = 'info',
  ): void {
    this.#autopilotStatus = status
    this.#emit({
      type: 'autopilot',
      status,
      message,
      level,
    })
  }
}

function compareRecentIntents(a: NostrIntent, b: NostrIntent): number {
  return compareProposals(
    { id: a.id, created_at: a.createdAt },
    { id: b.id, created_at: b.createdAt },
  )
}

function buildIdleAutopilotStatus(): AutopilotStatus {
  return {
    armed: false,
    phase: 'idle',
    lastAction: 'Autopilot is idle.',
  }
}

function shouldQueueForParticipant(message: CoordinationMessage): boolean {
  switch (message.type) {
    case 'coordination_proposal':
    case 'heartbeat':
    case 'input_request':
    case 'blind_signature':
    case 'tx_proposal':
    case 'round_complete':
    case 'round_failed':
      return true
    default:
      return false
  }
}

function compareRecentIntentsDesc(a: NostrIntent, b: NostrIntent): number {
  return compareRecentIntents(b, a)
}

function collapseToLatestPerPubkey(intents: NostrIntent[]): NostrIntent[] {
  const latestByPubkey = new Map<string, NostrIntent>()
  for (const intent of intents) {
    if (!latestByPubkey.has(intent.pubkey)) {
      latestByPubkey.set(intent.pubkey, intent)
    }
  }

  return [...latestByPubkey.values()]
}

function stringifyTip(tip: ccc.Num): string {
  return BigInt(tip.toString()).toString()
}

function isRecent(createdAt: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return createdAt >= now - RECENT_WINDOW_SECONDS
}

function isWithinMatchCohort(intentCreatedAt: number, activeIntentCreatedAt: number): boolean {
  return Math.abs(intentCreatedAt - activeIntentCreatedAt) <= MATCH_COHORT_WINDOW_SECONDS
}

function mapIntent(
  intent: NostrIntent,
  currentPubkey: string,
  config: ActiveUiConfig,
): UiIntentRecord {
  return {
    id: intent.id,
    pubkey: intent.pubkey,
    amountShannons: intent.amount.toString(),
    minParticipants: intent.minParticipants,
    minReputation: intent.minReputation,
    createdAt: intent.createdAt,
    createdAtLabel: new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(intent.createdAt * 1000),
    isMine: intent.pubkey === currentPubkey,
    isCompatible:
      intent.amount.toString() === config.mixAmountShannons &&
      intent.minParticipants === config.minParticipants,
  }
}

function toCoordinationIntent(intent: Intent | NostrIntent): Intent {
  return {
    id: intent.id,
    pubkey: intent.pubkey,
    amount: intent.amount,
    minParticipants: intent.minParticipants,
    minReputation: intent.minReputation ?? 0,
    createdAt: intent.createdAt,
  }
}

function formatShannons(value: bigint): string {
  return `${value.toString()} shannons`
}

function shortId(value?: string): string {
  if (!value) return 'n/a'
  if (value.length <= 12) return value
  return `${value.slice(0, 8)}…${value.slice(-4)}`
}

function shortKey(value?: string): string | undefined {
  if (!value) return undefined
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}…${value.slice(-6)}`
}

function highlightSummary(
  summary: ConfirmedTransactionSummary,
  ckbAddress?: string,
  receiverAddress?: string,
) {
  return {
    txHash: summary.txHash,
    inputs: summary.inputs.map((input) => ({
      outPoint: input.outPoint,
      address: input.address,
      lockHash: input.lockHash,
      capacity: formatShannons(input.capacity),
      isCurrentUser: input.address === ckbAddress,
    })),
    outputs: summary.outputs.map((output) => ({
      address: output.address,
      lockHash: output.lockHash,
      capacity: formatShannons(output.capacity),
      isCurrentUser: output.address === ckbAddress || output.address === receiverAddress,
    })),
    totalInputCapacity: formatShannons(summary.totalInputCapacity),
    totalOutputCapacity: formatShannons(summary.totalOutputCapacity),
    fee: formatShannons(summary.fee),
  }
}

function intentMatchesPolicy(intent: Intent | undefined, policy: PrivacyPolicy): boolean {
  return (
    intent?.amount.toString() === policy.mixAmountShannons &&
    intent.minParticipants === policy.minParticipants &&
    intent.minReputation === 0
  )
}

function formatIntentSummary(intent: Intent | undefined): string {
  if (!intent) {
    return 'CoinJoin intent'
  }

  return `${formatShannons(intent.amount)} CoinJoin intent for ${intent.minParticipants} participants`
}
