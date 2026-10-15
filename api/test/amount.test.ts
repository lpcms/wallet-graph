import { describe, expect, it } from 'vitest'
import { isTokenTransfer, txAmount } from '../src/lib/amount'
import { GraphBuilderService } from '../src/services/graph-builder.service'
import { ClusterService } from '../src/services/cluster.service'
import { AnalyticsService } from '../src/services/analytics.service'
import { addr, tokenTx, tx } from './helpers'

describe('txAmount', () => {
  it('ETH-перевод — 18 знаков', () => {
    expect(txAmount(tx(addr(1), addr(2), 1.5))).toBe(1.5)
  })

  it('перевод токена — по tokenDecimal', () => {
    expect(txAmount(tokenTx(addr(1), addr(2), 500, 6))).toBe(500)     // USDT
    expect(txAmount(tokenTx(addr(1), addr(2), 0.25, 8))).toBe(0.25)   // WBTC
    expect(txAmount(tokenTx(addr(1), addr(2), 42, 18))).toBe(42)
  })

  it('пустой tokenDecimal считается как 18', () => {
    expect(txAmount({ ...tx(addr(1), addr(2), 2), tokenDecimal: '' })).toBe(2)
    expect(isTokenTransfer({ ...tx(addr(1), addr(2), 2), tokenDecimal: '' })).toBe(false)
  })
})

describe('GraphBuilderService: единицы сумм', () => {
  const [a, b] = [addr(1), addr(2)]
  const build = (txs: Parameters<GraphBuilderService['buildGraph']>[0], balances = new Map<string, number>()) =>
    new GraphBuilderService().buildGraph(txs, balances, 2000, new Map())

  it('граф токена: поток в токенах, баланс ETH неизвестен, без пересчёта в $ по курсу ETH', () => {
    const { nodes, links } = build([tokenTx(a, b, 10_000, 6)])
    const receiver = nodes.find(n => n.walletAddress === b)!

    expect(receiver.tokenFlow).toBe(10_000)
    expect(receiver.tokenSymbol).toBe('USDT')
    expect(receiver.balanceKnown).toBe(false)
    expect(receiver.usdValue).toBe('$0.00')          // а не 10 000 × $2000
    expect(links[0].transactionWeight).toBe(10_000)
    expect(links[0].usdWeight).toBeUndefined()
  })

  it('граф токена: реальный баланс ETH используется, если он запрошен', () => {
    const { nodes } = build([tokenTx(a, b, 10_000, 6)], new Map([[b, 1.5]]))
    const receiver = nodes.find(n => n.walletAddress === b)!

    expect(receiver.balanceKnown).toBe(true)
    expect(receiver.usdValue).toBe('$3000.00')
  })

  it('ETH-граф: баланс оценивается потоком ETH, вес связи — в долларах', () => {
    const { nodes, links } = build([tx(a, b, 2)])
    const receiver = nodes.find(n => n.walletAddress === b)!

    expect(receiver.balanceKnown).toBe(true)
    expect(receiver.tokenBalance).toBe(2)
    expect(receiver.tokenFlow).toBeUndefined()
    expect(links[0].usdWeight).toBe(4000)
  })
})

describe('ClusterService: суммы токенов с 6 знаками — не пыль', () => {
  it('рассылка 100–7000 USDT шести адресам не склеивает получателей как пылевую', () => {
    // Суммы разные — эвристика «общий источник» (похожие суммы) не срабатывает,
    // проверяется только пылевая: раньше 500 USDT считались 5·10⁻¹⁰ «ETH», то есть пылью
    const sender    = addr(0x50)
    const receivers = Array.from({ length: 6 }, (_, i) => addr(0x60 + i))
    const amounts   = [100, 500, 900, 2_000, 3_500, 7_000]
    const txs = receivers.map((r, i) => tokenTx(sender, r, amounts[i], 6, 1_700_000_000 + i * 100))

    const clusters = new ClusterService().buildClusters(txs, new Map(), 2000, new AnalyticsService())

    for (const r of receivers) expect(clusters.get(r)!.addresses).toEqual([r])
  })

  it('настоящая пыль (0.0001 USDT) по-прежнему распознаётся', () => {
    const sender    = addr(0x50)
    const receivers = Array.from({ length: 6 }, (_, i) => addr(0x60 + i))
    const txs = receivers.map((r, i) => tokenTx(sender, r, 0.0001, 6, 1_700_000_000 + i * 100))

    const clusters = new ClusterService().buildClusters(txs, new Map(), 2000, new AnalyticsService())

    expect(clusters.get(receivers[0])!.addresses).toHaveLength(6)
  })
})
