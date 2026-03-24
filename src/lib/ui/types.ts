import type { CoordinationState } from '../coordination/types'
import type { ConfirmedTransactionSummary } from '../ckb'
import type { AutopilotStatus, PolicyInterpretation } from '../policy'

export type UiNetwork = 'devnet' | 'testnet'

export type IntentType = 'coinjoin' | 'atomic-swap' | 'token-buy' | 'token-sell' | 'otc'

export type NetworkEndpoints = {
  ckbRpcUrl: string
  nostrRelayUrl: string
}

export type PersistedUiConfig = {
  network: UiNetwork
  mixAmountShannons: string
  minParticipants: number
  endpoints: Record<UiNetwork, NetworkEndpoints>
}

export type ActiveUiConfig = {
  network: UiNetwork
  ckbRpcUrl: string
  nostrRelayUrl: string
  mixAmountShannons: string
  minParticipants: number
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'failed'

export type UiIntentRecord = {
  id: string
  pubkey: string
  amountShannons: string
  minParticipants: number
  minReputation: number
  createdAt: number
  createdAtLabel: string
  isMine: boolean
  isCompatible: boolean
}

export type EventLogLevel = 'info' | 'success' | 'warning' | 'error'

export type PolicyStatus = 'idle' | 'interpreting' | 'ready' | 'error'

export type EventLogEntry = {
  id: string
  level: EventLogLevel
  title: string
  detail: string
  timestamp: number
}

export type BalanceSnapshot = {
  display: string
  isLowerBound: boolean
  scannedCells: number
}

export type TransactionRow = {
  address?: string
  lockHash: string
  capacity: string
  isCurrentUser: boolean
  outPoint?: string
}

export type CompletedRoundSummary = {
  txHash: string
  inputs: TransactionRow[]
  outputs: TransactionRow[]
  totalInputCapacity: string
  totalOutputCapacity: string
  fee: string
}

export type RoundStatus = {
  role: 'idle' | 'participant' | 'coordinator'
  participantPhase: CoordinationState | 'IDLE'
  coordinatorPhase: CoordinationState | 'IDLE'
  coordinationId?: string
  txHash?: string
  failureReason?: string
  completedTxSummary?: CompletedRoundSummary
}

export type ConnectionSnapshot = {
  status: ConnectionStatus
  nostrPublicKey?: string
  ckbTip?: string
  lastError?: string
  connectedAt?: number
}

export type UiAdapterEvent =
  | {
      type: 'connection'
      snapshot: ConnectionSnapshot
      message: string
    }
  | {
      type: 'session'
      ckbAddress?: string
      balance?: BalanceSnapshot
      message: string
    }
  | {
      type: 'intents'
      intents: UiIntentRecord[]
      activeIntentId?: string
      message: string
    }
  | {
      type: 'round'
      round: Partial<RoundStatus>
      message: string
      level?: EventLogLevel
    }
  | {
      type: 'policy'
      status: PolicyStatus
      interpretation?: PolicyInterpretation
      message: string
      level?: EventLogLevel
    }
  | {
      type: 'autopilot'
      status: AutopilotStatus
      message: string
      level?: EventLogLevel
    }
  | {
      type: 'notice'
      level: EventLogLevel
      title: string
      detail: string
    }

export type PublishIntentDraft = {
  amount: bigint
  minParticipants: number
  minReputation: number
  receiverAddress: string
}

export type PreparedSession = {
  ckbAddress: string
  balance: BalanceSnapshot
}

export type HighlightableTx = ConfirmedTransactionSummary
