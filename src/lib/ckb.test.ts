import { beforeAll, describe, expect, it } from 'vitest'

import { Config } from './config'
import { DevnetCkbService } from './ckb-devnet'

const TEST_TIMEOUT_MS = 120_000
const AVAILABILITY_TIMEOUT_MS = 8_000

describe('DevnetCkbService', () => {
  let service: DevnetCkbService
  let available = true
  let availabilityReason = ''

  beforeAll(async () => {
    service = new DevnetCkbService(Config.ckbRpcUrl)

    try {
      await Promise.race([
        (async () => {
          await service.waitForReady()
          await service.loadDevnetKeys()
        })(),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`Devnet readiness timed out after ${AVAILABILITY_TIMEOUT_MS}ms`)),
            AVAILABILITY_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (error) {
      available = false
      availabilityReason = error instanceof Error ? error.message : String(error)
    }
  }, TEST_TIMEOUT_MS)

  it(
    'assembles a coinjoin transaction structure',
    async ({ skip }) => {
      if (!available)
        skip(`Local CKB devnet unavailable at ${Config.ckbRpcUrl}: ${availabilityReason}`)

      const keys = await service.loadDevnetKeys()
      const mixAmount = 100_00000000n
      const participants = await Promise.all(
        keys
          .slice(0, 3)
          .map((privateKey) => service.createParticipant(privateKey, mixAmount + 6100000000n)),
      )

      const result = await service.assembleCoinjoinTx({
        participants,
        mixAmount,
        feeRatePerKb: 1000n,
      })

      expect(result.mixOutputs.length).toBe(3)
      for (const output of result.mixOutputs) {
        expect(output.capacity).toBe(mixAmount)
      }
      expect(result.unsignedTx).toBeDefined()
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'signs and broadcasts a simple transfer (smoke)',
    async ({ skip }) => {
      if (!available)
        skip(`Local CKB devnet unavailable at ${Config.ckbRpcUrl}: ${availabilityReason}`)

      const keys = await service.loadDevnetKeys()
      const txHash = await service.smokeTransfer(keys[0], keys[1], 100_00000000n)
      expect(txHash).toMatch(/^0x[a-f0-9]{64}$/)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'assembles, multi-signs, broadcasts, and confirms a coinjoin tx on devnet',
    async ({ skip }) => {
      if (!available)
        skip(`Local CKB devnet unavailable at ${Config.ckbRpcUrl}: ${availabilityReason}`)

      const keys = await service.loadDevnetKeys()
      const mixAmount = 100_00000000n
      const participants = await Promise.all(
        keys
          .slice(0, 3)
          .map((privateKey) => service.createParticipant(privateKey, mixAmount + 6100000000n)),
      )

      const result = await service.assembleCoinjoinTx({
        participants,
        mixAmount,
        feeRatePerKb: 1000n,
      })

      expect(result.mixOutputs.length).toBe(3)
      expect(new Set(result.mixOutputs.map((output) => output.capacity)).size).toBe(1)

      expect(result.inputsByParticipant.size).toBe(3)
      for (const [, indices] of result.inputsByParticipant) {
        expect(indices.length).toBeGreaterThanOrEqual(1)
      }

      for (const change of result.changeOutputs) {
        expect(change.capacity).toBeGreaterThanOrEqual(6100000000n)
      }

      expect(result.totalInputCapacity).toBeGreaterThan(result.totalOutputCapacity)
      expect(result.totalInputCapacity - result.totalOutputCapacity).toBeGreaterThan(0n)

      let signedTx = result.unsignedTx
      const signingOrder = [...result.inputsByParticipant.entries()].sort((left, right) => {
        const leftFirst = left[1][0] ?? -1
        const rightFirst = right[1][0] ?? -1
        return rightFirst - leftFirst
      })

      for (const [participantIdx, inputIndices] of signingOrder) {
        const witnesses = await service.signInputs(signedTx, keys[participantIdx], inputIndices)
        expect(witnesses.length).toBe(inputIndices.length)
        signedTx = service.mergeWitnesses(signedTx, [witnesses])
      }

      const txHash = await service.broadcast(signedTx)
      expect(txHash).toMatch(/^0x[a-f0-9]{64}$/)

      const confirmedTx = await service.getTransaction(txHash)
      expect(confirmedTx).toBeDefined()

      const onChainMixOutputs = confirmedTx!.outputs.filter(
        (output) => output.capacity === mixAmount,
      )
      expect(onChainMixOutputs.length).toBe(3)
      expect(new Set(onChainMixOutputs.map((output) => output.lockHash)).size).toBe(3)
    },
    TEST_TIMEOUT_MS,
  )
})
