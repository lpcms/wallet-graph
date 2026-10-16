import { describe, expect, it, vi } from 'vitest'
import { DUST_USD, FUNDED_MIN_USD, thresholdsFor } from '../src/lib/thresholds'
import { PriceService } from '../src/services/price.service'
import { ClusterService } from '../src/services/cluster.service'
import { AnalyticsService } from '../src/services/analytics.service'
import { addr, tokenTx } from './helpers'

describe('thresholdsFor', () => {
  it('переводит пороги из долларов в штуки актива', () => {
    const eth = thresholdsFor(2000)
    expect(eth.dust).toBeCloseTo(DUST_USD / 2000)           // 0.001 ETH
    expect(eth.fundedMin).toBeCloseTo(FUNDED_MIN_USD / 2000) // 0.05 ETH
    expect(thresholdsFor(0.0001).dust).toBeCloseTo(20_000)  // дешёвый токен: пыль — до 20 000 штук
  })

  it('без цены — прежние пороги в штуках', () => {
    for (const price of [null, 0, -1, NaN]) {
      expect(thresholdsFor(price)).toEqual({ dust: 0.001, fundedMin: 0.05, inactive: 0.001, priceUsd: null })
    }
  })
})

describe('PriceService', () => {
  const withTicker = (prices: Record<string, number>) => {
    const service = new PriceService()
    const fetchLast = vi.fn(async (pair: string) => {
      if (!(pair in prices)) throw new Error(`binance does not have market symbol ${pair}`)
      return prices[pair]
    })
    service['fetchLast'] = fetchLast
    return { service, fetchLast }
  }

  it('стейблкоины — $1 без запроса', async () => {
    const { service, fetchLast } = withTicker({})
    expect(await service.getTokenPriceUsd('USDT')).toBe(1)
    expect(await service.getTokenPriceUsd('usdc')).toBe(1)
    expect(fetchLast).not.toHaveBeenCalled()
  })

  it('обёрнутые активы — по цене исходного, цена кэшируется', async () => {
    const { service, fetchLast } = withTicker({ 'ETH/USDT': 2400, 'BTC/USDT': 95_000 })
    expect(await service.getTokenPriceUsd('WETH')).toBe(2400)
    expect(await service.getTokenPriceUsd('WBTC')).toBe(95_000)
    expect(await service.getTokenPriceUsd('WETH')).toBe(2400)
    expect(fetchLast.mock.calls.map(c => c[0])).toEqual(['ETH/USDT', 'BTC/USDT'])
  })

  it('нет пары на Binance — цена неизвестна', async () => {
    const { service } = withTicker({})
    expect(await service.getTokenPriceUsd('NOSUCHTOKEN')).toBeNull()
    expect(await service.getTokenPriceUsd(undefined)).toBeNull()
  })
})

describe('ClusterService: пороги в долларах', () => {
  const build = (txs: ReturnType<typeof tokenTx>[], price: number | null) =>
    new ClusterService().buildClusters(txs, new Map(), 2000, new AnalyticsService(), false, new Set(), thresholdsFor(price))

  it('дешёвый токен: рассылка по $0.01–$1.90 — пыль, хотя в штуках это тысячи', () => {
    // суммы разные — «общий источник» (похожие суммы) не срабатывает
    const sender = addr(0x50)
    const receivers = Array.from({ length: 6 }, (_, i) => addr(0x60 + i))
    const amounts = [100, 1_000, 3_000, 9_000, 15_000, 19_000]
    const txs = receivers.map((r, i) => tokenTx(sender, r, amounts[i], 18, 1_700_000_000 + i * 100))

    expect(build(txs, 0.0001).get(receivers[0])!.addresses).toHaveLength(6)   // по $0.0001 — пыль
    expect(build(txs, null).get(receivers[0])!.addresses).toEqual([receivers[0]])  // в штуках — не пыль
  })

  it('дорогой токен: «общий источник» срабатывает от $100, а не от 0.05 штуки', () => {
    // 0.002 WBTC ≈ $190 трём адресам за час: по штукам (0.002 < 0.05) эвристика молчала
    const funder = addr(0x70)
    const receivers = [addr(0x71), addr(0x72), addr(0x73)]
    const txs = receivers.map((r, i) => tokenTx(funder, r, 0.002, 8, 1_700_000_000 + i * 600, 'WBTC'))

    expect(build(txs, 95_000).get(receivers[0])!.addresses).toHaveLength(3)
    expect(build(txs, null).get(receivers[0])!.addresses).toEqual([receivers[0]])
  })
})
