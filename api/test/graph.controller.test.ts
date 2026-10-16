import { describe, expect, it, vi } from 'vitest'
import { GraphController } from '../src/controllers/graph.controller'
import type { EtherscanService } from '../src/services/etherscan.service'
import type { GraphBuilderService } from '../src/services/graph-builder.service'
import type { ClusterService } from '../src/services/cluster.service'
import type { AnalyticsService } from '../src/services/analytics.service'
import type { ModelService } from '../src/services/model.service'
import type { PriceService } from '../src/services/price.service'
import type { HopExpansionService } from '../src/services/hop-expansion.service'
import type { ClusterInfo } from '../src/types'
import { addr, tx } from './helpers'

function controllerWith(etherscan: Partial<Record<keyof EtherscanService, unknown>>) {
  return new GraphController(
    etherscan as unknown as EtherscanService,
    {} as GraphBuilderService,
    {} as ClusterService,
    {} as AnalyticsService,
    {} as ModelService,
    {} as PriceService,
    {} as HopExpansionService,
  )
}

const root = addr(0x100)

describe('GraphController: капитализация группы', () => {
  const [friend, contract, service, small] = [addr(1), addr(2), addr(3), addr(4)]
  const balances = () => new Map([[root, 10], [friend, 5], [contract, 1000], [service, 500], [small, 0.5]])
  const transactions = [
    tx(root, friend, 1), tx(friend, root, 1), tx(service, root, 1), tx(root, contract, 1), tx(root, small, 1),
  ]
  const cluster: ClusterInfo = {
    clusterId: root, addresses: [root, friend], totalEth: 15, totalUsd: 0,
    role: 'RELAY', archetype: 'MIXED', signals: [],
    gr: {} as ClusterInfo['gr'], markov: {} as ClusterInfo['markov'], behavior: {},
  }

  it('находит контракты и сервисные кошельки, но не трогает сам кошелёк', async () => {
    const getHighActivity = vi.fn(async (list: string[]) => new Set(list.filter(a => a === service || a === root)))
    const getContracts    = vi.fn(async (list: string[]) => new Set(list.filter(a => a === contract)))
    const controller = controllerWith({ getContracts, getHighActivity })

    const hints = await controller['detectWalletHints'](root, [root, friend, contract, service, small], transactions, balances())

    expect([...hints.contracts!]).toEqual([contract])
    expect([...hints.services!]).toEqual([service])
    // отправители обычных tx — заведомо кошельки, на контракт их не проверяем
    expect(getContracts.mock.calls[0][0]).toEqual([contract, small])
    expect(getHighActivity.mock.calls[0][0]).not.toContain(root)
    // проверенные кошельки: отправители tx + проверенные не-контракты
    expect([...hints.verified!].sort()).toEqual([root, friend, service, small].sort())
  })

  it('исключает из капитализации контракты и сервисные кошельки', async () => {
    const controller = controllerWith({ getBalances: async () => new Map(), getContracts: async () => new Set<string>() })
    const hints = { contracts: new Set([contract]), services: new Set([service]), verified: new Set([root, friend]) }

    const cap = await controller['computeCapitalization'](
      root, [root, friend, contract, service, small], balances(),
      new Map([[root, cluster], [friend, cluster]]), 2000, hints,
    )

    expect(cap.allEth).toBe(15.5)         // root 10 + friend 5 + small 0.5
    expect(cap.allAddresses).toBe(3)
    expect(cap.clusterEth).toBe(15)       // root + friend
    expect(cap.clusterUsd).toBe(30_000)
    expect(cap.excludedContracts).toBe(1)
    expect(cap.excludedServices).toBe(1)
  })

  it('ближнее окружение — до 2 хопов, крупный кошелёк на дальнем хопе только во «всём окружении»', async () => {
    const whale = addr(0x99)
    const controller = controllerWith({ getBalances: async () => new Map(), getContracts: async () => new Set<string>() })
    const hints = { verified: new Set([root, friend, small, whale]) }
    const distances = new Map([[root, 0], [friend, 1], [small, 2], [whale, 5]])

    const cap = await controller['computeCapitalization'](
      root, [root, friend, small, whale], new Map([[root, 10], [friend, 5], [small, 0.5], [whale, 20_000]]),
      new Map([[root, cluster], [friend, cluster]]), 2000, hints, distances,
    )

    expect(cap.nearHops).toBe(2)
    expect(cap.nearEth).toBe(15.5)        // root + friend (1 хоп) + small (2 хопа)
    expect(cap.nearAddresses).toBe(3)
    expect(cap.allEth).toBe(20_015.5)     // + кит на 5-м хопе
    expect(cap.allUsd).toBe(40_031_000)
  })

  it('догружает участников кластера вне графа и проверяет их на контракт', async () => {
    const [outside, outsideContract] = [addr(9), addr(10)]
    const getBalances  = vi.fn(async () => new Map([[outside, 2], [outsideContract, 7]]))
    const getContracts = vi.fn(async (list: string[]) => new Set(list.filter(a => a === outsideContract)))
    const controller = controllerWith({ getBalances, getContracts })
    const wide = { ...cluster, addresses: [root, outside, outsideContract] }

    const cap = await controller['computeCapitalization'](
      root, [root], new Map([[root, 10]]), new Map([[root, wide]]), 2000, { verified: new Set([root]) },
    )

    expect(getBalances).toHaveBeenCalledWith([outside, outsideContract])
    expect(getContracts).toHaveBeenCalledWith([outside, outsideContract])
    expect(cap.clusterEth).toBe(12)       // root 10 + outside 2, контракт не считается
  })
})
