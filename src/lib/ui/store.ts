import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { UiWorkflowAdapter } from './adapter'
import { createDefaultUiConfig } from './defaults'
import type {
  ActiveUiConfig,
  BalanceSnapshot,
  ConnectionSnapshot,
  IntentType,
  EventLogEntry,
  PersistedUiConfig,
  RoundStatus,
  UiIntentRecord,
  UiNetwork,
} from './types'

const adapter = new UiWorkflowAdapter()
const STORAGE_KEY = 'conic-ui-config'

type ConicStore = PersistedUiConfig & {
  connection: ConnectionSnapshot
  ckbPrivateKey: string
  receiverAddress: string
  ckbAddress?: string
  balance?: BalanceSnapshot
  intents: UiIntentRecord[]
  activeIntentId?: string
  eventLog: EventLogEntry[]
  round: RoundStatus
  isPreparingSession: boolean
  isPublishingIntent: boolean
  isRefreshingIntents: boolean
  isSessionConfigExpanded: boolean
  isConsoleOpen: boolean
  selectedIntentType: IntentType
  setNetwork: (network: UiNetwork) => void
  updateEndpoint: (field: keyof PersistedUiConfig['endpoints']['devnet'], value: string) => void
  updateMixAmount: (value: string) => void
  updateMinParticipants: (value: number) => void
  updatePrivateKey: (value: string) => void
  updateReceiverAddress: (value: string) => void
  setSessionConfigExpanded: (value: boolean) => void
  setConsoleOpen: (value: boolean) => void
  setSelectedIntentType: (value: IntentType) => void
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  prepareSession: () => Promise<void>
  publishIntent: () => Promise<void>
  refreshIntents: () => Promise<void>
  deleteActiveIntent: () => Promise<void>
  clearEventLog: () => void
}

const defaultConfig = createDefaultUiConfig()

function buildInitialRound(): RoundStatus {
  return {
    role: 'idle',
    participantPhase: 'IDLE',
    coordinatorPhase: 'IDLE',
  }
}

function getActiveConfig(state: PersistedUiConfig): ActiveUiConfig {
  const endpoints = state.endpoints[state.network]
  return {
    network: state.network,
    ckbRpcUrl: endpoints.ckbRpcUrl,
    nostrRelayUrl: endpoints.nostrRelayUrl,
    mixAmountShannons: state.mixAmountShannons,
    minParticipants: state.minParticipants,
  }
}

function createLogEntry(
  title: string,
  detail: string,
  level: EventLogEntry['level'] = 'info',
): EventLogEntry {
  return {
    id: crypto.randomUUID(),
    title,
    detail,
    level,
    timestamp: Date.now(),
  }
}

function prependLog(entries: EventLogEntry[], next: EventLogEntry, limit = 120): EventLogEntry[] {
  const latest = entries[0]
  if (
    latest &&
    latest.title === next.title &&
    latest.detail === next.detail &&
    latest.level === next.level
  ) {
    return entries
  }

  return [next, ...entries].slice(0, limit)
}

