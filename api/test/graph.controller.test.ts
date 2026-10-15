import { describe, expect, it, vi } from 'vitest'
import { GraphController } from '../src/controllers/graph.controller'
import { SERVICE_ADDRESSES } from '../src/constants/known-addresses'
import type { EtherscanService } from '../src/services/etherscan.service'
import type { GraphBuilderService } from '../src/services/graph-builder.service'
import type { ClusterService } from '../src/services/cluster.service'
import type { AnalyticsService } from '../src/services/analytics.service'
import type { ModelService } from '../src/services/model.service'
import type { ClusterInfo } from '../src/types'
import { addr, tx } from './helpers'

function controllerWith(etherscan: Partial<Record<keyof EtherscanService, unknown>>) {
  return new GraphController(
    etherscan as unknown as EtherscanService,
    {} as GraphBuilderService,
    {} as ClusterService,
    {} as AnalyticsService,
    {} as ModelService,
  )
}

const root = addr(0x100)
const cex  = [...SERVICE_ADDRESSES.keys()][0]

describe('GraphController: выбор контрагентов для 2-го хопа', () => {
  it('сортирует по объёму ETH и пропускает биржи и контракты', async () => {
    const [x1, x2, x3, contract] = [addr(1), addr(2), addr(3), addr(4)]
    const getContracts = vi.fn(async (list: string[]) => new Set(list.filter(a => a === contract)))
    const controller = controllerWith({ getContracts })

    const picked = await controller['selectHop2Counterparties'](root, [
      tx(root, x1, 100),
      tx(x2, root, 50),
      tx(root, cex, 1000),
      tx(root, contract, 500),
      tx(root, x3, 10),
    ])

    expect(picked).toEqual([x1, x2, x3])
    // x2 сам отправлял tx — значит кошелёк, проверять его на контракт не нужно
    expect(getContracts.mock.calls[0][0]).toEqual([contract, x1, x3])
  })

  it('берёт не больше 50 контрагентов', async () => {
    const controller = controllerWith({ getContracts: async () => new Set<string>() })
    const rootTx = Array.from({ length: 70 }, (_, i) => tx(root, addr(i + 1), i + 1))

    const picked = await controller['selectHop2Counterparties'](root, rootTx)

    expect(picked).toHaveLength(50)
    expect(picked[0]).toBe(addr(70))
  })
})

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

    expect(cap.fullEth).toBe(15.5)        // root 10 + friend 5 + small 0.5
    expect(cap.fullAddresses).toBe(3)
    expect(cap.clusterEth).toBe(15)       // root + friend
    expect(cap.clusterUsd).toBe(30_000)
    expect(cap.excludedContracts).toBe(1)
    expect(cap.excludedServices).toBe(1)
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
