import { describe, expect, it, vi } from 'vitest'
import { HopExpansionService, clampHops, clampWidth } from '../src/services/hop-expansion.service'
import { hopDistances } from '../src/lib/hops'
import { SERVICE_ADDRESSES } from '../src/constants/known-addresses'
import type { EtherscanService } from '../src/services/etherscan.service'
import type { EtherscanTransaction } from '../src/types'
import { addr, tx } from './helpers'

const root = addr(0x100)
const cex  = [...SERVICE_ADDRESSES.keys()][0]

// Etherscan-заглушка: история каждого адреса и список контрактов
function etherscanWith(history: Record<string, EtherscanTransaction[]>, contracts: string[] = []) {
  const getContracts = vi.fn(async (list: string[]) => new Set(list.filter(a => contracts.includes(a))))
  const getRecentWalletTransactions = vi.fn(async (a: string) => history[a] ?? [])
  return { service: new HopExpansionService({ getContracts, getRecentWalletTransactions } as unknown as EtherscanService), getContracts, getRecentWalletTransactions }
}

describe('HopExpansionService', () => {
  it('идёт за деньгами по цепочке: на каждом хопе — самый крупный новый поток', async () => {
    // root → A → B → C, у каждого ещё мелкий получатель
    const [a, b, c] = [addr(1), addr(2), addr(3)]
    const rootTx = [tx(root, a, 100), tx(root, addr(11), 1)]
    const { service } = etherscanWith({
      [a]: [tx(root, a, 100), tx(a, b, 90), tx(a, addr(12), 1)],
      [b]: [tx(a, b, 90), tx(b, c, 80), tx(b, addr(13), 1)],
      [c]: [tx(b, c, 80)],
    })

    const result = await service.expand(root, rootTx, 4, 1)

    expect(result.expandedByHop).toEqual([[a], [b], [c]])
    expect([...result.expanded]).toEqual([root, a, b, c])
    // шаг загрузки транзакций: история кошелька — 1, раскрытие на хопе k — k (повторно загруженные — первый шаг)
    const step = (from: string, to: string) => result.txSteps.get(result.transactions.find(t => t.from === from && t.to === to)!.hash)
    expect([step(root, a), step(a, b), step(a, addr(12)), step(b, c), step(b, addr(13))]).toEqual([1, 2, 2, 3, 3])
  })

  it('берёт width крупнейших, пропуская биржи и контракты', async () => {
    const [big, mid, small, contract] = [addr(1), addr(2), addr(3), addr(4)]
    const rootTx = [tx(root, cex, 1000), tx(root, contract, 500), tx(root, big, 100), tx(root, mid, 50), tx(root, small, 10)]
    const { service, getContracts } = etherscanWith({}, [contract])

    const result = await service.expand(root, rootTx, 2, 2)

    expect(result.expandedByHop).toEqual([[big, mid]])
    // биржа из списка в проверку не попадает, контракт отсеян по ответу Etherscan
    expect(getContracts.mock.calls[0][0]).not.toContain(cex)
  })

  it('от адреса с очень частыми транзакциями дальше не раскрывает', async () => {
    const [bot, victim] = [addr(1), addr(2)]
    // 1000 последних tx бота уложились в 1000 секунд
    const botTx = Array.from({ length: 1000 }, (_, i) => tx(bot, addr(1000 + i), 1, 1, 1_700_000_000 + i))
    const { service, getRecentWalletTransactions } = etherscanWith({ [bot]: [tx(root, bot, 50), ...botTx], [victim]: [] })

    const result = await service.expand(root, [tx(root, bot, 50)], 5, 5)

    expect(result.expandedByHop).toEqual([[bot]])               // 3-го хопа нет
    expect(getRecentWalletTransactions).toHaveBeenCalledTimes(1)
  })

  it('останавливается, когда цепочки оборвались, и сообщает о прогрессе', async () => {
    const a = addr(1)
    const progress = vi.fn()
    const { service } = etherscanWith({ [a]: [tx(root, a, 10)] })

    const result = await service.expand(root, [tx(root, a, 10)], 15, 10, progress)

    expect(result.expandedByHop).toEqual([[a]])
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ hop: 2, hops: 15, expanded: 1 }))
  })

  it('делит бюджет поровну и всегда сохраняет переводы цепочки', async () => {
    const [a, b] = [addr(1), addr(2)]
    const noise = (from: string, n: number, t0: number) => Array.from({ length: n }, (_, i) => tx(from, addr(5000 + t0 + i), 1, 1, t0 + i))
    const link = tx(a, b, 50, 1, 1)   // самый старый, но это переход между хопами
    const { service } = etherscanWith({
      [a]: [tx(root, a, 100), link, ...noise(a, 300, 1_000)],
      [b]: [link, ...noise(b, 300, 2_000)],
    })

    const result = await service.expand(root, [tx(root, a, 100)], 3, 1, () => {}, 100)

    const hashes = new Set(result.transactions.map(t => t.hash))
    expect(hashes.has(link.hash)).toBe(true)
    // квота — не меньше 50 на адрес: по 50 свежих у a и b + цепочка
    expect(result.transactions.length).toBeLessThanOrEqual(1 + 50 + 50 + 3)
  })

  it('параметры ограничены: 1–15 хопов, 5–50 адресов', () => {
    expect([clampHops(0), clampHops(7), clampHops(99), clampHops(NaN)]).toEqual([1, 7, 15, 1])
    expect([clampWidth(1), clampWidth(10), clampWidth(500)]).toEqual([5, 10, 50])
  })
})

describe('hopDistances', () => {
  it('число переводов от кошелька по кратчайшему пути', () => {
    const [a, b, c] = [addr(1), addr(2), addr(3)]
    const link = (s: string, t: string) => ({ sourceAddress: s, targetAddress: t })
    const dist = hopDistances([link(root, a), link(a, b), link(c, b), link(root, c)], root.toUpperCase().replace('0X', '0x'))
    expect(Object.fromEntries(dist)).toEqual({ [root]: 0, [a]: 1, [c]: 1, [b]: 2 })
  })
})
