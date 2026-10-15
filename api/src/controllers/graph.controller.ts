import { Controller, Get, Param, Res } from '@nestjs/common'
import type { Response } from 'express'
import { CONFIG } from '../config'
import { CEX_ADDRESSES } from '../constants/cex-addresses'
import type { EtherscanTransaction, GrowthReadiness, MarkovPhase, ClusterInfo } from '../types'
import { ClusterService } from '../services/cluster.service'
import { AnalyticsService } from '../services/analytics.service'
import { EtherscanService } from '../services/etherscan.service'
import { GraphBuilderService } from '../services/graph-builder.service'
import { ModelService } from '../services/model.service'
import { txAmount } from '../lib/amount'

// ===== КОНТРОЛЛЕР =====

@Controller()
export class GraphController {
  constructor(
    private etherscanService: EtherscanService,
    private graphBuilderService: GraphBuilderService,
    private clusterService: ClusterService,
    private analyticsService: AnalyticsService,
    private modelService: ModelService,
  ) {}

  @Get('/health')
  getHealth() {
    return {
      status:          'ok',
      apiVersion:      'Etherscan V2',
      apiKey:          CONFIG.etherscanApiKey ? 'connected' : 'missing',
      // Обычный режим
      pageSize:        CONFIG.pageSize,
      maxPages:        CONFIG.maxPages,
      maxTx:           CONFIG.pageSize * CONFIG.maxPages,
      cacheTtlMin:     CONFIG.cacheTtlMs / 60_000,
      // Полное сканирование
      fullPageSize:    CONFIG.fullPageSize,
      fullMaxPages:    CONFIG.fullMaxPages === 0 ? 'unlimited' : CONFIG.fullMaxPages,
      fullMaxTx:       CONFIG.fullMaxPages === 0 ? 'unlimited' : CONFIG.fullPageSize * CONFIG.fullMaxPages,
      fullDelayMs:     CONFIG.fullDelayMs,
      fullCacheTtlMin: CONFIG.fullCacheTtl / 60_000,
      cexAddresses:    CEX_ADDRESSES.size,
      timestamp:       new Date().toISOString(),
    }
  }

