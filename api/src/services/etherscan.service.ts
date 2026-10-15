import { Injectable } from '@nestjs/common'
import { CONFIG } from '../config'
import type { EtherscanTransaction } from '../types'

// ===== ETHERSCAN СЕРВИС =====

@Injectable()
export class EtherscanService {
  private readonly baseUrl = 'https://api.etherscan.io/v2/api'
  private txCache       = new Map<string, { data: EtherscanTransaction[]; cachedAt: number }>()
  private ethPriceCache: { usd: number; cachedAt: number } | null = null

  private buildUrl(params: Record<string, string>): string {
    const query = new URLSearchParams({
      chainid: CONFIG.etherscanChainId,
      apikey:  CONFIG.etherscanApiKey,
      ...params,
    })
    return `${this.baseUrl}?${query.toString()}`
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // Etherscan (бесплатный ключ) — 3 запроса/с. Все запросы идут через общую очередь
  // с шагом ETHERSCAN_INTERVAL_MS, поэтому параллельные вызовы (2-й хоп, балансы) не ловят rate limit.
  // Если лимит всё же сработал — ждём секунду и повторяем (до 5 раз).
  private nextSlot = 0
  private async request<T>(params: Record<string, string>): Promise<{ status: string; message: string; result: T }> {
    for (let attempt = 0; ; attempt++) {
      const now  = Date.now()
      const wait = Math.max(0, this.nextSlot - now)
      this.nextSlot = Math.max(now, this.nextSlot) + CONFIG.etherscanIntervalMs
      if (wait) await this.sleep(wait)

      const res  = await fetch(this.buildUrl(params))
      const data = await res.json() as { status: string; message: string; result: T }
      const rateLimited = data.status !== '1' && typeof data.result === 'string' && /rate limit/i.test(data.result)
      if (!rateLimited || attempt >= 5) return data
      await this.sleep(1000)
    }
  }

  async getEthPriceUsd(): Promise<number> {
    const ONE_MINUTE = 60_000
    if (this.ethPriceCache && Date.now() - this.ethPriceCache.cachedAt < ONE_MINUTE) {
      return this.ethPriceCache.usd
    }
    const url  = this.buildUrl({ module: 'stats', action: 'ethprice' })
    const res  = await fetch(url)
    const data = await res.json() as { status: string; result: { ethusd: string } }
    const usd  = data.status === '1' ? Number(data.result.ethusd) : 0
    this.ethPriceCache = { usd, cachedAt: Date.now() }
    console.log(`  Курс ETH: $${usd.toFixed(2)}`)
    return usd
  }

  async getBalance(address: string): Promise<number> {
    const data = await this.request<string>({ module: 'account', action: 'balance', address, tag: 'latest' })
    if (data.status !== '1') return 0
    return Number(data.result) / 1e18
  }

  // Балансы пачками по 20 адресов (balancemulti) — в 20 раз меньше запросов, чем по одному
  async getBalances(addresses: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    const chunks: string[][] = []
    for (let i = 0; i < addresses.length; i += 20) chunks.push(addresses.slice(i, i + 20))

    await Promise.all(chunks.map(async chunk => {
      const data = await this.request<{ account: string; balance: string }[] | string>({
        module: 'account', action: 'balancemulti', address: chunk.join(','), tag: 'latest',
      })
      if (data.status === '1' && Array.isArray(data.result)) {
        data.result.forEach(r => result.set(r.account.toLowerCase(), Number(r.balance) / 1e18))
      } else {
        for (const addr of chunk) result.set(addr, await this.getBalance(addr))
      }
    }))
    return result
  }

  // Какие из адресов — смарт-контракты (getcontractcreation, до 5 адресов за запрос).
  // Обычные кошельки (EOA) Etherscan в ответе просто не возвращает.
  async getContracts(addresses: string[]): Promise<Set<string>> {
    return new Set((await this.getContractCreators(addresses)).keys())
  }

  // Контракт → адрес его создателя. Кошельки (EOA, в т.ч. с делегированием EIP-7702) в ответ не попадают
  async getContractCreators(addresses: string[]): Promise<Map<string, string>> {
    const creators = new Map<string, string>()
    const chunks: string[][] = []
    for (let i = 0; i < addresses.length; i += 5) chunks.push(addresses.slice(i, i + 5))

    await Promise.all(chunks.map(async chunk => {
      const data = await this.request<{ contractAddress: string; contractCreator: string }[] | string | null>({
        module: 'contract', action: 'getcontractcreation', contractaddresses: chunk.join(','),
      })
      if (data.status === '1' && Array.isArray(data.result)) {
        data.result.forEach(r => creators.set(r.contractAddress.toLowerCase(), r.contractCreator?.toLowerCase() ?? ''))
      } else if (data.message !== 'No data found') {
        console.log(`  [Contracts] ошибка проверки ${chunk.length} адресов: ${data.message} ${JSON.stringify(data.result)}`)
      }
    }))
    return creators
  }

  // Адреса с 10 000+ обычных tx: у такого адреса существует 10 000-я tx (page=10000, offset=1 —
  // ответ из одной записи). Так ведут себя биржи, маркет-мейкеры и боты, а не частные кошельки.
  async getHighActivity(addresses: string[]): Promise<Set<string>> {
    const busy = new Set<string>()
    await Promise.all(addresses.map(async addr => {
      const data = await this.request<EtherscanTransaction[] | string>({
        module: 'account', action: 'txlist', address: addr,
        startblock: '0', endblock: '99999999', sort: 'desc', page: '10000', offset: '1',
      })
      if (data.status === '1' && Array.isArray(data.result) && data.result.length > 0) busy.add(addr)
    }))
    return busy
  }

  private async fetchPage(params: Record<string, string>, page: number): Promise<EtherscanTransaction[]> {
    const data = await this.request<EtherscanTransaction[] | string>({ ...params, page: String(page), offset: String(CONFIG.pageSize) })
    if (data.status !== '1' || !Array.isArray(data.result)) return []
    return data.result
  }

  // Etherscan отдаёт максимум 1000 tx за запрос и не дальше 10 000-й записи (page × offset ≤ 10000).
  // Чтобы снять лимит, идём окнами по 10 страниц от новых блоков к старым: страницы окна
  // качаются параллельно, следующее окно заканчивается на блоке последней полученной tx.
  // Транзакции граничного блока приходят дважды — убираем дубли по hash.
  //
  // Конец истории — ПУСТАЯ страница, а не неполная: Etherscan иногда отдаёт 999 записей
  // на странице, за которой есть ещё (так у TLM обрывалось на 999 переводах из 10 000).
  private async fetchByBlocks(params: Record<string, string>, maxTx: number): Promise<EtherscanTransaction[]> {
    const PAGES_PER_WINDOW = Math.floor(10_000 / CONFIG.pageSize)
    const all: EtherscanTransaction[] = []
    const seen = new Set<string>()
    let endBlock = 99_999_999

    while (all.length < maxTx) {
      const windowParams = { ...params, startblock: '0', endblock: String(endBlock), sort: 'desc' }
      const pages = await Promise.all(
        Array.from({ length: PAGES_PER_WINDOW }, (_, i) => this.fetchPage(windowParams, i + 1)),
      )

      let added = 0
      let last: EtherscanTransaction | undefined
      let complete = true
      for (const page of pages) {
        if (page.length === 0) { complete = false; break }
        for (const tx of page) {
          last = tx
          if (seen.has(tx.hash)) continue
          seen.add(tx.hash)
          all.push(tx)
          added++
        }
      }
      console.log(`  Блоки ≤ ${endBlock}: +${added} tx (всего ${all.length})`)

      // Пустая страница — история закончилась. Нет прогресса — всё окно в одном блоке, дальше не сдвинуться.
      if (!complete || !last || added === 0) break
      const lastBlock = Number(last.blockNumber)
      if (lastBlock >= endBlock) break
      endBlock = lastBlock
    }

    console.log(`  Итого: ${all.length} транзакций`)
    return all.slice(0, maxTx)
  }

  // Страницы качаются пачками по 10 параллельно (темп держит общая очередь request),
  // результат — как при последовательной загрузке: страницы по порядку до первой пустой
  // (не неполной: Etherscan иногда отдаёт 999 записей посреди истории).
  private async fetchAllPages(params: Record<string, string>): Promise<EtherscanTransaction[]> {
    const PARALLEL_PAGES = 10
    // Дальше 10 000-й записи Etherscan не отдаёт (page × offset ≤ 10000) — такие страницы не запрашиваем
    const maxPages = Math.min(CONFIG.maxPages, Math.floor(10_000 / CONFIG.pageSize))
    const all: EtherscanTransaction[] = []
    for (let first = 1; first <= maxPages; first += PARALLEL_PAGES) {
      const last = Math.min(first + PARALLEL_PAGES - 1, maxPages)
      console.log(`  Страницы ${first}–${last}/${maxPages} (по ${CONFIG.pageSize} tx)...`)
      const pages = await Promise.all(
        Array.from({ length: last - first + 1 }, (_, i) => this.fetchPage(params, first + i)),
      )
      const empty = pages.findIndex(p => p.length === 0)
      pages.slice(0, empty === -1 ? pages.length : empty).forEach(p => all.push(...p))
      if (empty !== -1) {
        console.log(`  Страница ${first + empty} пустая — данные закончились`)
        break
      }
    }
    console.log(`  Итого: ${all.length} транзакций`)
    return all
  }

  private async fetchWithCache(cacheKey: string, load: () => Promise<EtherscanTransaction[]>): Promise<EtherscanTransaction[]> {
    const cached = this.txCache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAt < CONFIG.cacheTtlMs) {
      console.log(`  Кэш HIT: ${cacheKey} (${cached.data.length} tx)`)
      return cached.data
    }
    console.log(`  Кэш MISS: ${cacheKey}`)
    const data = await load()
    this.txCache.set(cacheKey, { data, cachedAt: Date.now() })
    return data
  }

