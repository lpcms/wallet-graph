import { describe, expect, it, vi } from 'vitest'
import { classifyAddress, ZERO_ADDRESS } from '../src/lib/entities'
import { KNOWN_ADDRESSES, SERVICE_ADDRESSES } from '../src/constants/known-addresses'
import { GraphBuilderService } from '../src/services/graph-builder.service'
import { GraphController } from '../src/controllers/graph.controller'
import type { EtherscanService } from '../src/services/etherscan.service'
import type { GraphBuilderService as GB } from '../src/services/graph-builder.service'
import type { ClusterService } from '../src/services/cluster.service'
import type { AnalyticsService } from '../src/services/analytics.service'
import type { ModelService } from '../src/services/model.service'
import type { PriceService } from '../src/services/price.service'
import type { HopExpansionService } from '../src/services/hop-expansion.service'
import { addr, tokenTx } from './helpers'

const BINANCE  = '0x28c6c06298d514db089934071355e5743bf21d60'
const UNISWAP  = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
const LIDO     = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84'
const JUMP     = '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621'
const VITALIK  = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'

describe('KNOWN_ADDRESSES', () => {
  it('адреса в нижнем регистре и без дублей', () => {
    for (const a of KNOWN_ADDRESSES.keys()) expect(a).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('сервисные — только биржи и протоколы, фонды и персоны участвуют в анализе', () => {
    expect(SERVICE_ADDRESSES.has(BINANCE)).toBe(true)
    expect(SERVICE_ADDRESSES.has(UNISWAP)).toBe(true)
    expect(SERVICE_ADDRESSES.has(LIDO)).toBe(true)
    expect(SERVICE_ADDRESSES.has(JUMP)).toBe(false)
    expect(SERVICE_ADDRESSES.has(VITALIK)).toBe(false)
  })
})

describe('classifyAddress', () => {
  it('известные адреса — по списку, регистр не важен', () => {
    expect(classifyAddress(BINANCE.toUpperCase().replace('0X', '0x'))).toEqual({ type: 'CEX', name: 'Binance 14' })
    expect(classifyAddress(UNISWAP).type).toBe('DEX')
    expect(classifyAddress(LIDO).type).toBe('DEFI')
    expect(classifyAddress(JUMP).type).toBe('FUND')
    expect(classifyAddress(VITALIK)).toEqual({ type: 'PERSON', name: 'Vitalik Buterin' })
  })

  it('нулевой адрес — эмитент (минт и сжигание)', () => {
    expect(classifyAddress(ZERO_ADDRESS).type).toBe('ISSUER')
  })

  it('приоритет: список → эмитент → контракт → сервисный кошелёк → кошелёк', () => {
    const a = addr(1)
    const hints = { contracts: new Set([a]), services: new Set([a]), issuers: new Map([[a, 'создатель токена']]) }
    expect(classifyAddress(a, hints)).toEqual({ type: 'ISSUER', name: 'создатель токена' })
    expect(classifyAddress(a, { contracts: hints.contracts, services: hints.services })).toEqual({ type: 'UNATTRIBUTED', name: 'смарт-контракт' })
    expect(classifyAddress(a, { services: hints.services }).name).toBe('сервисный кошелёк (10 000+ tx)')
    expect(classifyAddress(a)).toEqual({ type: 'WALLET', verified: false })
    expect(classifyAddress(a, { verified: new Set([a]) })).toEqual({ type: 'WALLET', verified: true })
    // список важнее подсказок: Uniswap — DEX, даже если он в списке контрактов
    expect(classifyAddress(UNISWAP, { contracts: new Set([UNISWAP]) }).type).toBe('DEX')
  })
})

describe('GraphBuilderService: категории узлов', () => {
  it('каждый узел получает категорию', () => {
    const pool = addr(2)
    const { nodes } = new GraphBuilderService().buildGraph(
      [tokenTx(ZERO_ADDRESS, addr(1), 100), tokenTx(addr(1), BINANCE, 10), tokenTx(addr(1), pool, 5)],
      new Map(), 2000, new Map(), { contracts: new Set([pool]) },
    )
    const byAddr = Object.fromEntries(nodes.map(n => [n.walletAddress, n]))

    expect(byAddr[ZERO_ADDRESS].entityType).toBe('ISSUER')
    expect(byAddr[addr(1)].entityType).toBe('WALLET')
    expect(byAddr[BINANCE]).toMatchObject({ entityType: 'CEX', entityName: 'Binance 14', isExchange: true })
    expect(byAddr[pool]).toMatchObject({ entityType: 'UNATTRIBUTED', entityName: 'смарт-контракт' })
  })
})

describe('GraphController: категории в графе токена', () => {
  it('проверяет самых активных, находит контракт токена и его создателя', async () => {
    const token = addr(0x70), creator = addr(0x71), pool = addr(0x72), hot = addr(0x73)
    const getContractCreators = vi.fn(async (list: string[]) =>
      new Map(list.filter(a => a === token || a === pool).map(a => [a, a === token ? creator : addr(0x99)])))
    const getHighActivity = vi.fn(async (list: string[]) => new Set(list.filter(a => a === hot)))
    const controller = new GraphController(
      { getContractCreators, getHighActivity } as unknown as EtherscanService,
      {} as GB, {} as ClusterService, {} as AnalyticsService, {} as ModelService, {} as PriceService, {} as HopExpansionService,
    )
    // активность: pool > hot > известный Binance > нулевой адрес > обычные
    const addrCount = new Map([[pool, 50], [hot, 40], [BINANCE, 30], [ZERO_ADDRESS, 20], [addr(1), 1]])

    const hints = await controller['collectTokenHints'](token, addrCount)

    expect(hints.issuers).toEqual(new Map([[token, 'контракт токена'], [creator, 'создатель токена']]))
    expect(hints.contracts).toEqual(new Set([token, pool]))
    expect(hints.services).toEqual(new Set([hot]))
    // известные и нулевой адрес не тратят запросы
    expect(getContractCreators.mock.calls[0][0]).toEqual([token, pool, hot, addr(1)])
    // контракты повторно на 10 000+ tx не проверяются
    expect(getHighActivity.mock.calls[0][0]).toEqual([hot, addr(1)])
  })
})