  private async buildAndReturn(
    txInput: EtherscanTransaction[],
    ethPriceUsd: number,
    meta: Record<string, unknown>,
    opts: { rootAddress?: string } = {},   // rootAddress — режим кошелька: балансы всех адресов + капитализация
  ) {
    const root = opts.rootAddress?.toLowerCase()
    let transactions = txInput
    if (!transactions.length) return { nodes: [], links: [], ...meta }

    // ── Предфильтрация транзакций ─────────────────────────────────────
    // Применяем до любого анализа — сокращает объём данных в 2–5 раз
    const isCex = (addr: string) => CEX_ADDRESSES.has(addr?.toLowerCase())

    let filtered = transactions

    // 1. Убираем дубли по hash
    const seenHash = new Set<string>()
    filtered = filtered.filter(tx => {
      if (seenHash.has(tx.hash)) return false
      seenHash.add(tx.hash)
      return true
    })

    // 2. Убираем нулевые транзакции (value = 0 — служебные вызовы контрактов)
    filtered = filtered.filter(tx => tx.value && tx.value !== '0')

    // 3. Убираем CEX→CEX переводы (не несут информации о реальных держателях)
    filtered = filtered.filter(tx => !(isCex(tx.from) && isCex(tx.to)))

    // 4. Для наборов > 30000 tx — берём только последние 30000 (самые свежие)
    //    Старые транзакции менее релевантны для текущего состояния держателей
    const MAX_TX_FOR_ANALYSIS = 30000
    if (filtered.length > MAX_TX_FOR_ANALYSIS) {
      // Сортируем по времени desc, берём свежие
      const byTimeDesc = (a: EtherscanTransaction, b: EtherscanTransaction) => Number(b.timeStamp) - Number(a.timeStamp)
      if (root) {
        // Режим кошелька: 2-й хоп получает до трети лимита, остальное — свежие tx самого кошелька.
        // Иначе длинная история кошелька целиком вытеснила бы 2-й хоп (или наоборот)
        const isRootTx = (tx: EtherscanTransaction) =>
          tx.from?.toLowerCase() === root || tx.to?.toLowerCase() === root
        const hop2 = filtered.filter(tx => !isRootTx(tx)).sort(byTimeDesc).slice(0, Math.floor(MAX_TX_FOR_ANALYSIS / 3))
        const own  = filtered.filter(isRootTx).sort(byTimeDesc).slice(0, MAX_TX_FOR_ANALYSIS - hop2.length)
        filtered = [...own, ...hop2]
      } else {
        filtered = filtered.sort(byTimeDesc).slice(0, MAX_TX_FOR_ANALYSIS)
      }
      console.log(`  [Filter] Ограничено до ${MAX_TX_FOR_ANALYSIS} свежих tx`)
    }

    console.log(`  [Filter] ${transactions.length} → ${filtered.length} tx (убрано дублей, нулей, CEX→CEX)`)

    // Используем отфильтрованные транзакции для всего анализа
    transactions = filtered

    // ── Топ-15 активных адресов — запрашиваем реальные балансы ───────
    const addrCount = new Map<string, number>()
    transactions.forEach(tx => {
      const f = tx.from?.toLowerCase()
      const t = tx.to?.toLowerCase()
      if (f) addrCount.set(f, (addrCount.get(f) || 0) + 1)
      if (t) addrCount.set(t, (addrCount.get(t) || 0) + 1)
    })

    // Для больших наборов ограничиваем граф топ-2000 активных адресов
    const MAX_NODES = 2000
    let txForGraph = transactions
    if (transactions.length > 10000) {
      const topSet = new Set(
        [...addrCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_NODES).map(([a]) => a)
      )
      // Оба конца в топе: с «||» хаб (сам кошелёк) протаскивал в граф всех своих контрагентов
      txForGraph = transactions.filter(tx =>
        topSet.has(tx.from?.toLowerCase()) && topSet.has(tx.to?.toLowerCase())
      )
      console.log(`  [Opt] Граф ограничен топ-${MAX_NODES} адресами (${txForGraph.length} tx из ${transactions.length})`)
    }

    // ── Реальные балансы ──────────────────────────────────────────────
    // Режим кошелька: балансы всех адресов графа — нужны для капитализации.
    // Режим токена: только топ-15 активных адресов.
    let balanceAddresses: string[]
    if (root) {
      const graphAddrs = new Set<string>()
      txForGraph.forEach(tx => {
        if (tx.from) graphAddrs.add(tx.from.toLowerCase())
        if (tx.to)   graphAddrs.add(tx.to.toLowerCase())
      })
      balanceAddresses = [...graphAddrs].filter(addr => !CEX_ADDRESSES.has(addr))
    } else {
      balanceAddresses = [...addrCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([addr]) => !CEX_ADDRESSES.has(addr))
        .slice(0, 15)
        .map(([addr]) => addr)
    }

    console.log(`  Запрашиваем балансы ${balanceAddresses.length} адресов (без CEX)...`)
    const realBalances = await this.etherscanService.getBalances(balanceAddresses)
    if (!root) {
      realBalances.forEach((bal, addr) =>
        console.log(`    ${addr.slice(0, 10)}... = ${bal.toFixed(4)} ETH = $${(bal * ethPriceUsd).toFixed(2)}`))
    }

    console.log('  Запускаем K-means + Union-Find кластеризацию...')
    // Для больших наборов (>20000 tx) пропускаем GR/Markov для одиночных адресов
    const skipAnalytics = transactions.length > 10000
    if (skipAnalytics) console.log('  [Opt] Большой набор — GR/Markov только для кластеров')
    const clusterMap = this.clusterService.buildClusters(transactions, realBalances, ethPriceUsd, this.analyticsService, skipAnalytics)
    const graph = this.graphBuilderService.buildGraph(txForGraph, realBalances, ethPriceUsd, clusterMap)

    const capitalization = root
      ? await this.computeCapitalization(root, balanceAddresses, transactions, realBalances, clusterMap, ethPriceUsd)
      : undefined

    // Топ кластеров для сводки
    const seen = new Set<string>()
    const topClusters: {
      clusterId: string; size: number; role: string; archetype: string;
      signals: string[]; totalUsd: number;
      gr: GrowthReadiness; markov: MarkovPhase
    }[] = []
    clusterMap.forEach(info => {
      if (!seen.has(info.clusterId) && info.addresses.length > 1) {
        seen.add(info.clusterId)
        topClusters.push({
          clusterId:  info.clusterId,
          size:       info.addresses.length,
          role:       info.role,
          archetype:  info.archetype,
          signals:    info.signals,
          totalUsd:   Math.round(info.totalUsd),
          gr:         info.gr,
          markov:     info.markov,
        })
      }
    })
    topClusters.sort((a, b) => b.size - a.size)

    return {
      ...meta,
      ethPriceUsd,
      totalTransactions: transactions.length,
      nodesCount:        graph.nodes.length,
      linksCount:        graph.links.length,
      exchangeNodes:     graph.nodes.filter(n => n.isExchange).length,
      clusterCount:      topClusters.length,
      topClusters:       topClusters.slice(0, 20),
      ...(capitalization && { capitalization }),
      ...graph,
    }
  }

