import { ChainAdapter, isChainAdapterOfType } from './api'
import { ChainTypes } from '@shapeshiftoss/types'
import { EthereumChainAdapter } from './ethereum'
import { BitcoinChainAdapter } from './bitcoin'
import { BitcoinAPI, EthereumAPI } from '@shapeshiftoss/unchained-client'

export type UnchainedUrls = Record<ChainTypes, string>

export type UnchainedProviders = {
  [ChainTypes.Bitcoin]: BitcoinAPI.V1Api
  [ChainTypes.Ethereum]: EthereumAPI.V1Api
}

function constructUnchainedProvider(
  type: ChainTypes,
  baseURL: string
): UnchainedProviders[ChainTypes] {
  switch (type) {
    case ChainTypes.Ethereum:
      return new EthereumAPI.V1Api(new EthereumAPI.Configuration({ basePath: baseURL }))
    case ChainTypes.Bitcoin:
      return new BitcoinAPI.V1Api(new BitcoinAPI.Configuration({ basePath: baseURL }))
    default:
      throw new Error(`ChainAdapterManager: cannot instantiate unchained provider for ${type}`)
  }
}

export class ChainAdapterManager {
  private supported: Map<ChainTypes, () => ChainAdapter<ChainTypes>> = new Map()
  private instances: Map<ChainTypes, ChainAdapter<ChainTypes>> = new Map()

  constructor(unchainedUrlsOrProviders: Partial<UnchainedUrls | UnchainedProviders>) {
    if (!unchainedUrlsOrProviders) {
      throw new Error('Blockchain urls required')
    }

    const unchainedProviders = Object.fromEntries(
      Object.entries(unchainedUrlsOrProviders).map(([type, urlOrProvider]) =>
        typeof urlOrProvider === 'string'
          ? constructUnchainedProvider(type as ChainTypes, urlOrProvider)
          : urlOrProvider
      )
    ) as Partial<UnchainedProviders>

    for (const [type, provider] of Object.entries(unchainedProviders)) {
      switch (type) {
        case ChainTypes.Ethereum:
          const ethereumProvider = provider as UnchainedProviders[ChainTypes.Ethereum]
          this.addChain(type, () => new EthereumChainAd5apter({ provider: ethereumProvider }))
          break
        case ChainTypes.Bitcoin:
          const bitcoinProvider = provider as UnchainedProviders[ChainTypes.Bitcoin]
          this.addChain(
            type,
            () => new BitcoinChainAdapter({ provider: bitcoinProvider, coinName: 'Bitcoin' })
          )
          break
        default:
          throw new Error(`ChainAdapterManager: cannot instantiate ${type} chain adapter`)
      }
    }
  }

  /**
   * Add support for a network by providing a class that implements ChainAdapter
   *
   * @example
   * import { ChainAdapterManager, UtxoChainAdapter } from 'chain-adapters'
   * const manager = new ChainAdapterManager(client)
   * manager.addChain('bitcoin', () => new UtxoChainAdapter('BTG', client))
   * @param {ChainTypes} network - Coin/network symbol from Asset query
   * @param {Function} factory - A function that returns a ChainAdapter instance
   */
  addChain<T extends ChainTypes>(chain: T, factory: () => ChainAdapter<T>): void {
    if (typeof chain !== 'string' || typeof factory !== 'function') {
      throw new Error('Parameter validation error')
    }
    this.supported.set(chain, factory)
  }

  getSupportedChains(): Array<ChainTypes> {
    return Array.from(this.supported.keys())
  }

  getSupportedAdapters(): Array<() => ChainAdapter<ChainTypes>> {
    return Array.from(this.supported.values())
  }

  /*** Get a ChainAdapter instance for a network */
  byChain<T extends ChainTypes>(chain: T): ChainAdapter<T> {
    let adapter = this.instances.get(chain)
    if (!adapter) {
      const factory = this.supported.get(chain)
      if (factory) {
        adapter = factory()
        if (!adapter || !isChainAdapterOfType(chain, adapter)) {
          throw new Error(
            `Adapter type [${
              adapter ? adapter.getType() : typeof adapter
            }] does not match requested type [${chain}]`
          )
        }
        this.instances.set(chain, adapter)
      }
    }

    if (!adapter) {
      throw new Error(`Network [${chain}] is not supported`)
    }

    return adapter as ChainAdapter<T>
  }
}
