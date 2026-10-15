import { describe, expect, it } from 'vitest'
import { ClusterService } from '../src/services/cluster.service'
import { AnalyticsService } from '../src/services/analytics.service'
import { UnionFind } from '../src/lib/union-find'
import { addr, tx } from './helpers'

describe('UnionFind', () => {
  it('объединяет адреса без учёта регистра', () => {
    const uf = new UnionFind()
    uf.union('0xAAA', '0xbbb')
    uf.union('0xBBB', '0xccc')
    uf.add('0xddd')

    expect(uf.find('0xaaa')).toBe(uf.find('0xCCC'))
    const sizes = [...uf.getClusters().values()].map(c => c.length).sort()
    expect(sizes).toEqual([1, 3])
  })
})

describe('ClusterService.buildClusters', () => {
  const [a, b, c, d] = [addr(0xa), addr(0xb), addr(0xc), addr(0xd)]
  const t0 = 1_700_000_000

  // a и b дважды переводят друг другу туда-обратно в пределах 30 минут → один владелец
  const transactions = [
    tx(a, b, 1, 1, t0),
    tx(b, a, 1, 1, t0 + 60),
    tx(a, b, 1, 2, t0 + 120),
    tx(b, a, 1, 2, t0 + 180),
    tx(c, a, 10, 3, t0 + 86_400),   // приход в кластер
    tx(b, d, 2, 4, t0 + 90_000),    // уход из кластера
  ]
  const balances = new Map([[a, 3], [b, 4]])

  const clusters = new ClusterService().buildClusters(transactions, balances, 2000, new AnalyticsService())

  it('объединяет адреса со взаимными переводами', () => {
    expect(clusters.get(a)!.addresses.sort()).toEqual([a, b].sort())
    expect(clusters.get(c)!.addresses).toEqual([c])
  })

  it('считает роль по внешним потокам, не учитывая переводы внутри кластера', () => {
    // вход 10 ETH, выход 2 ETH → доля входа 0.83 > 0.7
    expect(clusters.get(a)!.role).toBe('ACCUMULATOR')
    expect(clusters.get(c)!.role).toBe('DISTRIBUTOR')
  })

  it('суммирует балансы участников кластера', () => {
    expect(clusters.get(a)!.totalEth).toBe(7)
    expect(clusters.get(a)!.totalUsd).toBe(14_000)
  })
})

describe('ClusterService: K-means группы', () => {
  // 12 «отправителей» только отправляют, 12 «получателей» только принимают
  const senders   = Array.from({ length: 12 }, (_, i) => addr(0x1000 + i))
  const receivers = Array.from({ length: 12 }, (_, i) => addr(0x2000 + i))
  const txs = senders.flatMap((s, i) => [
    tx(s, receivers[i], 50, i, 1_700_000_000 + i * 7_200),
    tx(s, receivers[(i + 1) % 12], 50, i, 1_700_003_600 + i * 7_200),
  ])
  const run = () => new ClusterService().buildClusters(txs, new Map(), 2000, new AnalyticsService())

  it('присваивает каждому адресу группу с описанием', () => {
    const clusters = run()
    const sender   = clusters.get(senders[0])!.behavior[senders[0]]
    const receiver = clusters.get(receivers[0])!.behavior[receivers[0]]

    expect(sender.group).not.toBe(receiver.group)
    expect(sender.k).toBeGreaterThanOrEqual(2)
    expect(sender.label).toContain('в основном отправляет')
    expect(receiver.label).toContain('в основном получает')
  })

  it('одинаковые данные дают одинаковые группы (фиксированный seed)', () => {
    const first  = run(), second = run()
    for (const a of [...senders, ...receivers]) {
      expect(second.get(a)!.behavior[a]).toEqual(first.get(a)!.behavior[a])
    }
  })
})
