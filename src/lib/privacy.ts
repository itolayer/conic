import { RSABSSA } from '@cloudflare/blindrsa-ts'

const RSA_MODULUS_LENGTH = 2048
const RSA_PUBLIC_EXPONENT = new Uint8Array([1, 0, 1])

type PublicJwk = JsonWebKey & Required<Pick<JsonWebKey, 'kty' | 'n' | 'e'>>

type PrivateJwk = JsonWebKey

type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

export class PrivacyService {
  readonly #suite = RSABSSA.SHA384.PSS.Randomized({ supportsRSARAW: false })

  async generateRsaKeyPair(): Promise<CryptoKeyPair> {
    return this.#suite.generateKey({
      modulusLength: RSA_MODULUS_LENGTH,
      publicExponent: RSA_PUBLIC_EXPONENT,
    })
  }

  async blind(publicKey: CryptoKey, message: Uint8Array) {
    const preparedMessage = this.#suite.prepare(message)
    const { blindedMsg, inv } = await this.#suite.blind(publicKey, preparedMessage)

    return {
      blindedMessage: blindedMsg,
      blindInverse: inv,
      preparedMessage,
    }
  }

  async blindSign(privateKey: CryptoKey, blindedMessage: Uint8Array): Promise<Uint8Array> {
    return this.#suite.blindSign(privateKey, blindedMessage)
  }

  async finalize(
    publicKey: CryptoKey,
    message: Uint8Array,
    blindSignature: Uint8Array,
    blindInverse: Uint8Array,
  ): Promise<Uint8Array> {
    return this.#suite.finalize(publicKey, message, blindSignature, blindInverse)
  }

  async verify(publicKey: CryptoKey, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return this.#suite.verify(publicKey, signature, message)
  }

  async computeFingerprint(publicKey: CryptoKey): Promise<string> {
    const jwk = await this.exportPublicKey(publicKey)
    const encoded = new TextEncoder().encode(
      this.#canonicalize(jwk as unknown as CanonicalJsonValue),
    )
    const digest = await crypto.subtle.digest('SHA-256', encoded)

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  async exportPublicKey(publicKey: CryptoKey): Promise<PublicJwk> {
    const jwk = await crypto.subtle.exportKey('jwk', publicKey)

    if (typeof jwk.kty !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
      throw new Error('Exported RSA public key is missing required JWK fields')
    }

    return {
      ...jwk,
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
    }
  }

  async importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'RSA-PSS',
        hash: 'SHA-384',
      },
      true,
      ['verify'],
    )
  }

  async exportPrivateKey(privateKey: CryptoKey): Promise<PrivateJwk> {
    return crypto.subtle.exportKey('jwk', privateKey)
  }

  async importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'RSA-PSS',
        hash: 'SHA-384',
      },
      true,
      ['sign'],
    )
  }

  #canonicalize(value: CanonicalJsonValue): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.#canonicalize(item)).join(',')}]`
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(
          ([key, entryValue]) =>
            `${JSON.stringify(key)}:${this.#canonicalize(entryValue as CanonicalJsonValue)}`,
        )

      return `{${entries.join(',')}}`
    }

    return JSON.stringify(value)
  }
}