  // Вся история кошелька (без лимита 10 000), не больше PAGE_SIZE × MAX_PAGES самых свежих tx
  async getWalletTransactions(address: string): Promise<EtherscanTransaction[]> {
    return this.fetchWithCache(`wallet:${address.toLowerCase()}`, () => this.fetchByBlocks({
      module: 'account', action: 'txlist', address,
    }, CONFIG.pageSize * CONFIG.maxPages))
  }

  // Последние tx кошелька одним запросом — для 2-го хопа
  async getRecentWalletTransactions(address: string, limit = CONFIG.pageSize): Promise<EtherscanTransaction[]> {
    return this.fetchWithCache(`wallet-recent:${address.toLowerCase()}`, async () => {
      const data = await this.request<EtherscanTransaction[] | string>({
        module: 'account', action: 'txlist', address,
        startblock: '0', endblock: '99999999', sort: 'desc', page: '1', offset: String(limit),
      })
      return data.status === '1' && Array.isArray(data.result) ? data.result : []
    })
  }

  async getTokenTransactions(contractAddress: string): Promise<EtherscanTransaction[]> {
    return this.fetchWithCache(`token:${contractAddress.toLowerCase()}`, () => this.fetchAllPages({
      module: 'account', action: 'tokentx',
      contractaddress: contractAddress, startblock: '0', endblock: '99999999', sort: 'desc',
    }))
  }
}
