import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRightLeft,
  Cable,
  ClipboardCopy,
  Coins,
  Info,
  KeyRound,
  LogOut,
  RadioTower,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from 'lucide-react'

import './App.css'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'
import { Toast, ToastProvider, ToastViewport, type ToastMessage } from './components/ui/toast'
import { useConicStore } from './lib/ui/store'
import type { IntentType, EventLogEntry } from './lib/ui/types'

const SHANNONS_PER_CKB = 100_000_000n

const INTENT_OPTIONS: Array<{
  id: IntentType
  label: string
  description: string
  enabled: boolean
  icon: typeof Coins
}> = [
  {
    id: 'coinjoin',
    label: 'CoinJoin',
    description: 'Live now',
    enabled: true,
    icon: Coins,
  },
  {
    id: 'atomic-swap',
    label: 'P2P Atomic Swap',
    description: 'Coming soon',
    enabled: false,
    icon: ArrowRightLeft,
  },
  {
    id: 'token-buy',
    label: 'Token Buy',
    description: 'Coming soon',
    enabled: false,
    icon: Sparkles,
  },
  {
    id: 'token-sell',
    label: 'Token Sell',
    description: 'Coming soon',
    enabled: false,
    icon: Wallet,
  },
  {
    id: 'otc',
    label: 'OTC Intent',
    description: 'Coming soon',
    enabled: false,
    icon: ShieldCheck,
  },
]