  // ── Капитализация группы кошелька (ETH-балансы × курс) ────────────
  // full    — все адреса графа (кошелёк + 1-й и 2-й хоп)
  // cluster — кластер самого кошелька (адреса, которые Union-Find считает одним владельцем)
  // В обоих вариантах исключены биржи (CEX_ADDRESSES) и смарт-контракты: на WETH, мостах,
  // стейкинге лежат миллиарды чужих средств — они не принадлежат группе.
  private async computeCapitalization(
    root: string,
    graphAddresses: string[],
    transactions: EtherscanTransaction[],
    realBalances: Map<string, number>,
    clusterMap: Map<string, ClusterInfo>,
    ethPriceUsd: number,
  ) {
    // Отправитель обычной tx — всегда кошелёк (EOA): контракты сами tx не инициируют
    const knownEoa = new Set<string>()
    transactions.forEach(tx => { if (tx.from) knownEoa.add(tx.from.toLowerCase()) })

    const clusterAddresses = (clusterMap.get(root)?.addresses ?? [root])
      .map(a => a.toLowerCase())
      .filter(a => !CEX_ADDRESSES.has(a))
    const missing = clusterAddresses.filter(a => !realBalances.has(a))
    if (missing.length) {
      (await this.etherscanService.getBalances(missing)).forEach((bal, addr) => realBalances.set(addr, bal))
    }

    // На контракт проверяем адреса с ненулевым балансом, про которые не известно, что это EOA.
    // Берём не больше 250 самых крупных — мелочь на сумму почти не влияет, а запросы дорогие.
    const MAX_CONTRACT_CHECKS = 250
    const toCheck = [...new Set([...graphAddresses, ...clusterAddresses])]
      .filter(a => !knownEoa.has(a) && (realBalances.get(a) ?? 0) > 0)
      .sort((a, b) => (realBalances.get(b) ?? 0) - (realBalances.get(a) ?? 0))
      .slice(0, MAX_CONTRACT_CHECKS)
    const contracts = await this.etherscanService.getContracts(toCheck)

    // Крупные кошельки с 10 000+ tx — горячие кошельки бирж вне CEX_ADDRESSES, маркет-мейкеры, боты.
    // Их баланс — деньги клиентов, а не группы. Сам исследуемый кошелёк не исключаем никогда.
    const MIN_SERVICE_CHECK_ETH = 10
    const MAX_SERVICE_CHECKS    = 100
    const serviceCandidates = [...new Set([...graphAddresses, ...clusterAddresses])]
      .filter(a => a !== root && !contracts.has(a) && (realBalances.get(a) ?? 0) >= MIN_SERVICE_CHECK_ETH)
      .sort((a, b) => (realBalances.get(b) ?? 0) - (realBalances.get(a) ?? 0))
      .slice(0, MAX_SERVICE_CHECKS)
    const services = await this.etherscanService.getHighActivity(serviceCandidates)

    const isGroupMember = (a: string) => !contracts.has(a) && !services.has(a)
    const sumEth = (addrs: string[]) => addrs.reduce((s, a) => s + (realBalances.get(a) ?? 0), 0)
    const fullAddrs    = graphAddresses.filter(isGroupMember)
    const clusterAddrs = clusterAddresses.filter(isGroupMember)
    const fullEth      = sumEth(fullAddrs)
    const clusterEth   = sumEth(clusterAddrs)

    console.log(`  [Cap] полная: ${fullAddrs.length} адресов = ${fullEth.toFixed(2)} ETH = $${(fullEth * ethPriceUsd).toFixed(0)}`)
    console.log(`  [Cap] кластер: ${clusterAddrs.length} адресов = ${clusterEth.toFixed(2)} ETH = $${(clusterEth * ethPriceUsd).toFixed(0)}`)
    console.log(`  [Cap] исключено: контрактов ${contracts.size} (проверено ${toCheck.length}),` +
      ` сервисных кошельков 10k+ tx ${services.size} (проверено ${serviceCandidates.length})`)

    return {
      fullUsd:           Math.round(fullEth * ethPriceUsd),
      fullEth,
      fullAddresses:     fullAddrs.length,
      clusterUsd:        Math.round(clusterEth * ethPriceUsd),
      clusterEth,
      clusterAddresses:  clusterAddrs.length,
      excludedContracts: contracts.size,
      excludedServices:  services.size,
    }
  }

