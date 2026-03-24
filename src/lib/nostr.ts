import { ccc } from '@ckb-ccc/core'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
  type UnsignedEvent,
} from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17'
import { Relay, type Subscription } from 'nostr-tools/relay'

const INTENT_KIND = 30_078
const GIFT_WRAP_KIND = 1_059
const DELETE_KIND = 5
const DEFAULT_QUERY_TIMEOUT_MS = 5_000
const ROUND_COMMITMENT_CACHE_WINDOW_SECONDS = 60 * 60

export type PublishIntentParams = {
  amount: bigint
  minParticipants: number
  minReputation?: number
}

export type Intent = {
  id: string
  pubkey: string
  amount: bigint
  minParticipants: number
  minReputation: number
  createdAt: number
}

export type PublishRoundCommitmentParams = {
  coordinationId: string
  matchedIntents: string[]
  rsaPubkeyFingerprint: string
}

export type RoundCommitment = {
  id: string
  pubkey: string
  coordinationId: string
  matchedIntents: string[]
  rsaPubkeyFingerprint: string
  createdAt: number
}

export class NostrService {
  #secretKey: Uint8Array
  #publicKey: string
  #relay?: Relay
  #privateMessageSubscriptions = new Set<Subscription>()
  #roundCommitmentSubscription?: Subscription
  #roundCommitmentCache = new Map<string, RoundCommitment>()

  constructor(secretKey = generateSecretKey()) {
    this.#secretKey = secretKey
    this.#publicKey = getPublicKey(secretKey)
  }

  get publicKey(): string {
    return this.#publicKey
  }

  get secretKey(): Uint8Array {
    return this.#secretKey
  }

  rotateIdentity(secretKey = generateSecretKey()): string {
    this.#secretKey = secretKey
    this.#publicKey = getPublicKey(secretKey)
    return this.#publicKey
  }

