import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => {
  const mockListIntents = vi.fn()
  const mockPublishIntent = vi.fn(async () => 'intent-self')
  const mockCoordinatorStartRound = vi.fn(async () => undefined)
  const mockCoordinatorOn = vi.fn(() => () => undefined)
  const mockGetTip = vi.fn(async () => 1n)
  const mockFindCells = vi.fn(async function* () {
    yield {
      cellOutput: {
        capacity: '4199499999996341',
      },
    }
  })

  const mockCkbClient = {
    url: 'http://127.0.0.1:28114',
    getTip: mockGetTip,
    findCells: mockFindCells,
  }

  return {
    mockListIntents,
    mockPublishIntent,
    mockCreateCkbClient: vi.fn(async () => mockCkbClient),
    mockCoordinatorStartRound,
    mockCoordinatorOn,
    mockGetTip,
    mockFindCells,
    mockCkbClient,
    coordinatorInstances: [] as unknown[],
    participantInstances: [] as unknown[],
    privateMessageHandler: undefined as
      | ((message: unknown, senderPubkey?: string) => void)
      | undefined,
  }
})

vi.mock('@ckb-ccc/core', () => ({
  ccc: {
    Address: {
      fromString: vi.fn(async (address: string) => ({
        script: { codeHash: '0x1', hashType: 'type', args: '0x01' },
        toString: () => address,
      })),
    },
    SignerCkbPrivateKey: class {
      constructor(client: unknown, privateKey: string) {
        void client
        void privateKey
      }

      async getRecommendedAddressObj() {
        return {
          script: { codeHash: '0x1', hashType: 'type', args: '0x01' },
          toString: () => 'ckt1qselfaddress',
        }
      }
    },
  },
}))

vi.mock('../nostr', () => ({
  NostrService: class {
    publicKey = 'self-pubkey'

    async connect(url: string) {
      void url
    }

    async disconnect() {}

    async listIntents() {
      return await mocked.mockListIntents()
    }

    async publishIntent() {
      return await mocked.mockPublishIntent()
    }

    async deleteEvent() {
      return 'deleted'
    }

    async publishRoundCommitment() {
      return 'commitment-id'
    }

    async getRoundCommitment() {
      return undefined
    }

    async sendPrivateMessage() {}

    onPrivateMessage(handler: (message: unknown, senderPubkey?: string) => void) {
      mocked.privateMessageHandler = handler
      return () => undefined
    }
  },
}))

vi.mock('../ckb', () => ({
  CkbService: class {
    client: unknown

    constructor(client: unknown) {
      this.client = client
    }

    async createParticipant() {
      return {
        mixLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        changeLock: { codeHash: '0x1', hashType: 'type', args: '0x11' },
        cells: [] as never[],
        inputCapacity: 100n,
      }
    }
  },
}))

vi.mock('../privacy', () => ({
  PrivacyService: class {},
}))

vi.mock('../coordination/coordinator', () => ({
  CoordinationCoordinator: class {
    startRound = mocked.mockCoordinatorStartRound
    handleMessage = vi.fn(async () => undefined)
    destroy = vi.fn(() => undefined)
    on = mocked.mockCoordinatorOn

    constructor(...args: unknown[]) {
      void args
      mocked.coordinatorInstances.push(this)
    }
  },
}))

vi.mock('../coordination/participant', () => ({
  CoordinationParticipant: class {
    state = 'MATCHING'
    context = { failureReason: undefined }
    handleMessage = vi.fn(async () => undefined)
    destroy = vi.fn(() => undefined)

    constructor(...args: unknown[]) {
      void args
      mocked.participantInstances.push(this)
    }
  },
}))

vi.mock('./ckb-client', () => ({
  createCkbClient: mocked.mockCreateCkbClient,
}))

import { UiWorkflowAdapter } from './adapter'