export const useConicStore = create<ConicStore>()(
  persist(
    (set, get) => ({
      ...defaultConfig,
      connection: { status: 'idle' },
      ckbPrivateKey: '',
      receiverAddress: '',
      ckbAddress: undefined,
      balance: undefined,
      intents: [],
      activeIntentId: undefined,
      eventLog: [
        createLogEntry(
          'Ready',
          'Connect the relay and RPC, paste a test key, and publish one intent per tab.',
        ),
      ],
      round: buildInitialRound(),
      isPreparingSession: false,
      isPublishingIntent: false,
      isRefreshingIntents: false,
      isSessionConfigExpanded: true,
      isConsoleOpen: false,
      selectedIntentType: 'coinjoin',
      setNetwork: (network) => {
        set({
          network,
          eventLog: [
            createLogEntry('Network Selected', `Switched the session to ${network}.`),
            ...get().eventLog,
          ].slice(0, 50),
        })
      },
      updateEndpoint: (field, value) => {
        const network = get().network
        set((state) => ({
          endpoints: {
            ...state.endpoints,
            [network]: {
              ...state.endpoints[network],
              [field]: value,
            },
          },
        }))
      },
      updateMixAmount: (value) => set({ mixAmountShannons: value }),
      updateMinParticipants: (value) => set({ minParticipants: value }),
      updatePrivateKey: (value) => set({ ckbPrivateKey: value }),
      updateReceiverAddress: (value) => set({ receiverAddress: value }),
      setSessionConfigExpanded: (value) => set({ isSessionConfigExpanded: value }),
      setConsoleOpen: (value) => set({ isConsoleOpen: value }),
      setSelectedIntentType: (value) => set({ selectedIntentType: value }),
      connect: async () => {
        await adapter.connect(getActiveConfig(get()))
      },
      disconnect: async () => {
        await adapter.disconnect()
      },
      prepareSession: async () => {
        set({ isPreparingSession: true })
        try {
          const state = get()
          await adapter.prepareSession({
            privateKey: state.ckbPrivateKey,
            receiverAddress: state.receiverAddress,
          })
        } finally {
          set({ isPreparingSession: false })
        }
      },
      publishIntent: async () => {
        set({ isPublishingIntent: true })
        try {
          const state = get()
          await adapter.publishIntent({
            amount: BigInt(state.mixAmountShannons),
            minParticipants: state.minParticipants,
            minReputation: 0,
            receiverAddress: state.receiverAddress,
          })
        } finally {
          set({ isPublishingIntent: false })
        }
      },
      refreshIntents: async () => {
        set({ isRefreshingIntents: true })
        try {
          await adapter.refreshRecentIntents()
        } finally {
          set({ isRefreshingIntents: false })
        }
      },
      deleteActiveIntent: async () => {
        await adapter.deleteActiveIntent()
      },
      clearEventLog: () => {
        set({
          eventLog: [
            createLogEntry(
              'Ready',
              'Connect the relay and RPC, paste a test key, and publish one intent per tab.',
            ),
          ],
        })
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        network: state.network,
        mixAmountShannons: state.mixAmountShannons,
        minParticipants: state.minParticipants,
        endpoints: state.endpoints,
      }),
    },
  ),
)

adapter.subscribe((event) => {
  const state = useConicStore.getState()

  switch (event.type) {
    case 'connection':
      useConicStore.setState({
        connection: mergeConnection(state.connection, event.snapshot),
        eventLog: prependLog(
          state.eventLog,
          createLogEntry(
            event.snapshot.status === 'failed' ? 'Connection Failed' : 'Connection Update',
            event.message,
            event.snapshot.status === 'failed' ? 'error' : 'info',
          ),
        ),
      })
      return
    case 'session':
      useConicStore.setState({
        ckbAddress: event.ckbAddress ?? state.ckbAddress,
        balance: event.balance ?? state.balance,
        eventLog: prependLog(
          state.eventLog,
          createLogEntry('Session Prepared', event.message, 'success'),
        ),
      })
      return
    case 'intents':
      useConicStore.setState({
        intents: [...event.intents],
        activeIntentId: event.activeIntentId,
        eventLog: prependLog(
          state.eventLog,
          createLogEntry('Intent Sync', event.message, 'success'),
        ),
      })
      return
    case 'round':
      useConicStore.setState({
        round: {
          ...state.round,
          ...event.round,
        },
        eventLog: prependLog(
          state.eventLog,
          createLogEntry('Round Update', event.message, event.level ?? 'info'),
        ),
      })
      return
    case 'notice':
      useConicStore.setState({
        eventLog: prependLog(
          state.eventLog,
          createLogEntry(event.title, event.detail, event.level),
        ),
      })
  }
})

function mergeConnection(
  current: ConnectionSnapshot,
  next: ConnectionSnapshot,
): ConnectionSnapshot {
  if (next.status === 'idle') return { status: 'idle' }

  return {
    ...current,
    ...next,
  }
}

export function selectActiveConfig(state: ConicStore): ActiveUiConfig {
  return getActiveConfig(state)
}

export function resetConicUiStore(): void {
  useConicStore.persist.clearStorage()
  useConicStore.setState({
    ...defaultConfig,
    connection: { status: 'idle' },
    ckbPrivateKey: '',
    receiverAddress: '',
    ckbAddress: undefined,
    balance: undefined,
    intents: [],
    activeIntentId: undefined,
    eventLog: [
      createLogEntry(
        'Ready',
        'Connect the relay and RPC, paste a test key, and publish one intent per tab.',
      ),
    ],
    round: buildInitialRound(),
    isPreparingSession: false,
    isPublishingIntent: false,
    isRefreshingIntents: false,
    isSessionConfigExpanded: true,
    isConsoleOpen: false,
    selectedIntentType: 'coinjoin',
  })
}