  // ── 2-й хоп: топ-50 контрагентов кошелька по объёму ETH ──────────
  // Биржи и смарт-контракты не раскрываем: история DEX-роутера или WETH —
  // это тысячи чужих пользователей, к группе кошелька они отношения не имеют.
  private async selectHop2Counterparties(root: string, rootTx: EtherscanTransaction[]): Promise<string[]> {
    const HOP2_LIMIT = 50
    const volume   = new Map<string, number>()
    const knownEoa = new Set<string>()
    for (const tx of rootTx) {
      const from = tx.from?.toLowerCase()
      const to   = tx.to?.toLowerCase()
      if (from) knownEoa.add(from)
      const other = from === root ? to : from
      if (!other || other === root || CEX_ADDRESSES.has(other)) continue
      volume.set(other, (volume.get(other) || 0) + txAmount(tx))
    }

    const ranked = [...volume.entries()]
      .filter(([, eth]) => eth > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([addr]) => addr)

    // Идём по рейтингу пачками и отсеиваем контракты, пока не наберём 50 кошельков
    const picked: string[] = []
    for (let i = 0; i < ranked.length && picked.length < HOP2_LIMIT; i += HOP2_LIMIT) {
      const batch     = ranked.slice(i, i + HOP2_LIMIT)
      const contracts = await this.etherscanService.getContracts(batch.filter(a => !knownEoa.has(a)))
      for (const addr of batch) {
        if (!contracts.has(addr) && picked.length < HOP2_LIMIT) picked.push(addr)
      }
    }
    return picked
  }

  @Get('/graph/wallet/:address')
  async getWalletGraph(@Param('address') address: string) {
    console.log('\n--- Граф кошелька:', address)
    const root = address.toLowerCase()
    const [rootTx, ethPriceUsd] = await Promise.all([
      this.etherscanService.getWalletTransactions(address),
      this.etherscanService.getEthPriceUsd(),
    ])

    // 2-й хоп: последние PAGE_SIZE tx каждого из топ-50 контрагентов
    const hop2 = await this.selectHop2Counterparties(root, rootTx)
    const hop2Tx = (await Promise.all(hop2.map(addr =>
      this.etherscanService.getRecentWalletTransactions(addr).catch(err => {
        console.log(`  [Hop2] ${addr.slice(0, 10)}... ошибка: ${err}`)
        return [] as EtherscanTransaction[]
      }),
    ))).flat()
    console.log(`  [Hop2] ${hop2.length} контрагентов → +${hop2Tx.length} tx`)

    return this.buildAndReturn([...rootTx, ...hop2Tx], ethPriceUsd, {
      address,
      hops:            2,
      hop1Tx:          rootTx.length,
      hop2Wallets:     hop2.length,
    }, { rootAddress: root })
  }

  @Get('/graph/token/:address')
  async getTokenGraph(@Param('address') address: string) {
    console.log('\n--- Граф токена:', address)
    const [transactions, ethPriceUsd] = await Promise.all([
      this.etherscanService.getTokenTransactions(address),
      this.etherscanService.getEthPriceUsd(),
    ])
    const ticker = transactions[0]?.tokenSymbol || 'UNKNOWN'
    return this.buildAndReturn(transactions, ethPriceUsd, { tokenAddress: address, ticker })
  }

  // ── Накопительный режим (SSE) ────────────────────────────────────
  // GET /graph/token/:address/full
  // Качает ВСЕ транзакции постранично, стримит прогресс через SSE,
  // накапливает в памяти, по завершению строит граф и отдаёт результат.
  //
  // SSE события:
  //   {type:'progress', page, loaded, eta}   — прогресс загрузки
  //   {type:'analyzing'}                      — начало анализа
  //   {type:'done', ...graph}                 — готовый граф
  //   {type:'error', message}                 — ошибка

  // Накопительный кэш: address → транзакции (живёт пока API запущен)
  private fullTxCache = new Map<string, {
    transactions: EtherscanTransaction[]
    cachedAt:     number
    ticker:       string
  }>()
  private get FULL_CACHE_TTL() { return CONFIG.fullCacheTtl }

