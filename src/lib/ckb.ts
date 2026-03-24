import { ccc } from '@ckb-ccc/core'

import { Config } from './config'

const TX_TIMEOUT_MS = Number(readEnv('CKB_SMOKE_TX_TIMEOUT_MS') ?? '120000')
const FEE_ESTIMATION_SAFETY_MARGIN = 1_000n
const DEFAULT_CELL_FILTER = {
  scriptLenRange: [0, 1] as [number, number],
  outputDataLenRange: [0, 1] as [number, number],
}

function readEnv(name: string): string | undefined {
  const nodeEnv =
    typeof process !== 'undefined' && typeof process.env === 'object' ? process.env : undefined
  const viteEnv = typeof import.meta !== 'undefined' ? import.meta.env : undefined
  return nodeEnv?.[name] ?? viteEnv?.[`VITE_${name}`]
}

export type CoinjoinParticipant = {
  mixLock: ccc.ScriptLike
  changeLock: ccc.ScriptLike
  cells: ccc.Cell[]
  inputCapacity: bigint
}

export type AssembleCoinjoinTxParams = {
  participants: CoinjoinParticipant[]
  mixAmount: bigint
  feeRatePerKb: bigint
}

export type SignedWitnessEntry = {
  index: number
  witness: string
}

export type CoinjoinOutput = {
  capacity: bigint
  lockHash: string
}

export type TransactionInputSummary = {
  outPoint: string
  address?: string
  lockHash: string
  capacity: bigint
}

export type TransactionOutputSummary = {
  address?: string
  lockHash: string
  capacity: bigint
}

export type ConfirmedTransactionSummary = {
  txHash: string
  inputs: TransactionInputSummary[]
  outputs: TransactionOutputSummary[]
  totalInputCapacity: bigint
  totalOutputCapacity: bigint
  fee: bigint
}

export type CoinjoinTxResult = {
  unsignedTx: ccc.Transaction
  mixOutputs: CoinjoinOutput[]
  changeOutputs: CoinjoinOutput[]
  inputsByParticipant: Map<number, number[]>
  totalInputCapacity: bigint
  totalOutputCapacity: bigint
}

export class CkbService {
  client: ccc.ClientPublicTestnet

  constructor(client: ccc.ClientPublicTestnet) {
    this.client = client
  }

  async createParticipant(
    privateKey: string,
    targetCapacity: bigint,
  ): Promise<CoinjoinParticipant> {
    const signer = new ccc.SignerCkbPrivateKey(this.client, privateKey)
    const address = await signer.getRecommendedAddressObj()
    const cells: ccc.Cell[] = []
    let inputCapacity = 0n

    for await (const cell of this.client.findCells(
      {
        script: address.script,
        scriptType: 'lock',
        scriptSearchMode: 'exact',
        filter: DEFAULT_CELL_FILTER,
        withData: false,
      },
      'asc',
    )) {
      cells.push(cell)
      inputCapacity += BigInt(cell.cellOutput.capacity)

      if (inputCapacity >= targetCapacity) {
        break
      }
    }

    if (inputCapacity < targetCapacity) {
      throw new Error(
        `Insufficient participant capacity: need ${targetCapacity}, collected ${inputCapacity}`,
      )
    }

    return {
      mixLock: address.script,
      changeLock: address.script,
      cells,
      inputCapacity,
    }
  }

  async assembleCoinjoinTx({
    participants,
    mixAmount,
    feeRatePerKb,
  }: AssembleCoinjoinTxParams): Promise<CoinjoinTxResult> {
    const minTargetCapacity = mixAmount + feeRatePerKb + FEE_ESTIMATION_SAFETY_MARGIN
    for (const participant of participants) {
      if (participant.inputCapacity < minTargetCapacity) {
        throw new Error(
          `Participant input capacity ${participant.inputCapacity} is below required minimum ${minTargetCapacity}`,
        )
      }
    }

    const candidate = await this.#buildCoinjoinCandidate(participants, mixAmount, feeRatePerKb)
    return candidate.result
  }