function App() {
  const state = useConicStore()
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false)
  const [isWalletPopoverOpen, setIsWalletPopoverOpen] = useState(false)
  const walletPopoverRef = useRef<HTMLDivElement | null>(null)

  const compatibleIntents = useMemo(
    () => state.intents.filter((intent) => intent.isCompatible),
    [state.intents],
  )
  const activityTranscript = useMemo(() => formatActivityLog(state.eventLog), [state.eventLog])
  const sessionReady =
    state.connection.status === 'connected' && Boolean(state.ckbAddress) && Boolean(state.balance)
  const roundTerminal =
    state.round.participantPhase === 'FAILED' ||
    state.round.participantPhase === 'COMPLETE' ||
    state.round.coordinatorPhase === 'FAILED' ||
    state.round.coordinatorPhase === 'COMPLETE'
  const publishLocked = Boolean(state.activeIntentId) && !roundTerminal
  const publishDisabled =
    state.connection.status !== 'connected' ||
    !sessionReady ||
    state.isPublishingIntent ||
    state.selectedIntentType !== 'coinjoin' ||
    publishLocked
  const showRoundMonitor = Boolean(
    state.activeIntentId ||
    state.round.coordinationId ||
    state.round.txHash ||
    state.round.failureReason ||
    state.round.completedTxSummary,
  )
  const showPublishCard = !state.activeIntentId
  const walletLabel =
    state.connection.status === 'connected'
      ? formatIdentifier(state.ckbAddress ?? 'Connected', 6, 6)
      : 'Connect'

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (
        isWalletPopoverOpen &&
        walletPopoverRef.current &&
        !walletPopoverRef.current.contains(event.target as Node)
      ) {
        setIsWalletPopoverOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsConnectModalOpen(false)
        setIsWalletPopoverOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isWalletPopoverOpen])

  const handleAction = async (action: () => Promise<void>, success?: Omit<ToastMessage, 'id'>) => {
    try {
      await action()
      if (success) {
        setToast({ id: crypto.randomUUID(), ...success })
      }
    } catch (error) {
      setToast({
        id: crypto.randomUUID(),
        tone: 'error',
        title: 'Something needs attention',
        description: humanizeError(error),
      })
    }
  }

  const publishHint = getPublishHint({
    connectionStatus: state.connection.status,
    sessionReady,
    selectedIntentType: state.selectedIntentType,
    publishLocked,
  })

  const handleWalletButtonClick = () => {
    if (state.connection.status !== 'connected') {
      setIsConnectModalOpen(true)
      return
    }

    setIsWalletPopoverOpen((current) => !current)
  }

  const handleMixAmountChange = (nextValue: string) => {
    if (!/^\d*(\.\d{0,8})?$/.test(nextValue)) return

    state.updateMixAmount(ckbInputToShannons(nextValue))
  }

  const copyText = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value)
    setToast({
      id: crypto.randomUUID(),
      tone: 'success',
      title: `${label} copied`,
      description: `${label} is now on your clipboard.`,
    })
  }

  return (
    <ToastProvider>
      <header className="topbar">
        <div className="topbar-shell">
          <div className="topbar-brand">
            <h1>CONIC</h1>
            <span>CKB Over Nostr Intent Coordination</span>
          </div>

          <div className="topbar-actions">
            <Badge variant="accent">{state.network}</Badge>

            <div className="wallet-anchor" ref={walletPopoverRef}>
              <Button className="wallet-button" onClick={handleWalletButtonClick}>
                <Wallet size={16} />
                {walletLabel}
              </Button>

              {isWalletPopoverOpen ? (
                <div className="wallet-popover">
                  <div className="wallet-popover-header">
                    <div>
                      <strong>{formatIdentifier(state.ckbAddress, 8, 8)}</strong>
                      <p>Connected session</p>
                    </div>
                    <Badge variant="success">Online</Badge>
                  </div>

                  <WalletLine
                    label="CKB Balance"
                    value={formatShannonTextAsCkb(state.balance?.display) ?? 'Unknown'}
                  />
                  <WalletLine
                    label="CKB Address"
                    value={state.ckbAddress ?? 'Unavailable'}
                    onCopy={
                      state.ckbAddress
                        ? () => void copyText(state.ckbAddress!, 'CKB address')
                        : undefined
                    }
                  />
                  <WalletLine
                    label="Nostr Pubkey"
                    value={state.connection.nostrPublicKey ?? 'Unavailable'}
                    onCopy={
                      state.connection.nostrPublicKey
                        ? () => void copyText(state.connection.nostrPublicKey!, 'Nostr pubkey')
                        : undefined
                    }
                  />

                  <div className="wallet-popover-actions">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setIsWalletPopoverOpen(false)
                        setIsConnectModalOpen(true)
                      }}
                    >
                      <Cable size={16} />
                      Manage session
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        handleAction(
                          async () => {
                            setIsWalletPopoverOpen(false)
                            await state.disconnect()
                          },
                          {
                            tone: 'info',
                            title: 'Session disconnected',
                            description: 'The relay and RPC session for this tab has been closed.',
                          },
                        )
                      }
                    >
                      <LogOut size={16} />
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <div
        className={`workspace-shell${state.isConsoleOpen ? ' workspace-shell-console-open' : ''}`}
      >
        <main className="content-stack">
          <Card className="panel panel-recent">
            <CardHeader>
              <CardTitle>Recent Intents</CardTitle>
              <CardDescription>
                A live view of recent compatible publishers on the connected relay. CoinJoin is
                active today, while the other intent types remain visible as roadmap signals.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {state.intents.length === 0 ? (
                <p className="empty-state">
                  No recent intents have appeared in the last 10 minutes.
                </p>
              ) : (
                <ul className="intent-list">
                  {state.intents.map((intent) => (
                    <li
                      key={intent.id}
                      className={`intent-item${intent.isMine ? ' intent-item-mine' : ''}${
                        intent.isCompatible ? ' intent-item-compatible' : ''
                      }`}
                    >
                      <div className="intent-item-main">
                        <div className="intent-item-head">
                          <strong title={intent.pubkey}>{formatIdentifier(intent.pubkey)}</strong>
                          <div className="intent-item-badges">
                            <Badge variant="accent">CoinJoin</Badge>
                            {intent.isMine ? <Badge variant="success">Mine</Badge> : null}
                            {intent.isCompatible ? (
                              <Badge variant="success">Compatible</Badge>
                            ) : null}
                          </div>
                        </div>
                        <p>{intent.createdAtLabel}</p>
                      </div>
                      <Metric label="Mix" value={formatShannonsAsCkb(intent.amountShannons)} />
                      <Metric label="Peers" value={String(intent.minParticipants)} />
                      <Metric
                        label="Intent ID"
                        value={formatIdentifier(intent.id)}
                        title={intent.id}
                      />
                    </li>
                  ))}
                </ul>
              )}

              <div className="summary-strip summary-strip-compact">
                <Metric label="Compatible Intents" value={String(compatibleIntents.length)} />
                <Metric
                  label="Current Active ID"
                  value={formatIdentifier(state.activeIntentId)}
                  title={state.activeIntentId}
                />
              </div>
            </CardContent>
          </Card>

          {showPublishCard ? (
            <Card className="panel panel-intent">
              <CardHeader>
                <CardTitle>Publish Intent</CardTitle>
                <CardDescription>
                  Create one active CoinJoin intent at a time. Other intent categories are visible
                  here to establish CONIC as a broader decentralized intention layer.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="intent-type-grid" role="list" aria-label="Intent types">
                  {INTENT_OPTIONS.map((option) => {
                    const Icon = option.icon
                    const selected = state.selectedIntentType === option.id

                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={`intent-type-card${selected ? ' intent-type-card-selected' : ''}`}
                        disabled={!option.enabled}
                        aria-pressed={selected}
                        onClick={() => state.setSelectedIntentType(option.id)}
                      >
                        <Icon size={18} />
                        <strong>{option.label}</strong>
                        <span>{option.description}</span>
                      </button>
                    )
                  })}
                </div>

                <div className="intent-lock-banner">
                  <Badge
                    variant={
                      publishLocked ? 'warning' : state.activeIntentId ? 'success' : 'neutral'
                    }
                  >
                    {publishLocked
                      ? 'One active intent in progress'
                      : state.activeIntentId
                        ? 'Intent finished'
                        : 'Ready to publish'}
                  </Badge>
                  <p>{publishHint}</p>
                </div>

                <div className="field-grid">
                  <label className="field">
                    <span>Mix Amount (CKB)</span>
                    <Input
                      inputMode="decimal"
                      placeholder="100"
                      value={shannonsToCkbInput(state.mixAmountShannons)}
                      onChange={(event) => handleMixAmountChange(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Min Participants</span>
                    <Input
                      inputMode="numeric"
                      min={2}
                      step={1}
                      value={String(state.minParticipants)}
                      onChange={(event) =>
                        state.updateMinParticipants(Number(event.target.value) || 0)
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Min Reputation</span>
                    <div className="readonly-field">
                      <strong>0</strong>
                      <button
                        type="button"
                        className="tooltip-trigger"
                        aria-label="Reputation formula"
                      >
                        <Info size={14} />
                        <span className="tooltip-bubble" role="tooltip">
                          Reputation uses the formula <code>dao_deposit_amount ^ 2 * time</code>.
                          This demo keeps the threshold at 0 so publishing stays frictionless.
                        </span>
                      </button>
                    </div>
                  </label>
                  <label className="field field-span-2">
                    <span>Receiver Address</span>
                    <Input
                      placeholder="ckt1..."
                      value={state.receiverAddress}
                      onChange={(event) => state.updateReceiverAddress(event.target.value.trim())}
                    />
                  </label>
                </div>

                <div className="button-row">
                  <Button
                    disabled={publishDisabled}
                    onClick={() =>
                      handleAction(state.publishIntent, {
                        tone: 'success',
                        title: 'Intent published',
                        description:
                          'Your CoinJoin intent is now live and ready to match with compatible peers.',
                      })
                    }
                  >
                    Publish Intent
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={state.connection.status !== 'connected' || state.isRefreshingIntents}
                    onClick={() =>
                      handleAction(state.refreshIntents, {
                        tone: 'info',
                        title: 'Recent intents refreshed',
                        description: 'The latest compatible activity window has been reloaded.',
                      })
                    }
                  >
                    <RefreshCcw size={16} />
                    Refresh Recent
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {showRoundMonitor ? (
            <Card className="panel panel-round">
              <CardHeader>
                <CardTitle>Round Monitor</CardTitle>
                <CardDescription>
                  Coordination details stay hidden until they matter, then expand into a focused
                  monitoring panel for the current or most recent round.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="summary-strip">
                  <Metric label="Role" value={state.round.role} />
                  <Metric label="Participant Phase" value={state.round.participantPhase} />
                  <Metric label="Coordinator Phase" value={state.round.coordinatorPhase} />
                  <Metric
                    label="Coordination ID"
                    value={formatIdentifier(state.round.coordinationId)}
                    title={state.round.coordinationId}
                  />
                </div>

                <div className="summary-strip summary-strip-compact">
                  <Metric
                    label="Transaction"
                    value={state.round.txHash ? formatIdentifier(state.round.txHash) : 'Pending'}
                    title={state.round.txHash}
                  />
                  <Metric label="Failure" value={state.round.failureReason ?? 'None'} />
                </div>

                {state.activeIntentId ? (
                  <div className="button-row">
                    <Button
                      variant="ghost"
                      onClick={() =>
                        handleAction(state.deleteActiveIntent, {
                          tone: 'warning',
                          title: 'Intent removed',
                          description:
                            'The active intent for this tab has been withdrawn from the relay.',
                        })
                      }
                    >
                      <Trash2 size={16} />
                      Delete Intent
                    </Button>
                  </div>
                ) : null}

                {state.round.completedTxSummary ? (
                  <div className="tx-summary">
                    <div className="summary-strip summary-strip-compact">
                      <Metric
                        label="Total Inputs"
                        value={
                          formatShannonTextAsCkb(
                            state.round.completedTxSummary.totalInputCapacity,
                          ) ?? state.round.completedTxSummary.totalInputCapacity
                        }
                      />
                      <Metric
                        label="Total Outputs"
                        value={
                          formatShannonTextAsCkb(
                            state.round.completedTxSummary.totalOutputCapacity,
                          ) ?? state.round.completedTxSummary.totalOutputCapacity
                        }
                      />
                      <Metric
                        label="Fee"
                        value={
                          formatShannonTextAsCkb(state.round.completedTxSummary.fee) ??
                          state.round.completedTxSummary.fee
                        }
                      />
                    </div>

                    <div className="tx-grid">
                      <TransactionList
                        title="Inputs"
                        rows={state.round.completedTxSummary.inputs}
                      />
                      <TransactionList
                        title="Outputs"
                        rows={state.round.completedTxSummary.outputs}
                      />
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </main>
      </div>

      <section className={`console-dock${state.isConsoleOpen ? ' console-dock-open' : ''}`}>
        <div className="console-dock-header">
          <div>
            <strong>Debug Console</strong>
            <p>
              Detailed relay and coordination logs stay here so the main workflow reads like a dapp.
            </p>
          </div>
          <div className="button-row console-actions">
            <Button variant="ghost" onClick={() => state.setConsoleOpen(!state.isConsoleOpen)}>
              {state.isConsoleOpen ? <X size={16} /> : <RadioTower size={16} />}
              {state.isConsoleOpen ? 'Close console' : 'Open console'}
            </Button>
            <Button
              variant="secondary"
              disabled={!state.isConsoleOpen}
              onClick={() =>
                handleAction(
                  async () => {
                    await navigator.clipboard.writeText(activityTranscript)
                  },
                  {
                    tone: 'success',
                    title: 'Console copied',
                    description: 'The current activity log is ready to paste into notes or chat.',
                  },
                )
              }
            >
              <ClipboardCopy size={16} />
              Copy Trace
            </Button>
            <Button variant="ghost" disabled={!state.isConsoleOpen} onClick={state.clearEventLog}>
              Clear
            </Button>
          </div>
        </div>
        {state.isConsoleOpen ? (
          <textarea className="activity-console" readOnly value={activityTranscript} />
        ) : null}
      </section>

      {isConnectModalOpen ? (
        <div className="modal-backdrop" onClick={() => setIsConnectModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Connect Session</h2>
                <p>
                  Manage the relay, CKB RPC, and local signing session from one place, then return
                  to the main flow once the account is ready.
                </p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setIsConnectModalOpen(false)}
                aria-label="Close connection modal"
              >
                <X size={18} />
              </button>
            </div>

            <div className="field-grid">
              <label className="field">
                <span>Network</span>
                <select
                  className="ui-select"
                  value={state.network}
                  onChange={(event) => state.setNetwork(event.target.value as 'devnet' | 'testnet')}
                >
                  <option value="devnet">Devnet</option>
                  <option value="testnet">Testnet</option>
                </select>
              </label>
              <label className="field">
                <span>Session Status</span>
                <div className="readonly-field">
                  <strong>{toTitleCase(state.connection.status)}</strong>
                  <Badge variant={sessionReady ? 'success' : 'neutral'}>
                    {sessionReady ? 'Ready' : 'Setup'}
                  </Badge>
                </div>
              </label>
              <label className="field field-span-2">
                <span>CKB RPC URL</span>
                <Input
                  value={state.endpoints[state.network].ckbRpcUrl}
                  onChange={(event) => state.updateEndpoint('ckbRpcUrl', event.target.value)}
                />
              </label>
              <label className="field field-span-2">
                <span>Relay URL</span>
                <Input
                  value={state.endpoints[state.network].nostrRelayUrl}
                  onChange={(event) => state.updateEndpoint('nostrRelayUrl', event.target.value)}
                />
              </label>
              <label className="field field-span-2">
                <span>CKB secp256k1 Private Key</span>
                <Input
                  placeholder="0x..."
                  value={state.ckbPrivateKey}
                  onChange={(event) => state.updatePrivateKey(event.target.value.trim())}
                />
              </label>
            </div>

            <div className="button-row modal-actions">
              <Button
                onClick={() =>
                  handleAction(state.connect, {
                    tone: 'success',
                    title: 'Infrastructure connected',
                    description: 'Relay and RPC are reachable. Your demo session is online.',
                  })
                }
              >
                <Cable size={16} />
                {state.connection.status === 'connected' ? 'Reconnect' : 'Connect'}
              </Button>
              <Button
                variant="secondary"
                disabled={state.connection.status !== 'connected' || state.isPreparingSession}
                onClick={() =>
                  handleAction(
                    async () => {
                      await state.prepareSession()
                      setIsConnectModalOpen(false)
                    },
                    {
                      tone: 'success',
                      title: 'Session prepared',
                      description: 'Address and balance are ready. You can return to publishing.',
                    },
                  )
                }
              >
                <KeyRound size={16} />
                Refresh Session
              </Button>
              <Button
                variant="ghost"
                disabled={state.connection.status === 'idle'}
                onClick={() =>
                  handleAction(state.disconnect, {
                    tone: 'info',
                    title: 'Session disconnected',
                    description: 'The relay and RPC session for this tab has been closed.',
                  })
                }
              >
                Disconnect
              </Button>
            </div>

            <div className="summary-strip summary-strip-compact modal-summary">
              <Metric
                label="CKB Address"
                value={formatIdentifier(state.ckbAddress)}
                title={state.ckbAddress}
              />
              <Metric
                label="CKB Balance"
                value={formatShannonTextAsCkb(state.balance?.display) ?? 'Unknown'}
              />
              <Metric
                label="Nostr Pubkey"
                value={formatIdentifier(state.connection.nostrPublicKey) ?? 'None'}
                title={state.connection.nostrPublicKey}
              />
              <Metric label="Connection" value={toTitleCase(state.connection.status)} />
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <Toast
          key={toast.id}
          message={toast}
          open={true}
          onOpenChange={(open) => {
            if (!open) setToast(null)
          }}
        />
      ) : null}
      <ToastViewport />
    </ToastProvider>
  )
}

function WalletLine({
  label,
  value,
  onCopy,
}: {
  label: string
  value: string
  onCopy?: () => void
}) {
  return (
    <div className="wallet-line">
      <span className="label">{label}</span>
      <div className="wallet-line-row">
        <strong title={value}>{value}</strong>
        {onCopy ? (
          <button type="button" className="copy-chip" onClick={onCopy}>
            <ClipboardCopy size={14} />
            Copy
          </button>
        ) : null}
      </div>
    </div>
  )
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="metric-card" title={title}>
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function TransactionList({
  title,
  rows,
}: {
  title: string
  rows: Array<{
    address?: string
    lockHash: string
    capacity: string
    isCurrentUser: boolean
    outPoint?: string
  }>
}) {
  return (
    <div className="tx-list-panel">
      <h3>{title}</h3>
      <ul className="tx-list">
        {rows.map((row, index) => {
          const primary = row.address ?? row.lockHash
          const secondary = row.outPoint ?? row.lockHash

          return (
            <li
              key={`${title}-${index}-${row.lockHash}`}
              className={row.isCurrentUser ? 'tx-row tx-row-self' : 'tx-row'}
            >
              <div>
                <strong title={primary}>{formatIdentifier(primary)}</strong>
                <p title={secondary}>{formatIdentifier(secondary)}</p>
              </div>
              <div>
                <span className="label">Amount</span>
                <strong>{formatShannonTextAsCkb(row.capacity)}</strong>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function formatIdentifier(value?: string, start = 8, end = 8): string {
  if (!value) return 'None'
  if (value.length <= start + end + 1) return value
  return `${value.slice(0, start)}…${value.slice(-end)}`
}

function withThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function shannonsToCkbInput(value: string): string {
  if (!value) return ''

  try {
    const shannons = BigInt(value)
    return formatCkbFromShannons(shannons)
  } catch {
    return value
  }
}

function ckbInputToShannons(value: string): string {
  if (!value) return ''

  const [wholePart = '0', fractionPart = ''] = value.split('.')
  const safeFraction = fractionPart.slice(0, 8).padEnd(8, '0')

  return (BigInt(wholePart || '0') * SHANNONS_PER_CKB + BigInt(safeFraction || '0')).toString()
}

function formatCkbFromShannons(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB
  const fraction = (shannons % SHANNONS_PER_CKB).toString().padStart(8, '0').replace(/0+$/, '')

  return fraction
    ? `${withThousands(whole.toString())}.${fraction}`
    : withThousands(whole.toString())
}

function formatShannonsAsCkb(value?: string): string {
  if (!value) return '0 CKB'

  try {
    return `${formatCkbFromShannons(BigInt(value))} CKB`
  } catch {
    return value
  }
}

function formatShannonTextAsCkb(value?: string): string | undefined {
  if (!value) return undefined

  const lower = value.toLowerCase()
  const isLowerBound = lower.startsWith('> ')
  const numeric = lower
    .replace(/^>\s*/, '')
    .replace(/\s*shannons?$/, '')
    .trim()

  try {
    const formatted = `${formatCkbFromShannons(BigInt(numeric))} CKB`
    return isLowerBound ? `> ${formatted}` : formatted
  } catch {
    return value
  }
}

function toTitleCase(value: string): string {
  return value
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase())
}

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('private key')) {
    return 'Add a valid CKB private key before publishing an intent.'
  }
  if (message.includes('Receiver address is required')) {
    return 'Enter the receiver address that should receive the mixed output.'
  }
  if (message.includes('Nostr relay')) {
    return 'Connect the relay before publishing or refreshing intents.'
  }
  if (message.includes('CKB RPC')) {
    return 'Connect the CKB RPC before preparing the session.'
  }

  return message
}

function getPublishHint({
  connectionStatus,
  sessionReady,
  selectedIntentType,
  publishLocked,
}: {
  connectionStatus: string
  sessionReady: boolean
  selectedIntentType: string
  publishLocked: boolean
}): string {
  if (selectedIntentType !== 'coinjoin') {
    return 'Only CoinJoin is enabled for this demo today. The other intent types are roadmap previews.'
  }
  if (connectionStatus !== 'connected') {
    return 'Connect the relay and RPC from the navigation bar to unlock publishing.'
  }
  if (!sessionReady) {
    return 'Refresh the session after connecting so the address and balance are ready for publishing.'
  }
  if (publishLocked) {
    return 'This tab already has an active intent in progress. Wait until the round finishes or fails before publishing again.'
  }

  return 'This session is ready to publish a CoinJoin intent.'
}

function formatTimestamp(entry: EventLogEntry): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(entry.timestamp)
}

function formatActivityLog(entries: EventLogEntry[]): string {
  return entries
    .slice()
    .reverse()
    .map(
      (entry) =>
        `[${formatTimestamp(entry)}] [${entry.level.toUpperCase()}] ${entry.title}: ${entry.detail}`,
    )
    .join('\n')
}

export default App
