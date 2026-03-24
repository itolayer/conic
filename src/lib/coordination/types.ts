import type { CoinjoinParticipant, SignedWitnessEntry } from '../ckb'

export const CoordinationState = {
  MATCHING: 'MATCHING',
  PROPOSING: 'PROPOSING',
  HEARTBEAT: 'HEARTBEAT',
  INPUT_COLLECTION: 'INPUT_COLLECTION',
  BLINDING: 'BLINDING',
  OUTPUT_COLLECTION: 'OUTPUT_COLLECTION',
  TX_ASSEMBLY: 'TX_ASSEMBLY',
  SIGNING: 'SIGNING',
  BROADCASTING: 'BROADCASTING',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
  RETRY: 'RETRY',
} as const

export type CoordinationState = (typeof CoordinationState)[keyof typeof CoordinationState]

export type Intent = {
  id: string
  pubkey: string
  amount: bigint
  minParticipants: number
  minReputation?: number
  createdAt: number
}

export type CoordinationProposalMessage = {
  type: 'coordination_proposal'
  matched_intents: string[]
  coordinator_pubkey: string
}

export type HeartbeatMessage = {
  type: 'heartbeat'
  coordination_id: string
  status: string
}

export type HeartbeatAckMessage = {
  type: 'heartbeat_ack'
  coordination_id: string
}

export type InputRequestMessage = {
  type: 'input_request'
  coordination_id: string
  rsa_public_key: JsonWebKey | string
}

export type InputSubmissionMessage = {
  type: 'input_submission'
  coordination_id: string
  inputs: CoinjoinParticipant['cells']
  change_address: string
  blinded_token: Uint8Array | string
}

export type BlindSignatureMessage = {
  type: 'blind_signature'
  coordination_id: string
  signed_blinded_token: Uint8Array | string
}

export type OutputSubmissionMessage = {
  type: 'output_submission'
  coordination_id: string
  unblinded_token: Uint8Array | string
  output_address: string
  output_identity_pubkey?: string
}

export type TxProposalMessage = {
  type: 'tx_proposal'
  coordination_id: string
  unsigned_tx_hex: unknown
  input_indices?: number[]
}

export type TxSignatureMessage = {
  type: 'tx_signature'
  coordination_id: string
  witnesses: string[]
  input_indices?: number[]
  signed_witnesses?: SignedWitnessEntry[]
}

export type RoundCompleteMessage = {
  type: 'round_complete'
  coordination_id: string
  tx_hash: string
}

export type RoundFailedMessage = {
  type: 'round_failed'
  coordination_id: string
  reason: string
}

export type CoordinationMessage =
  | CoordinationProposalMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | InputRequestMessage
  | InputSubmissionMessage
  | BlindSignatureMessage
  | OutputSubmissionMessage
  | TxProposalMessage
  | TxSignatureMessage
  | RoundCompleteMessage
  | RoundFailedMessage

export type ParticipantContext = {
  state: CoordinationState
  intent: Intent
  coordinationId?: string
  matchedIntents: string[]
  coordinatorPubkey?: string
  rsaPublicKey?: JsonWebKey | string
  rsaPubkeyFingerprint?: string
  blindedToken?: Uint8Array
  blindInverse?: Uint8Array
  preparedToken?: Uint8Array
  outputIdentityPubkey?: string
  coinjoinParticipant?: CoinjoinParticipant
  lastHeartbeatAt?: number
  failureReason?: string
}

export type ProposalOrderingCandidate = {
  id: string
  created_at: number
}
