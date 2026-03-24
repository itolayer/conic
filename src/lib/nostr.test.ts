import { afterEach, describe, expect, it } from 'vitest'

import { Config } from './config'
import { NostrService } from './nostr'

const TEST_TIMEOUT_MS = 20_000

async function withConnectedServices(
  run: (service1: NostrService, service2: NostrService) => Promise<void>,
  skip: (note?: string) => never,
) {
  const service1 = new NostrService()
  const service2 = new NostrService()

  try {
    await Promise.all([
      service1.connect(Config.nostrRelayUrl),
      service2.connect(Config.nostrRelayUrl),
    ])
  } catch (error) {
    await Promise.allSettled([service1.disconnect(), service2.disconnect()])
    skip(
      `Local Nostr relay unavailable at ${Config.nostrRelayUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  try {
    await run(service1, service2)
  } finally {
    await Promise.allSettled([service1.disconnect(), service2.disconnect()])
  }
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200))
})

describe('NostrService', () => {
  it(
    'SC-1/SC-2: publish intent and list it from another identity',
    async ({ skip }) => {
      await withConnectedServices(async (service1, service2) => {
        const intentId = await service1.publishIntent({
          amount: 100_000_000_000n,
          minParticipants: 3,
        })

        expect(intentId).toBeTruthy()

        await new Promise((resolve) => setTimeout(resolve, 500))

        const intents = await service2.listIntents()
        const found = intents.find((intent) => intent.id === intentId)

        expect(found).toBeDefined()
        expect(found?.amount).toBe(100_000_000_000n)
        expect(found?.minParticipants).toBe(3)
      }, skip)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'ignores delete events from other identities when listing intents',
    async ({ skip }) => {
      await withConnectedServices(async (service1, service2) => {
        const intentId = await service1.publishIntent({
          amount: 100_000_000_000n,
          minParticipants: 3,
        })

        await new Promise((resolve) => setTimeout(resolve, 500))
        await service2.deleteEvent(intentId)
        await new Promise((resolve) => setTimeout(resolve, 500))

        const intents = await service2.listIntents()
        expect(intents.find((intent) => intent.id === intentId)).toBeDefined()
      }, skip)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'should publish round commitment (Kind 30078)',
    async ({ skip }) => {
      await withConnectedServices(async (service1, service2) => {
        const coordinationId = `test-coordination-id-${Date.now()}`
        const rsaPubkeyFingerprint = 'test-fingerprint'
        const matchedIntents = ['intent1', 'intent2', 'intent3']

        await service1.publishRoundCommitment({
          coordinationId,
          matchedIntents,
          rsaPubkeyFingerprint,
        })

        await new Promise((resolve) => setTimeout(resolve, 500))

        const commitment = await service2.getRoundCommitment(coordinationId)
        expect(commitment).toBeDefined()
        expect(commitment?.rsaPubkeyFingerprint).toBe(rsaPubkeyFingerprint)
        expect(commitment?.matchedIntents).toEqual(matchedIntents)
      }, skip)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'should send and receive NIP-17 private messages',
    async ({ skip }) => {
      await withConnectedServices(async (service1, service2) => {
        const received: unknown[] = []
        const stopListening = service2.onPrivateMessage((message) => received.push(message))

        try {
          await service1.sendPrivateMessage(service2.publicKey, {
            type: 'heartbeat',
            coordination_id: 'test',
            status: 'waiting',
          })

          await new Promise((resolve) => setTimeout(resolve, 2_000))

          expect(received.length).toBeGreaterThanOrEqual(1)
          expect(received[0]).toMatchObject({
            type: 'heartbeat',
            coordination_id: 'test',
            status: 'waiting',
          })
        } finally {
          stopListening()
        }
      }, skip)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'does not deliver sender copies when messaging another identity',
    async ({ skip }) => {
      await withConnectedServices(async (service1, service2) => {
        const senderReceived: unknown[] = []
        const recipientReceived: unknown[] = []
        const stopSender = service1.onPrivateMessage((message) => senderReceived.push(message))
        const stopRecipient = service2.onPrivateMessage((message) =>
          recipientReceived.push(message),
        )

        try {
          await service1.sendPrivateMessage(service2.publicKey, {
            type: 'heartbeat',
            coordination_id: 'test-no-self-copy',
            status: 'waiting',
          })

          await new Promise((resolve) => setTimeout(resolve, 2_000))

          expect(recipientReceived.length).toBeGreaterThanOrEqual(1)
          expect(senderReceived).toHaveLength(0)
        } finally {
          stopSender()
          stopRecipient()
        }
      }, skip)
    },
    TEST_TIMEOUT_MS,
  )
})
