import { ccc } from '@ckb-ccc/core'

export type DevnetConfigResponse = {
  scripts: Record<string, unknown>
}

export async function fetchDevnetScripts(): Promise<
  Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined> | undefined
> {
  const response = await fetch('/api/devnet-config')
  if (!response.ok) {
    throw new Error(`Unable to load devnet config: ${response.status}`)
  }

  const payload = (await response.json()) as DevnetConfigResponse
  const scripts = payload.scripts as Record<string, ccc.ScriptInfoLike | undefined>

  if (!scripts[ccc.KnownScript.NervosDao]) {
    scripts[ccc.KnownScript.NervosDao] = {
      codeHash: '0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e',
      hashType: 'type',
      cellDeps: [],
    }
  }

  return scripts as Record<ccc.KnownScript, ccc.ScriptInfoLike | undefined>
}
