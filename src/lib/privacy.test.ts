import { describe, expect, it } from 'vitest'

import { PrivacyService } from './privacy'

describe('PrivacyService', () => {
  it('full blind signature round-trip', async () => {
    const coordinator = new PrivacyService()
    const { publicKey, privateKey } = await coordinator.generateRsaKeyPair()

    const participant = new PrivacyService()
    const message = crypto.getRandomValues(new Uint8Array(32))
    const { blindedMessage, blindInverse, preparedMessage } = await participant.blind(
      publicKey,
      message,
    )

    const blindSignature = await coordinator.blindSign(privateKey, blindedMessage)

    const signature = await participant.finalize(
      publicKey,
      preparedMessage,
      blindSignature,
      blindInverse,
    )

    const valid = await participant.verify(publicKey, preparedMessage, signature)
    expect(valid).toBe(true)
  })

  it('RSA public key fingerprint matches JWK hash', async () => {
    const svc = new PrivacyService()
    const { publicKey } = await svc.generateRsaKeyPair()
    const fingerprint = await svc.computeFingerprint(publicKey)

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('exports and imports the public key for wire transport', async () => {
    const svc = new PrivacyService()
    const { publicKey, privateKey } = await svc.generateRsaKeyPair()
    const jwk = await svc.exportPublicKey(publicKey)
    const importedPublicKey = await svc.importPublicKey(jwk)

    const message = crypto.getRandomValues(new Uint8Array(32))
    const { blindedMessage, blindInverse, preparedMessage } = await svc.blind(
      importedPublicKey,
      message,
    )
    const blindSignature = await svc.blindSign(privateKey, blindedMessage)
    const signature = await svc.finalize(
      importedPublicKey,
      preparedMessage,
      blindSignature,
      blindInverse,
    )

    await expect(svc.verify(importedPublicKey, preparedMessage, signature)).resolves.toBe(true)
  })

  it('forged signature fails verification', async () => {
    const svc = new PrivacyService()
    const { publicKey } = await svc.generateRsaKeyPair()
    const message = crypto.getRandomValues(new Uint8Array(32))
    const fakeSignature = crypto.getRandomValues(new Uint8Array(256))
    const valid = await svc.verify(publicKey, message, fakeSignature)

    expect(valid).toBe(false)
  })
})