  async connect(url: string): Promise<void> {
    if (this.#relay?.connected && this.#relay.url === url) return

    this.#roundCommitmentSubscription?.close('reconnect')
    this.#roundCommitmentSubscription = undefined
    this.#relay?.close()
    this.#relay = await Relay.connect(url)
    this.#subscribeRoundCommitments()
  }

  async disconnect(): Promise<void> {
    for (const subscription of this.#privateMessageSubscriptions) {
      subscription.close('client disconnect')
    }
    this.#privateMessageSubscriptions.clear()
    this.#roundCommitmentSubscription?.close('client disconnect')
    this.#roundCommitmentSubscription = undefined
    this.#roundCommitmentCache.clear()
    this.#relay?.close()
    this.#relay = undefined
  }

  async publishIntent({
    amount,
    minParticipants,
    minReputation = 0,
  }: PublishIntentParams): Promise<string> {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Intent amount exceeds JSON safe integer range')
    }

    const dedupeId = crypto.randomUUID()
    const event = await this.#publishEvent({
      kind: INTENT_KIND,
      tags: [
        ['t', 'ckb-coinjoin'],
        ['d', dedupeId],
      ],
      content: JSON.stringify({
        type: 'ckb-coinjoin',
        amount: Number(amount),
        min_participants: minParticipants,
        min_reputation: minReputation,
      }),
    })

    return event.id
  }

  async deleteEvent(eventId: string): Promise<string> {
    const event = await this.#publishEvent({
      kind: DELETE_KIND,
      tags: [['e', eventId]],
      content: '',
    })

    return event.id
  }

  async listIntents(): Promise<Intent[]> {
    const events = await this.#queryEvents([
      {
        kinds: [INTENT_KIND],
        '#t': ['ckb-coinjoin'],
      },
    ])
    const deleted = collectDeletedIds(
      await this.#queryEvents([
        {
          kinds: [DELETE_KIND],
        },
      ]),
    )

    const intents = events
      .map((event) => this.#parseIntent(event))
      .filter((intent): intent is Intent => intent !== null)
      .filter((intent) => !deleted.has(intent.id))

    const dedupedById = new Map<string, Intent>()
    for (const intent of intents) {
      dedupedById.set(intent.id, intent)
    }

    const latestByPubkey = new Map<string, Intent>()
    for (const intent of dedupedById.values()) {
      const existing = latestByPubkey.get(intent.pubkey)
      if (!existing || compareIntentFreshness(intent, existing) < 0) {
        latestByPubkey.set(intent.pubkey, intent)
      }
    }

    return [...latestByPubkey.values()]
  }

  async publishRoundCommitment({
    coordinationId,
    matchedIntents,
    rsaPubkeyFingerprint,
  }: PublishRoundCommitmentParams): Promise<string> {
    const event = await this.#publishEvent({
      kind: INTENT_KIND,
      tags: [
        ['t', 'ckb-coinjoin-round'],
        ['d', coordinationId],
        ...matchedIntents.map((intentId) => ['e', intentId] as string[]),
      ],
      content: JSON.stringify({
        type: 'round-commitment',
        coordination_id: coordinationId,
        matched_intents: matchedIntents,
        rsa_pubkey_fingerprint: rsaPubkeyFingerprint,
      }),
    })

    this.#roundCommitmentCache.set(coordinationId, {
      id: event.id,
      pubkey: this.#publicKey,
      coordinationId,
      matchedIntents: [...matchedIntents],
      rsaPubkeyFingerprint,
      createdAt: Math.floor(Date.now() / 1000),
    })

    return event.id
  }

  async getRoundCommitment(coordinationId: string): Promise<RoundCommitment | undefined> {
    const cached = this.#roundCommitmentCache.get(coordinationId)
    if (cached) {
      return cached
    }

    const events = await this.#queryEvents([
      {
        kinds: [INTENT_KIND],
        '#t': ['ckb-coinjoin-round'],
        '#d': [coordinationId],
      },
    ])

    const commitment = events
      .map((event) => this.#parseRoundCommitment(event))
      .find((commitment) => commitment !== null)
    if (commitment) {
      this.#roundCommitmentCache.set(coordinationId, commitment)
    }

    return commitment
  }

  async sendPrivateMessage(recipientPubkey: string, payload: unknown): Promise<void> {
    const relay = this.#requireRelay()
    const wrap = wrapEvent(
      this.#secretKey,
      { publicKey: recipientPubkey },
      encodePrivatePayload(payload),
    )

    await relay.publish(wrap)
  }

  onPrivateMessage(handler: (message: unknown, senderPubkey?: string) => void): () => void {
    const relay = this.#requireRelay()
    const subscription = relay.subscribe(
      [
        {
          kinds: [GIFT_WRAP_KIND],
          '#p': [this.#publicKey],
        },
      ],
      {
        onevent: (event) => {
          try {
            const rumor = unwrapEvent(event, this.#secretKey)
            handler(decodePrivatePayload(rumor.content), rumor.pubkey)
          } catch {
            // Ignore events that cannot be unwrapped or parsed for this identity.
          }
        },
      },
    )

    this.#privateMessageSubscriptions.add(subscription)

    return () => {
      subscription.close('listener disposed')
      this.#privateMessageSubscriptions.delete(subscription)
    }
  }

  #requireRelay(): Relay {
    if (!this.#relay) {
      throw new Error('NostrService is not connected')
    }

    return this.#relay
  }

  #subscribeRoundCommitments(): void {
    const relay = this.#requireRelay()
    const since = Math.floor(Date.now() / 1000) - ROUND_COMMITMENT_CACHE_WINDOW_SECONDS
    this.#roundCommitmentSubscription = relay.subscribe(
      [
        {
          kinds: [INTENT_KIND],
          '#t': ['ckb-coinjoin-round'],
          since,
        },
      ],
      {
        onevent: (event) => {
          const commitment = this.#parseRoundCommitment(event)
          if (!commitment) {
            return
          }

          this.#roundCommitmentCache.set(commitment.coordinationId, commitment)
        },
      },
    )
  }

  async #publishEvent(event: {
    kind: number
    tags: string[][]
    content: string
  }): Promise<{ id: string }> {
    const relay = this.#requireRelay()
    const publishedEvent = finalizeEvent(
      {
        kind: event.kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: event.tags,
        content: event.content,
      } as UnsignedEvent,
      this.#secretKey,
    )

    await relay.publish(publishedEvent)

    return publishedEvent
  }

  async #queryEvents(filters: Filter[], timeoutMs = DEFAULT_QUERY_TIMEOUT_MS) {
    const relay = this.#requireRelay()

    return await new Promise<Event[]>((resolve, reject) => {
      const events: Event[] = []

      const subscription = relay.subscribe(filters, {
        onevent: (event) => {
          events.push(event)
        },
        oneose: () => {
          subscription.close('eose')
          resolve(events)
        },
        onclose: (reason) => {
          reject(new Error(`Subscription closed before EOSE: ${reason}`))
        },
      })

      const timeoutHandle = setTimeout(() => {
        subscription.close('timeout')
        resolve(events)
      }, timeoutMs)

      const settle = (callback: () => void) => {
        clearTimeout(timeoutHandle)
        callback()
      }

      subscription.oneose = () => settle(() => resolve(events))
      subscription.onclose = (reason) => {
        if (reason === 'eose' || reason === 'timeout') {
          settle(() => resolve(events))
          return
        }

        settle(() => reject(new Error(`Subscription closed before EOSE: ${reason}`)))
      }
    })
  }

  #parseIntent(event: Event): Intent | null {
    try {
      const content = JSON.parse(event.content) as {
        type?: string
        amount?: number
        min_participants?: number
        min_reputation?: number
      }

      if (content.type !== 'ckb-coinjoin') return null
      if (typeof content.amount !== 'number') return null
      if (typeof content.min_participants !== 'number') return null

      return {
        id: event.id,
        pubkey: event.pubkey,
        amount: BigInt(content.amount),
        minParticipants: content.min_participants,
        minReputation: content.min_reputation ?? 0,
        createdAt: event.created_at,
      }
    } catch {
      return null
    }
  }

  #parseRoundCommitment(event: Event): RoundCommitment | null {
    try {
      const content = JSON.parse(event.content) as {
        type?: string
        coordination_id?: string
        matched_intents?: string[]
        rsa_pubkey_fingerprint?: string
      }

      if (content.type !== 'round-commitment') return null
      if (typeof content.coordination_id !== 'string') return null
      if (!Array.isArray(content.matched_intents)) return null
      if (typeof content.rsa_pubkey_fingerprint !== 'string') return null

      return {
        id: event.id,
        pubkey: event.pubkey,
        coordinationId: content.coordination_id,
        matchedIntents: [...content.matched_intents],
        rsaPubkeyFingerprint: content.rsa_pubkey_fingerprint,
        createdAt: event.created_at,
      }
    } catch {
      return null
    }
  }
}

