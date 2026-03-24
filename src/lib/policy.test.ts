import { describe, expect, it } from 'vitest'

import { normalizePolicyResponse } from './policy'

describe('normalizePolicyResponse', () => {
  it('normalizes a supported CoinJoin policy into shannons', () => {
    const interpretation = normalizePolicyResponse('Mix 1000 CKB with 4 peers for privacy', {
      intentType: 'coinjoin',
      mixAmountCkb: '1000',
      minParticipants: 4,
      supported: true,
      summary: 'Mix 1000 CKB with 4 peers.',
      explanation: 'A four-peer CoinJoin improves the anonymity set.',
      warnings: ['Receiver address is collected later.'],
    })

    expect(interpretation.supported).toBe(true)
    expect(interpretation.policy).toEqual({
      intentType: 'coinjoin',
      mixAmountShannons: '100000000000',
      minParticipants: 4,
    })
    expect(interpretation.warnings).toEqual(['Receiver address is collected later.'])
  })

  it('defaults min participants to 3 when omitted', () => {
    const interpretation = normalizePolicyResponse('Mix 250 CKB privately', {
      intentType: 'coinjoin',
      mixAmountCkb: '250',
      supported: true,
    })

    expect(interpretation.supported).toBe(true)
    expect(interpretation.policy?.minParticipants).toBe(3)
  })

  it('rejects unsupported payment-channel requests', () => {
    const interpretation = normalizePolicyResponse('Use Fiber to route private payments', {
      intentType: 'coinjoin',
      mixAmountCkb: '100',
      minParticipants: 3,
      supported: true,
    })

    expect(interpretation.supported).toBe(false)
    expect(interpretation.summary).toMatch(/unsupported/i)
    expect(interpretation.explanation).toMatch(/scope/i)
  })

  it('rejects requests without a mix amount', () => {
    const interpretation = normalizePolicyResponse('Make me more private on CKB', {
      intentType: 'coinjoin',
      supported: true,
    })

    expect(interpretation.supported).toBe(false)
    expect(interpretation.explanation).toMatch(/amount/i)
  })
})
