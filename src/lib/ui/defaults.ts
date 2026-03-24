import { Config } from '../config'
import type { PersistedUiConfig } from './types'

export const DEFAULT_DEVNET_ENDPOINTS = {
  ckbRpcUrl: Config.ckbRpcUrl,
  nostrRelayUrl: Config.nostrRelayUrl,
} as const

export const DEFAULT_TESTNET_ENDPOINTS = {
  ckbRpcUrl: '',
  nostrRelayUrl: '',
} as const

export function createDefaultUiConfig(): PersistedUiConfig {
  return {
    network: 'devnet',
    mixAmountShannons: Config.mixAmountShannons.toString(),
    minParticipants: Config.minParticipants,
    endpoints: {
      devnet: { ...DEFAULT_DEVNET_ENDPOINTS },
      testnet: { ...DEFAULT_TESTNET_ENDPOINTS },
    },
  }
}