  async signInputs(
    tx: ccc.Transaction,
    privateKey: string,
    inputIndices: number[],
  ): Promise<SignedWitnessEntry[]> {
    const signer = new ccc.SignerCkbPrivateKey(this.client, privateKey)
    const signedTx = await signer.signOnlyTransaction(tx.clone())

    return inputIndices.map((index) => ({
      index,
      witness: signedTx.witnesses[index] ?? '0x',
    }))
  }

  mergeWitnesses(tx: ccc.Transaction, witnessGroups: SignedWitnessEntry[][]): ccc.Transaction {
    const merged = tx.clone()

    for (const group of witnessGroups) {
      for (const { index, witness } of group) {
        merged.setWitnessAt(index, witness)
      }
    }

    return merged
  }

  async broadcast(tx: ccc.Transaction): Promise<string> {
    const txHash = await this.client.sendTransaction(tx).catch((err) => {
      console.log(err)
      throw err
    })
    await this.#waitForTransactionVisibility(txHash, Math.min(TX_TIMEOUT_MS, 5_000)).catch(
      () => undefined,
    )
    return txHash
  }

  async getTransaction(txHash: string): Promise<ConfirmedTransactionSummary | undefined> {
    const response = await this.client.getTransaction(txHash)
    if (!response) return undefined

    const outputs = await Promise.all(
      response.transaction.outputs.map(async (output) => ({
        capacity: BigInt(output.capacity),
        lockHash: ccc.hashCkb(output.lock.toBytes()),
        address: ccc.Address.fromScript(output.lock, this.client).toString(),
      })),
    )

    const inputs: TransactionInputSummary[] = await Promise.all(
      response.transaction.inputs.map(async (input) => {
        const previous = await this.client.getTransaction(input.previousOutput.txHash)
        const outputIndex = Number(input.previousOutput.index)
        const referencedOutput = previous?.transaction.outputs[outputIndex]

        if (!referencedOutput) {
          return {
            outPoint: `${input.previousOutput.txHash}:${input.previousOutput.index.toString()}`,
            lockHash: 'unresolved',
            capacity: 0n,
          }
        }

        return {
          outPoint: `${input.previousOutput.txHash}:${input.previousOutput.index.toString()}`,
          address: ccc.Address.fromScript(referencedOutput.lock, this.client).toString(),
          lockHash: ccc.hashCkb(referencedOutput.lock.toBytes()),
          capacity: BigInt(referencedOutput.capacity),
        }
      }),
    )

    const totalInputCapacity = inputs.reduce((sum, input) => sum + input.capacity, 0n)
    const totalOutputCapacity = outputs.reduce((sum, output) => sum + output.capacity, 0n)

    return {
      txHash,
      inputs,
      outputs,
      totalInputCapacity,
      totalOutputCapacity,
      fee: totalInputCapacity - totalOutputCapacity,
    }
  }

  async #buildCoinjoinCandidate(
    participants: CoinjoinParticipant[],
    mixAmount: bigint,
    feeRatePerKb: bigint,
  ): Promise<{ result: CoinjoinTxResult; feeShares: bigint[] }> {
    let fee = 0n
    let previousSignature = ''

    for (let iteration = 0; iteration < 8; iteration += 1) {
      const feeShares = splitFeeEvenly(fee, participants.length)
      const tx = ccc.Transaction.from({ outputs: [], outputsData: [] })
      const inputsByParticipant = new Map<number, number[]>()
      let totalInputCapacity = 0n

      for (const participant of participants) {
        tx.addOutput({
          lock: participant.mixLock,
          capacity: mixAmount,
        })
      }

      const mixOutputs = tx.outputs.map((output) => ({
        capacity: BigInt(output.capacity),
        lockHash: ccc.hashCkb(output.lock.toBytes()),
      }))

      for (
        let participantIndex = 0;
        participantIndex < participants.length;
        participantIndex += 1
      ) {
        const participant = participants[participantIndex]
        const startingInputIndex = tx.inputs.length

        for (const cell of participant.cells) {
          tx.addInput(cell)
          totalInputCapacity += BigInt(cell.cellOutput.capacity)
        }

        const inputIndices = Array.from(
          { length: tx.inputs.length - startingInputIndex },
          (_, offset) => startingInputIndex + offset,
        )
        inputsByParticipant.set(participantIndex, inputIndices)

        const changeCapacity = participant.inputCapacity - mixAmount - feeShares[participantIndex]
        if (changeCapacity >= Config.minCellCapacityCkb) {
          tx.addOutput({
            lock: participant.changeLock,
            capacity: changeCapacity,
          })
        }
      }

      while (tx.outputsData.length < tx.outputs.length) {
        tx.outputsData.push('0x')
      }

      const preparedTx = await this.#prepareForSigning(tx)
      const nextFee = BigInt(preparedTx.estimateFee(feeRatePerKb)) + FEE_ESTIMATION_SAFETY_MARGIN
      const signature = [
        nextFee.toString(),
        ...preparedTx.outputs.map((output) => output.capacity.toString()),
      ].join(':')

      if (signature === previousSignature) {
        const outputs = [...preparedTx.outputCells]
        const changeOutputs = outputs.slice(mixOutputs.length).map((cell) => ({
          capacity: BigInt(cell.cellOutput.capacity),
          lockHash: ccc.hashCkb(cell.cellOutput.lock.toBytes()),
        }))

        return {
          feeShares,
          result: {
            unsignedTx: preparedTx,
            mixOutputs,
            changeOutputs,
            inputsByParticipant,
            totalInputCapacity,
            totalOutputCapacity: BigInt(preparedTx.getOutputsCapacity()),
          },
        }
      }

      fee = nextFee
      previousSignature = signature
    }

    throw new Error('Unable to converge CoinJoin fee estimation')
  }

  async #prepareForSigning(tx: ccc.Transaction): Promise<ccc.Transaction> {
    const prepared = tx.clone()
    const secp256k1 = await this.client.getKnownScript(ccc.KnownScript.Secp256k1Blake160)
    const anyoneCanPay = await this.client.getKnownScript(ccc.KnownScript.AnyoneCanPay)
    const handledLocks = new Set<string>()

    for (const input of prepared.inputs) {
      const {
        cellOutput: { lock },
      } = await input.getCell(this.client)
      const lockKey = `${lock.codeHash}:${lock.hashType}:${lock.args}`
      if (handledLocks.has(lockKey)) continue

      handledLocks.add(lockKey)

      if (lock.codeHash === secp256k1.codeHash && lock.hashType === secp256k1.hashType) {
        await prepared.prepareSighashAllWitness(lock, 65, this.client)
        await prepared.addCellDepInfos(this.client, secp256k1.cellDeps)
        continue
      }

      if (
        lock.codeHash === anyoneCanPay.codeHash &&
        lock.hashType === anyoneCanPay.hashType &&
        lock.args.startsWith('0x')
      ) {
        await prepared.prepareSighashAllWitness(lock, 65, this.client)
        await prepared.addCellDepInfos(this.client, anyoneCanPay.cellDeps)
      }
    }

    for (let index = 0; index < prepared.inputs.length; index += 1) {
      prepared.setWitnessAt(index, prepared.witnesses[index] ?? '0x')
    }

    return prepared
  }

  async #waitForTransactionVisibility(txHash: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      const transaction = await this.client.getTransaction(txHash)
      if (transaction?.transaction) {
        return
      }

      await delay(1_000)
    }

    throw new Error(`Timed out waiting for transaction visibility: ${txHash}`)
  }
}

function splitFeeEvenly(totalFee: bigint, participants: number): bigint[] {
  const baseShare = totalFee / BigInt(participants)
  const remainder = totalFee % BigInt(participants)

  return Array.from(
    { length: participants },
    (_, index) => baseShare + (index < Number(remainder) ? 1n : 0n),
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