describe('UiWorkflowAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.coordinatorInstances.length = 0
    mocked.participantInstances.length = 0
    mocked.mockListIntents.mockResolvedValue([])
    mocked.privateMessageHandler = undefined
  })

  it('does not start two rounds when refreshRecentIntents overlaps', async () => {
    const adapter = new UiWorkflowAdapter()

    await adapter.connect({
      network: 'devnet',
      ckbRpcUrl: 'http://127.0.0.1:28114',
      nostrRelayUrl: 'ws://127.0.0.1:8080',
      mixAmountShannons: '100000000000',
      minParticipants: 3,
    })

    await adapter.prepareSession({
      privateKey: '0xabc',
      receiverAddress: 'ckt1qreceiver',
    })

    mocked.mockListIntents.mockResolvedValue([
      {
        id: 'intent-self',
        pubkey: 'self-pubkey',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: Math.floor(Date.now() / 1000),
      },
    ])

    await adapter.publishIntent({
      amount: 100_000_000_000n,
      minParticipants: 3,
      minReputation: 0,
      receiverAddress: 'ckt1qreceiver',
    })

    const now = Math.floor(Date.now() / 1000)
    mocked.mockListIntents.mockResolvedValue([
      {
        id: 'intent-self',
        pubkey: 'self-pubkey',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now,
      },
      {
        id: 'intent-b',
        pubkey: 'peer-b',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now - 1,
      },
      {
        id: 'intent-c',
        pubkey: 'peer-c',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now - 2,
      },
    ])

    await Promise.all([adapter.refreshRecentIntents(), adapter.refreshRecentIntents()])

    expect(mocked.participantInstances).toHaveLength(1)
    expect(mocked.coordinatorInstances).toHaveLength(1)
    expect(mocked.mockCoordinatorStartRound).toHaveBeenCalledTimes(1)
  })

  it('prepares the participant even when local top-3 excludes the active intent', async () => {
    const adapter = new UiWorkflowAdapter()
    const now = Math.floor(Date.now() / 1000)

    await adapter.connect({
      network: 'devnet',
      ckbRpcUrl: 'http://127.0.0.1:28114',
      nostrRelayUrl: 'ws://127.0.0.1:8080',
      mixAmountShannons: '100000000000',
      minParticipants: 3,
    })

    await adapter.prepareSession({
      privateKey: '0xabc',
      receiverAddress: 'ckt1qreceiver',
    })

    mocked.mockListIntents.mockResolvedValue([
      {
        id: 'intent-self',
        pubkey: 'self-pubkey',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now,
      },
    ])

    await adapter.publishIntent({
      amount: 100_000_000_000n,
      minParticipants: 3,
      minReputation: 0,
      receiverAddress: 'ckt1qreceiver',
    })

    mocked.mockListIntents.mockResolvedValue([
      {
        id: 'intent-a',
        pubkey: 'peer-a',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now + 3,
      },
      {
        id: 'intent-b',
        pubkey: 'peer-b',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now + 2,
      },
      {
        id: 'intent-c',
        pubkey: 'peer-c',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now + 1,
      },
      {
        id: 'intent-self',
        pubkey: 'self-pubkey',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now,
      },
    ])

    await adapter.refreshRecentIntents()

    expect(mocked.participantInstances).toHaveLength(1)
    expect(mocked.coordinatorInstances).toHaveLength(0)
    expect(mocked.mockCoordinatorStartRound).not.toHaveBeenCalled()
  })

  it('ignores stale compatible intents when selecting a round cohort', async () => {
    const adapter = new UiWorkflowAdapter()
    const now = Math.floor(Date.now() / 1000)

    await adapter.connect({
      network: 'devnet',
      ckbRpcUrl: 'http://127.0.0.1:28114',
      nostrRelayUrl: 'ws://127.0.0.1:8080',
      mixAmountShannons: '100000000000',
      minParticipants: 3,
    })

    await adapter.prepareSession({
      privateKey: '0xabc',
      receiverAddress: 'ckt1qreceiver',
    })

    mocked.mockListIntents.mockResolvedValue([
      {
        id: 'intent-self',
        pubkey: 'self-pubkey',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now,
      },
    ])

    await adapter.publishIntent({
      amount: 100_000_000_000n,
      minParticipants: 3,
      minReputation: 0,
      receiverAddress: 'ckt1qreceiver',
    })

    mocked.mockListIntents.mockResolvedValue([
      {
        id: 'intent-self',
        pubkey: 'self-pubkey',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now,
      },
      {
        id: 'intent-live-a',
        pubkey: 'peer-a',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now - 1,
      },
      {
        id: 'intent-live-b',
        pubkey: 'peer-b',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now - 2,
      },
      {
        id: 'intent-stale',
        pubkey: 'peer-stale',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now - 120,
      },
    ])

    await adapter.refreshRecentIntents()

    expect(mocked.mockCoordinatorStartRound).toHaveBeenCalledTimes(1)
    expect(mocked.mockCoordinatorStartRound).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'intent-self' }),
      expect.objectContaining({ id: 'intent-live-a' }),
      expect.objectContaining({ id: 'intent-live-b' }),
    ])
  })

  it('prepares the participant immediately from an incoming coordination message', async () => {
    const adapter = new UiWorkflowAdapter()
    const now = Math.floor(Date.now() / 1000)

    await adapter.connect({
      network: 'devnet',
      ckbRpcUrl: 'http://127.0.0.1:28114',
      nostrRelayUrl: 'ws://127.0.0.1:8080',
      mixAmountShannons: '100000000000',
      minParticipants: 3,
    })

    await adapter.prepareSession({
      privateKey: '0xabc',
      receiverAddress: 'ckt1qreceiver',
    })

    mocked.mockListIntents.mockResolvedValue([
      {
        id: 'intent-self',
        pubkey: 'self-pubkey',
        amount: 100_000_000_000n,
        minParticipants: 3,
        minReputation: 0,
        createdAt: now,
      },
    ])

    await adapter.publishIntent({
      amount: 100_000_000_000n,
      minParticipants: 3,
      minReputation: 0,
      receiverAddress: 'ckt1qreceiver',
    })

    mocked.privateMessageHandler?.(
      {
        type: 'coordination_proposal',
        matched_intents: ['intent-self', 'intent-b', 'intent-c'],
        coordinator_pubkey: 'peer-coordinator',
      },
      'peer-coordinator',
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mocked.participantInstances).toHaveLength(1)
    expect(
      (mocked.participantInstances[0] as { handleMessage: ReturnType<typeof vi.fn> }).handleMessage,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'coordination_proposal',
      }),
    )
  })
})