function collectDeletedIds(events: Event[]): Set<string> {
  const deleted = new Set<string>()

  for (const event of events) {
    if (event.kind !== DELETE_KIND) continue
    for (const tag of event.tags) {
      if (tag[0] === 'e' && typeof tag[1] === 'string') {
        deleted.add(tag[1])
      }
    }
  }

  return deleted
}

function compareIntentFreshness(left: Intent, right: Intent): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt
  }

  return right.id.localeCompare(left.id)
}

function encodePrivatePayload(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) => {
    if (value instanceof Uint8Array) {
      return { __type: 'bytes', hex: bytesToHex(value) }
    }

    if (typeof value === 'bigint') {
      return { __type: 'bigint', value: `0x${value.toString(16)}` }
    }

    if (value instanceof ccc.Cell || value instanceof ccc.Transaction) {
      return {
        __type: value instanceof ccc.Cell ? 'cell' : 'transaction',
        json: ccc.stringify(value),
      }
    }

    return value
  })
}

function decodePrivatePayload(content: string): unknown {
  return JSON.parse(content, (_key, value) => {
    if (!value || typeof value !== 'object' || !('__type' in value)) {
      return value
    }

    const tagged = value as { __type: string; [key: string]: unknown }
    switch (tagged.__type) {
      case 'bytes':
        return hexToBytes(String(tagged.hex))
      case 'bigint':
        return BigInt(String(tagged.value))
      case 'cell':
        return ccc.Cell.from(JSON.parse(String(tagged.json)))
      case 'transaction':
        return ccc.Transaction.from(JSON.parse(String(tagged.json)))
      default:
        return value
    }
  })
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex
  return Uint8Array.from({ length: normalized.length / 2 }, (_, index) =>
    Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16),
  )
}