  @Get('/graph/token/:address/full')
  async getTokenGraphFull(
    @Param('address') address: string,
    @Res() res: Response,
  ) {
    console.log('\n--- Накопительный граф токена:', address)

    // SSE заголовки
    res.setHeader('Content-Type',  'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection',    'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders()

    const send = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    try {
      // Проверяем кэш
      const cached = this.fullTxCache.get(address.toLowerCase())
      let transactions: EtherscanTransaction[]
      let ticker = 'UNKNOWN'

      if (cached && Date.now() - cached.cachedAt < this.FULL_CACHE_TTL) {
        console.log(`  [Full] Кэш HIT: ${address.slice(0, 10)}... (${cached.transactions.length} tx)`)
        send({ type: 'progress', page: 0, loaded: cached.transactions.length, cached: true, message: 'Данные из кэша' })
        transactions = cached.transactions
        ticker       = cached.ticker
      } else {
        // Постраничная загрузка — качаем все страницы
        transactions = []
        const PAGE_SIZE = CONFIG.fullPageSize
        const DELAY_MS  = CONFIG.fullDelayMs
        const MAX_PAGES = CONFIG.fullMaxPages  // 0 = без ограничений
        let pageNum     = 1
        let hasMore     = true
        // Etherscan ограничивает пагинацию до 10 страниц.
        // Обходим через startblock/endblock: каждый следующий запрос
        // начинается с блока последней полученной транзакции.
        let startBlock  = 0
        const endBlock  = 999999999

        while (hasMore && (MAX_PAGES === 0 || pageNum <= MAX_PAGES)) {
          const url = `https://api.etherscan.io/v2/api?chainid=${CONFIG.etherscanChainId}&apikey=${CONFIG.etherscanApiKey}&module=account&action=tokentx&contractaddress=${address}&startblock=${startBlock}&endblock=${endBlock}&sort=asc&page=1&offset=${PAGE_SIZE}`

          const resp = await fetch(url)
          const data = await resp.json() as { status: string; result: EtherscanTransaction[] | string }

          if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
            hasMore = false
            break
          }

          // Дедупликация — последняя tx предыдущего батча = первая следующего
          const newTxs = transactions.length > 0
            ? data.result.filter(tx => tx.hash !== transactions[transactions.length - 1]?.hash)
            : data.result

          transactions.push(...newTxs)
          if (!ticker && data.result[0]?.tokenSymbol) ticker = data.result[0].tokenSymbol

          send({
            type:    'progress',
            page:    pageNum,
            loaded:  transactions.length,
            perPage: PAGE_SIZE,
            message: `Загружено ${transactions.length.toLocaleString()} транзакций...`,
          })

          console.log(`  [Full] Батч ${pageNum}: +${newTxs.length} tx (блоки ${startBlock}–${endBlock}), итого ${transactions.length}`)

          if (data.result.length < PAGE_SIZE) {
            hasMore = false  // последняя страница — данные закончились
          } else {
            // Следующий запрос — начиная с блока последней tx этого батча
            const lastBlock = Number(data.result[data.result.length - 1].blockNumber)
            if (lastBlock <= startBlock) {
              hasMore = false  // защита от зависания
            } else {
              startBlock = lastBlock  // включительно — дедупликация выше уберёт дубль
              pageNum++
              await new Promise(r => setTimeout(r, DELAY_MS))
            }
          }
        }

        // Сохраняем в кэш
        this.fullTxCache.set(address.toLowerCase(), {
          transactions,
          cachedAt: Date.now(),
          ticker,
        })
        console.log(`  [Full] Загрузка завершена: ${transactions.length} tx, кэш сохранён`)
      }

      // Анализ
      send({ type: 'analyzing', loaded: transactions.length, message: 'Запускаем анализ кластеров...' })

      const ethPriceUsd = await this.etherscanService.getEthPriceUsd()
      const result      = await this.buildAndReturn(transactions, ethPriceUsd, {
        tokenAddress: address,
        ticker,
        fullLoad: true,
      })

      send({ type: 'done', ...result })
      console.log(`  [Full] Готово: ${result.nodes.length} узлов, ${result.links.length} рёбер`)

    } catch (err) {
      console.error('  [Full] Ошибка:', err)
      send({ type: 'error', message: String(err) })
    }

    res.end()
  }

  // ── Шаг 4: LSTM предсказание ──────────────────────────────────────

  // GET /predict/:symbol — обучить и предсказать (кэш 30 мин)
  // Примеры: /predict/ETH  /predict/DODO  /predict/BTC
  @Get('/predict/:symbol')
  async predict(@Param('symbol') symbol: string) {
    console.log('\n--- LSTM predict:', symbol)
    try {
      return await this.modelService.predict(symbol)
    } catch (err) {
      return { error: String(err), symbol }
    }
  }

  // GET /predict/:symbol/retrain — принудительно переобучить
  @Get('/predict/:symbol/retrain')
  async retrain(@Param('symbol') symbol: string) {
    console.log('\n--- LSTM retrain:', symbol)
    try {
      return await this.modelService.predict(symbol, true)
    } catch (err) {
      return { error: String(err), symbol }
    }
  }
}
