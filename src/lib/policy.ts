const nodeEnv =
  typeof process !== 'undefined' && typeof process.env === 'object' ? process.env : undefined

const viteEnv = typeof import.meta !== 'undefined' ? import.meta.env : undefined

const UNSUPPORTED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(atomic swap|swap|htlc)\b/i,
    reason: 'This demo only executes CoinJoin privacy policies, not atomic swaps.',
  },
  {
    pattern: /\b(fiber|perun|payment channel|channel)\b/i,
    reason: 'Payment channel routing is out of scope for this hackathon build.',
  },
  {
    pattern: /\b(reputation|dao|nervos dao|staking|sybil)\b/i,
    reason: 'Reputation gating is intentionally out of scope for this 6-hour version.',
  },
  {
    pattern: /\b(otc|token buy|token sell|buy token|sell token)\b/i,
    reason: 'The policy agent only supports CoinJoin intents right now.',
  },
]

export type PrivacyPolicy = {
  intentType: 'coinjoin'
  mixAmountShannons: string
  minParticipants: number
}

export type PolicyInterpretation = {
  rawPrompt: string
  supported: boolean
  policy?: PrivacyPolicy
  summary: string
  explanation: string
  warnings: string[]
}

export type AutopilotStatus = {
  armed: boolean
  phase:
    | 'idle'
    | 'armed_waiting_session'
    | 'awaiting_receiver'
    | 'publishing'
    | 'waiting_for_peers'
    | 'round_active'
    | 'retry_scheduled'
    | 'completed'
    | 'error'
  lastAction: string
  retryAt?: number
}

type RawPolicyResponse = {
  intentType?: unknown
  mixAmountCkb?: unknown
  minParticipants?: unknown
  summary?: unknown
  explanation?: unknown
  warnings?: unknown
  supported?: unknown
}

function readEnv(name: string): string | undefined {
  return nodeEnv?.[name] ?? viteEnv?.[`VITE_${name}`]
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
}

function normalizeIntentType(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
}

function normalizeMixAmountCkb(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value.toString()
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim().replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return undefined
  }

  return normalized
}

function normalizeMinParticipants(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 2) {
    return Math.floor(value)
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed >= 2) {
      return parsed
    }
  }

  return 3
}

function ckbToShannons(value: string): string {
  const [wholePart = '0', fractionPart = ''] = value.split('.')
  const safeFraction = fractionPart.slice(0, 8).padEnd(8, '0')

  return (BigInt(wholePart || '0') * 100_000_000n + BigInt(safeFraction || '0')).toString()
}

function detectUnsupportedPrompt(prompt: string): string | undefined {
  for (const entry of UNSUPPORTED_PATTERNS) {
    if (entry.pattern.test(prompt)) {
      return entry.reason
    }
  }

  return undefined
}

function parseJsonContent(content: string): RawPolicyResponse {
  try {
    return JSON.parse(content) as RawPolicyResponse
  } catch (error) {
    throw new Error(
      `Policy AI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function normalizePolicyResponse(
  rawPrompt: string,
  response: RawPolicyResponse,
): PolicyInterpretation {
  const prompt = rawPrompt.trim()
  const warnings = normalizeWarnings(response.warnings)
  const unsupportedReason = detectUnsupportedPrompt(prompt)
  const supported = response.supported !== false
  const normalizedIntentType = normalizeIntentType(response.intentType)

  if (unsupportedReason || !supported || normalizedIntentType !== 'coinjoin') {
    return {
      rawPrompt: prompt,
      supported: false,
      summary: normalizeString(response.summary, 'Unsupported privacy policy'),
      explanation: normalizeString(
        response.explanation,
        unsupportedReason ?? 'Only CoinJoin privacy policies are supported in this demo.',
      ),
      warnings: dedupeWarnings([
        ...warnings,
        unsupportedReason ?? 'Try phrasing the request as a CoinJoin privacy goal on CKB.',
      ]),
    }
  }

  const mixAmountCkb = normalizeMixAmountCkb(response.mixAmountCkb)
  if (!mixAmountCkb) {
    return {
      rawPrompt: prompt,
      supported: false,
      summary: normalizeString(response.summary, 'Missing CoinJoin amount'),
      explanation: normalizeString(
        response.explanation,
        'The policy needs a concrete CoinJoin amount before it can be executed.',
      ),
      warnings: dedupeWarnings([
        ...warnings,
        'Include an amount like "mix 1000 CKB" so the policy can be normalized.',
      ]),
    }
  }

  const minParticipants = normalizeMinParticipants(response.minParticipants)
  const mixAmountShannons = ckbToShannons(mixAmountCkb)

  return {
    rawPrompt: prompt,
    supported: true,
    policy: {
      intentType: 'coinjoin',
      mixAmountShannons,
      minParticipants,
    },
    summary: normalizeString(
      response.summary,
      `CoinJoin ${mixAmountCkb} CKB with at least ${minParticipants} participants.`,
    ),
    explanation: normalizeString(
      response.explanation,
      'The AI parsed your privacy goal into a deterministic CoinJoin policy.',
    ),
    warnings: dedupeWarnings(warnings),
  }
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))]
}

export class PolicyService {
  readonly #url = readEnv('POLICY_LLM_URL')
  readonly #model = readEnv('POLICY_LLM_MODEL')
  readonly #apiKey = readEnv('POLICY_LLM_API_KEY')

  async interpret(rawPrompt: string): Promise<PolicyInterpretation> {
    const prompt = rawPrompt.trim()
    if (prompt.length === 0) {
      throw new Error('Describe the privacy goal before asking the policy agent to interpret it.')
    }

    if (!this.#url || !this.#model || !this.#apiKey) {
      throw new Error(
        'Policy AI is not configured. Set POLICY_LLM_URL, POLICY_LLM_MODEL, and POLICY_LLM_API_KEY.',
      )
    }

    const response = await fetch(this.#url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.#model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You translate user privacy goals into a constrained JSON policy for a CKB CoinJoin demo.',
              'Only support CoinJoin.',
              'Never include private keys, receiver addresses, relay URLs, RPC URLs, or wallet management.',
              'If the user asks for unsupported behavior, set supported=false and explain why.',
              'Return JSON only with keys: intentType, mixAmountCkb, minParticipants, summary, explanation, warnings, supported.',
            ].join(' '),
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    })

    if (!response.ok) {
      throw new Error(`Policy AI request failed: ${response.status} ${response.statusText}`)
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const content = payload.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('Policy AI returned an empty response.')
    }

    return normalizePolicyResponse(prompt, parseJsonContent(content))
  }
}
