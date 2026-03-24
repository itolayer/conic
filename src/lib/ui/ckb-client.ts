import { ccc } from '@ckb-ccc/core'

import type { ActiveUiConfig } from './types'
import { fetchDevnetScripts } from './devnet-config'

export type UiCkbClient = ccc.ClientPublicTestnet

export async function createCkbClient(config: ActiveUiConfig): Promise<UiCkbClient> {
  switch (config.network) {
    case 'devnet':
      return new ccc.ClientPublicTestnet({
        url: config.ckbRpcUrl,
        scripts: await fetchDevnetScripts(),
      })
    case 'testnet':
      return new ccc.ClientPublicTestnet({ url: config.ckbRpcUrl })
  }
}
