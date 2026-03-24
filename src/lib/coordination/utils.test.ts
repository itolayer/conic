import { describe, expect, it } from 'vitest'

import { compareProposals, deriveCoordinationId } from './utils'

describe('Coordination Utils', () => {
  it('derives deterministic coordination_id from intent IDs', () => {
    const intents = ['id_c', 'id_a', 'id_b']
    const id1 = deriveCoordinationId(intents)
    const id2 = deriveCoordinationId(['id_b', 'id_c', 'id_a'])

    expect(id1).toBe(id2)
    expect(id1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('proposal tie-breaking: lower created_at wins', () => {
    const a = { id: 'aaa', created_at: 100 }
    const b = { id: 'bbb', created_at: 101 }

    expect(compareProposals(a, b)).toBe(-1)
  })

  it('proposal tie-breaking: equal timestamp -> lexicographic event ID', () => {
    const a = { id: 'bbb', created_at: 100 }
    const b = { id: 'aaa', created_at: 100 }

    expect(compareProposals(a, b)).toBe(1)
  })
})
