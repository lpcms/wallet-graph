import { Injectable } from '@nestjs/common'
import { CONFIG } from '../config'
import { SERVICE_ADDRESSES } from '../constants/known-addresses'
import { txAmount } from '../lib/amount'
import { ZERO_ADDRESS } from '../lib/entities'
import type { EtherscanTransaction } from '../types'
import { EtherscanService } from './etherscan.service'

export const MAX_HOPS  = 15
export const MIN_WIDTH = 5
export const MAX_WIDTH = 50

// Адрес с очень частыми транзакциями (последние PAGE_SIZE уложились в 3 дня) — бот, горячий
// кошелёк биржи или маркет-мейкер: его транзакции оставляем, но дальше от него не раскрываем,
// иначе следующий хоп заполнили бы его случайные клиенты
const HIGH_FREQUENCY_SPAN_SEC = 3 * 24 * 3600

export interface HopProgress {
  hop:          number
  hops:         number
  expanded:     number   // сколько адресов раскрыто на этом хопе
  transactions: number   // всего загружено транзакций
  message:      string
}

export interface HopResult {
  transactions: EtherscanTransaction[]  // кошелёк + раскрытые хопы (после обрезки по квоте)
  expandedByHop: string[][]             // [0] — адреса 2-го хопа, [1] — 3-го…
  expanded:     Set<string>             // все раскрытые адреса, включая сам кошелёк
  // шаг загрузки каждой транзакции (hash → шаг): история кошелька — 1, раскрытие на хопе k — k.
  // По нему считается шаг цепочки адреса — по тем же связям, что попадут в граф
  txSteps:      Map<string, number>
}

export function clampHops(hops: number)   { return Math.min(MAX_HOPS, Math.max(1, Math.round(hops) || 1)) }
export function clampWidth(width: number) { return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width) || MIN_WIDTH)) }

// Раскрытие хопов «по деньгам»: на каждом следующем хопе загружаются последние транзакции
// `width` самых крупных по объёму ETH новых контрагентов адресов предыдущего хопа.
// Биржи, контракты и адреса с очень частыми транзакциями дальше не раскрываются — так цепочки
// естественно обрываются, когда деньги доходят до биржи или DEX.
@Injectable()
export class HopExpansionService {
  constructor(private etherscanService: EtherscanService) {}

  async expand(
    rootAddress: string,
    rootTx: EtherscanTransaction[],
    hops: number,
    width: number,
    onProgress: (p: HopProgress) => void = () => {},
    // сколько транзакций раскрытых адресов оставить для анализа (у самого кошелька — все)
    budget = 10_000,
  ): Promise<HopResult> {
    const root = rootAddress.toLowerCase()
    // отправитель обычной tx — всегда кошелёк (EOA), его не нужно проверять на контракт
    const knownEoa = new Set<string>()
    const noteSenders = (txs: EtherscanTransaction[]) => txs.forEach(tx => { if (tx.from) knownEoa.add(tx.from.toLowerCase()) })
    noteSenders(rootTx)

    const expanded = new Set([root])
    const txSteps = new Map<string, number>()
    const noteStep = (txs: EtherscanTransaction[], step: number) => txs.forEach(tx => {
      if (!txSteps.has(tx.hash)) txSteps.set(tx.hash, step)
    })
    noteStep(rootTx, 1)
    const blocked  = new Set<string>()           // найденные контракты — не раскрываем
    const loadedBy = new Map<string, EtherscanTransaction[]>()
    const expandedByHop: string[][] = []
    let frontier = new Map([[root, rootTx]])
    let total = rootTx.length

    for (let hop = 2; hop <= hops && frontier.size; hop++) {
      // объём ETH между адресами прошлого хопа и каждым новым контрагентом
      const volume = new Map<string, number>()
      frontier.forEach((txs, addr) => {
        for (const tx of txs) {
          const from = tx.from?.toLowerCase(), to = tx.to?.toLowerCase()
          const other = from === addr ? to : to === addr ? from : undefined
          if (!other || expanded.has(other) || blocked.has(other) || other === ZERO_ADDRESS || SERVICE_ADDRESSES.has(other)) continue
          volume.set(other, (volume.get(other) || 0) + txAmount(tx))
        }
      })
      const ranked = [...volume.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([a]) => a)

      // идём по рейтингу пачками и отсеиваем контракты, пока не наберём width кошельков
      const picked: string[] = []
      for (let i = 0; i < ranked.length && picked.length < width; i += width) {
        const batch = ranked.slice(i, i + width)
        const contracts = await this.etherscanService.getContracts(batch.filter(a => !knownEoa.has(a)))
        contracts.forEach(c => blocked.add(c))
        for (const a of batch) if (!contracts.has(a) && picked.length < width) picked.push(a)
      }
      if (!picked.length) break

      onProgress({ hop, hops, expanded: picked.length, transactions: total, message: `Хоп ${hop}/${hops}: загружаем ${picked.length} адресов…` })
      const loaded = await Promise.all(picked.map(addr =>
        this.etherscanService.getRecentWalletTransactions(addr).catch(err => {
          console.log(`  [Hops] ${addr.slice(0, 10)}... ошибка: ${err}`)
          return [] as EtherscanTransaction[]
        }),
      ))

      const next = new Map<string, EtherscanTransaction[]>()
      picked.forEach((addr, i) => {
        noteStep(loaded[i], hop)
        expanded.add(addr)
        loadedBy.set(addr, loaded[i])
        total += loaded[i].length
        noteSenders(loaded[i])
        if (!isHighFrequency(loaded[i])) next.set(addr, loaded[i])
      })
      expandedByHop.push(picked)
      frontier = next
      console.log(`  [Hops] хоп ${hop}: ${picked.length} адресов (дальше раскрываются ${next.size}), всего ${total} tx`)
      onProgress({ hop, hops, expanded: picked.length, transactions: total, message: `Хоп ${hop}/${hops}: ${picked.length} адресов, всего ${total.toLocaleString('ru-RU')} транзакций` })
    }

    return { transactions: [...rootTx, ...trimToBudget(loadedBy, expanded, budget)], expandedByHop, expanded, txSteps }
  }
}

function isHighFrequency(txs: EtherscanTransaction[]): boolean {
  if (txs.length < CONFIG.pageSize) return false
  const times = txs.map(tx => Number(tx.timeStamp))
  return Math.max(...times) - Math.min(...times) < HIGH_FREQUENCY_SPAN_SEC
}

// Поровну на каждый раскрытый адрес — его самые свежие транзакции, чтобы глубокие хопы
// не вытеснялись активными адресами ближних. Переводы между раскрытыми адресами
// (сама цепочка хопов) сохраняются всегда.
function trimToBudget(loadedBy: Map<string, EtherscanTransaction[]>, expanded: Set<string>, budget: number): EtherscanTransaction[] {
  if (!loadedBy.size) return []
  const quota = Math.max(50, Math.floor(budget / loadedBy.size))
  const kept = new Map<string, EtherscanTransaction>()
  const key = (tx: EtherscanTransaction) => `${tx.hash}:${tx.from}:${tx.to}:${tx.value}`
  loadedBy.forEach(txs => {
    const byTime = [...txs].sort((a, b) => Number(b.timeStamp) - Number(a.timeStamp))
    byTime.forEach((tx, i) => {
      const chain = expanded.has(tx.from?.toLowerCase()) && expanded.has(tx.to?.toLowerCase())
      if (i < quota || chain) kept.set(key(tx), tx)
    })
  })
  return [...kept.values()]
}
