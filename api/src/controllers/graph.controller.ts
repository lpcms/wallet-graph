import { Controller, Get, Param, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { CONFIG } from '../config'
import { KNOWN_ADDRESSES, SERVICE_ADDRESSES } from '../constants/known-addresses'
import type { EtherscanTransaction, GrowthReadiness, MarkovPhase, ClusterInfo } from '../types'
import { ClusterService } from '../services/cluster.service'
import { AnalyticsService } from '../services/analytics.service'
import { EtherscanService } from '../services/etherscan.service'
import { GraphBuilderService } from '../services/graph-builder.service'
import { ModelService } from '../services/model.service'
import { PriceService } from '../services/price.service'
import { HopExpansionService, clampHops, clampWidth } from '../services/hop-expansion.service'
import { ZERO_ADDRESS, type EntityHints } from '../lib/entities'
import { thresholdsFor } from '../lib/thresholds'
import { hopDistances } from '../lib/hops'
import { isTokenTransfer } from '../lib/amount'

// ===== КОНТРОЛЛЕР =====

@Controller()
export class GraphController {
  constructor(
    private etherscanService: EtherscanService,
    private graphBuilderService: GraphBuilderService,
    private clusterService: ClusterService,
    private analyticsService: AnalyticsService,
    private modelService: ModelService,
    private priceService: PriceService,
    private hopExpansionService: HopExpansionService,
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
      knownAddresses:  KNOWN_ADDRESSES.size,
      serviceAddresses: SERVICE_ADDRESSES.size,
      timestamp:       new Date().toISOString(),
    }
  }

  private async buildAndReturn(
    txInput: EtherscanTransaction[],
    ethPriceUsd: number,
    meta: Record<string, unknown>,
    // rootAddress — режим кошелька: балансы всех адресов + капитализация;
    // tokenAddress — режим токена: эмитент и создатель токена для категорий узлов;
    // keepAddresses — раскрытые хопы: не выпадают из графа при обрезке до MAX_NODES
    // txSteps — на каком шаге раскрытия хопов загружена каждая транзакция (hash → шаг)
    opts: { rootAddress?: string; tokenAddress?: string; keepAddresses?: Set<string>; txSteps?: Map<string, number> } = {},
  ) {
    const root = opts.rootAddress?.toLowerCase()
    let transactions = txInput
    if (!transactions.length) return { nodes: [], links: [], ...meta }

    // ── Предфильтрация транзакций ─────────────────────────────────────
    // Применяем до любого анализа — сокращает объём данных в 2–5 раз
    const isCex = (addr: string) => SERVICE_ADDRESSES.has(addr?.toLowerCase())

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
        // Режим кошелька: хопы получают до трети лимита, остальное — свежие tx самого кошелька.
        // Иначе длинная история кошелька целиком вытеснила бы хопы (или наоборот).
        // Среди tx хопов первыми идут переводы между раскрытыми адресами — сама цепочка хопов
        const keep = opts.keepAddresses ?? new Set<string>()
        const isRootTx = (tx: EtherscanTransaction) =>
          tx.from?.toLowerCase() === root || tx.to?.toLowerCase() === root
        const isChain = (tx: EtherscanTransaction) => keep.has(tx.from?.toLowerCase()) && keep.has(tx.to?.toLowerCase())
        const hops = filtered.filter(tx => !isRootTx(tx))
          .sort((a, b) => Number(isChain(b)) - Number(isChain(a)) || byTimeDesc(a, b))
          .slice(0, Math.floor(MAX_TX_FOR_ANALYSIS / 3))
        const own  = filtered.filter(isRootTx).sort(byTimeDesc).slice(0, MAX_TX_FOR_ANALYSIS - hops.length)
        filtered = [...own, ...hops]
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
      // + раскрытые хопы: малоактивные адреса дальних хопов иначе выпали бы из графа
      const topSet = new Set([
        ...[...addrCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_NODES).map(([a]) => a),
        ...(opts.keepAddresses ?? []),
      ])
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
      balanceAddresses = [...graphAddrs].filter(addr => !SERVICE_ADDRESSES.has(addr))
    } else {
      balanceAddresses = [...addrCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([addr]) => !SERVICE_ADDRESSES.has(addr))
        .slice(0, 15)
        .map(([addr]) => addr)
    }

    console.log(`  Запрашиваем балансы ${balanceAddresses.length} адресов (без CEX)...`)
    const realBalances = await this.etherscanService.getBalances(balanceAddresses)
    if (!root) {
      realBalances.forEach((bal, addr) =>
        console.log(`    ${addr.slice(0, 10)}... = ${bal.toFixed(4)} ETH = $${(bal * ethPriceUsd).toFixed(2)}`))
    }

    // ── Контракты и сервисные кошельки — до кластеризации ─────────────
    // Они нужны и для категорий узлов, и чтобы исключить их из кластеров «одного владельца»:
    // через пул DEX проходят сделки тысяч посторонних людей, их нельзя склеивать с кошельками
    const entityHints = root
      ? await this.detectWalletHints(root, balanceAddresses, transactions, realBalances)
      : await this.collectTokenHints(opts.tokenAddress, addrCount)
    const excluded = new Set([...(entityHints.contracts ?? []), ...(entityHints.services ?? [])])

    // Цена актива: пороги эвристик (пыль, «общий источник») заданы в долларах и переводятся
    // в штуки актива по ней. Граф кошелька — ETH по курсу ETH, граф токена — цена с Binance.
    const assetSymbol   = opts.tokenAddress ? transactions.find(isTokenTransfer)?.tokenSymbol : 'ETH'
    const assetPriceUsd = opts.tokenAddress ? await this.priceService.getTokenPriceUsd(assetSymbol) : ethPriceUsd
    const thresholds    = thresholdsFor(assetPriceUsd)

    console.log('  Запускаем K-means + Union-Find кластеризацию...')
    // Для больших наборов (>20000 tx) пропускаем GR/Markov для одиночных адресов
    const skipAnalytics = transactions.length > 10000
    if (skipAnalytics) console.log('  [Opt] Большой набор — GR/Markov только для кластеров')
    const clusterMap = this.clusterService.buildClusters(
      transactions, realBalances, ethPriceUsd, this.analyticsService, skipAnalytics, excluded, thresholds,
    )

    // Число переводов от кошелька до каждого адреса — по тем же связям, что войдут в граф
    const distances = root
      ? hopDistances(txForGraph.filter(tx => tx.from && tx.to).map(tx => ({ sourceAddress: tx.from, targetAddress: tx.to })), root)
      : new Map<string, number>()

    const capitalization = root
      ? await this.computeCapitalization(root, balanceAddresses, realBalances, clusterMap, ethPriceUsd, entityHints, distances)
      : undefined

    const graph = this.graphBuilderService.buildGraph(txForGraph, realBalances, ethPriceUsd, clusterMap, entityHints, assetPriceUsd)

    // Номер хопа — расстояние от исследуемого кошелька по связям графа.
    // Шаг цепочки — самый ранний шаг раскрытия среди связей адреса в графе (не меньше расстояния)
    if (root) {
      const chainHops = new Map<string, number>([[root, 0]])
      for (const link of graph.links) {
        const step = opts.txSteps?.get(link.txId)
        if (step === undefined) continue
        for (const a of [link.sourceAddress.toLowerCase(), link.targetAddress.toLowerCase()]) {
          if (!chainHops.has(a) || chainHops.get(a)! > step) chainHops.set(a, step)
        }
      }
      chainHops.set(root, 0)
      graph.nodes.forEach(n => {
        n.hop      = distances.get(n.walletAddress.toLowerCase())
        n.chainHop = chainHops.get(n.walletAddress.toLowerCase())
      })
    }

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
      assetSymbol,
      assetPriceUsd,           // null — цена токена неизвестна, пороги эвристик в штуках токена
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

  // ── Контракты и сервисные кошельки в графе кошелька ───────────────
  // Отправитель обычной tx — всегда кошелёк (EOA): контракты сами tx не инициируют.
  // Остальные адреса с ненулевым балансом проверяем на контракт (250 самых крупных),
  // кошельки от 10 ETH — на 10 000+ tx (100 самых крупных): это горячие кошельки бирж
  // вне списка, маркет-мейкеры, боты. Сам исследуемый кошелёк не исключаем никогда.
  private async detectWalletHints(
    root: string,
    graphAddresses: string[],
    transactions: EtherscanTransaction[],
    realBalances: Map<string, number>,
  ): Promise<EntityHints> {
    const knownEoa = new Set<string>()
    transactions.forEach(tx => { if (tx.from) knownEoa.add(tx.from.toLowerCase()) })

    const MAX_CONTRACT_CHECKS = 250
    const toCheck = graphAddresses
      .filter(a => !knownEoa.has(a) && (realBalances.get(a) ?? 0) > 0)
      .sort((a, b) => (realBalances.get(b) ?? 0) - (realBalances.get(a) ?? 0))
      .slice(0, MAX_CONTRACT_CHECKS)
    const contracts = await this.etherscanService.getContracts(toCheck)

    const MIN_SERVICE_CHECK_ETH = 10
    const MAX_SERVICE_CHECKS    = 100
    const serviceCandidates = graphAddresses
      .filter(a => a !== root && !contracts.has(a) && (realBalances.get(a) ?? 0) >= MIN_SERVICE_CHECK_ETH)
      .sort((a, b) => (realBalances.get(b) ?? 0) - (realBalances.get(a) ?? 0))
      .slice(0, MAX_SERVICE_CHECKS)
    const services = await this.etherscanService.getHighActivity(serviceCandidates)

    // Проверенные кошельки: отправители обычных tx и проверенные адреса, оказавшиеся не контрактами
    const verified = new Set([...knownEoa, ...toCheck.filter(a => !contracts.has(a))])
    console.log(`  [Entities] контрактов ${contracts.size} (проверено ${toCheck.length}),` +
      ` сервисных кошельков 10k+ tx ${services.size} (проверено ${serviceCandidates.length})`)
    return { contracts, services, verified }
  }

  // ── Капитализация группы кошелька (ETH-балансы × курс) ────────────
  // near    — ближнее окружение: адреса не дальше NEAR_HOPS переводов от кошелька
  // all     — всё окружение: все адреса графа (на дальних хопах попадаются крупные
  //           холодные кошельки, поэтому эта сумма может быть в десятки раз больше)
  // cluster — кластер самого кошелька (адреса, которые Union-Find считает одним владельцем)
  // Везде исключены биржи (SERVICE_ADDRESSES), смарт-контракты и сервисные кошельки:
  // на WETH, мостах, стейкинге и биржах лежат миллиарды чужих средств — они не принадлежат группе.
  private async computeCapitalization(
    root: string,
    graphAddresses: string[],
    realBalances: Map<string, number>,
    clusterMap: Map<string, ClusterInfo>,
    ethPriceUsd: number,
    hints: EntityHints,
    distances: Map<string, number> = new Map(),   // число переводов от кошелька
  ) {
    const NEAR_HOPS = 2
    const contracts = hints.contracts ?? new Set<string>()
    const services  = hints.services  ?? new Set<string>()

    // Участники кластера могут быть вне графа (он ограничен 2000 адресами) — догружаем их балансы
    // и проверяем на контракт тех, кого ещё не проверяли
    const clusterAddresses = (clusterMap.get(root)?.addresses ?? [root])
      .map(a => a.toLowerCase())
      .filter(a => !SERVICE_ADDRESSES.has(a))
    const missing = clusterAddresses.filter(a => !realBalances.has(a))
    if (missing.length) {
      (await this.etherscanService.getBalances(missing)).forEach((bal, addr) => realBalances.set(addr, bal))
    }
    const unchecked = clusterAddresses.filter(a =>
      !hints.verified?.has(a) && !contracts.has(a) && (realBalances.get(a) ?? 0) > 0)
    if (unchecked.length) {
      (await this.etherscanService.getContracts(unchecked)).forEach(a => contracts.add(a))
    }

    const isGroupMember = (a: string) => !contracts.has(a) && !services.has(a)
    const sumEth = (addrs: string[]) => addrs.reduce((s, a) => s + (realBalances.get(a) ?? 0), 0)
    const allAddrs     = graphAddresses.filter(isGroupMember)
    const nearAddrs    = allAddrs.filter(a => a === root || (distances.get(a) ?? Infinity) <= NEAR_HOPS)
    const clusterAddrs = clusterAddresses.filter(isGroupMember)
    const allEth       = sumEth(allAddrs)
    const nearEth      = sumEth(nearAddrs)
    const clusterEth   = sumEth(clusterAddrs)

    console.log(`  [Cap] ближнее (до ${NEAR_HOPS} хопов): ${nearAddrs.length} адресов = ${nearEth.toFixed(2)} ETH = $${(nearEth * ethPriceUsd).toFixed(0)}`)
    console.log(`  [Cap] всё окружение: ${allAddrs.length} адресов = ${allEth.toFixed(2)} ETH = $${(allEth * ethPriceUsd).toFixed(0)}`)
    console.log(`  [Cap] кластер: ${clusterAddrs.length} адресов = ${clusterEth.toFixed(2)} ETH = $${(clusterEth * ethPriceUsd).toFixed(0)}`)

    return {
      nearHops:          NEAR_HOPS,
      nearUsd:           Math.round(nearEth * ethPriceUsd),
      nearEth,
      nearAddresses:     nearAddrs.length,
      allUsd:            Math.round(allEth * ethPriceUsd),
      allEth,
      allAddresses:      allAddrs.length,
      clusterUsd:        Math.round(clusterEth * ethPriceUsd),
      clusterEth,
      clusterAddresses:  clusterAddrs.length,
      excludedContracts: contracts.size,
      excludedServices:  services.size,
    }
  }

  // ── Категории владельцев в графе токена ───────────────────────────
  // Самые активные участники — пулы, роутеры и горячие кошельки бирж: проверяем
  // топ-100 на контракты и топ-20 кошельков на 10 000+ tx. Плюс эмитент: контракт
  // токена и его создатель. Остальные адреса считаются кошельками.
  private async collectTokenHints(tokenAddress: string | undefined, addrCount: Map<string, number>): Promise<EntityHints> {
    const MAX_CONTRACT_CHECKS = 100
    const MAX_SERVICE_CHECKS  = 20
    const token  = tokenAddress?.toLowerCase()
    const active = [...addrCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([addr]) => addr)
      .filter(addr => !KNOWN_ADDRESSES.has(addr) && addr !== ZERO_ADDRESS && addr !== token)

    const creators  = await this.etherscanService.getContractCreators([...(token ? [token] : []), ...active.slice(0, MAX_CONTRACT_CHECKS)])
    const contracts = new Set(creators.keys())
    const issuers   = new Map<string, string>()
    if (token) {
      issuers.set(token, 'контракт токена')
      const creator = creators.get(token)
      if (creator) issuers.set(creator, 'создатель токена')
    }
    const services = await this.etherscanService.getHighActivity(
      active.filter(addr => !contracts.has(addr)).slice(0, MAX_SERVICE_CHECKS),
    )
    // Проверенные кошельки — проверенные на контракт и им не оказавшиеся.
    // Отправитель перевода токена не доказывает EOA: токены рассылают и контракты (пулы, роутеры)
    const verified = new Set(active.slice(0, MAX_CONTRACT_CHECKS).filter(addr => !contracts.has(addr)))
    console.log(`  [Entities] контрактов ${contracts.size}, сервисных кошельков ${services.size}, эмитентов ${issuers.size}`)
    return { contracts, services, issuers, verified }
  }

  // ── Граф кошелька ─────────────────────────────────────────────────
  // hops — сколько хопов раскрывать (1–15), width — сколько адресов на каждом хопе (5–50).
  // По умолчанию 2 × 50 — как было до настройки хопов.
  private async buildWalletGraph(
    address: string,
    hopsParam: number,
    widthParam: number,
    onProgress: (p: { message: string; hop?: number; hops?: number; transactions?: number }) => void = () => {},
  ) {
    const root  = address.toLowerCase()
    const hops  = clampHops(hopsParam)
    const width = clampWidth(widthParam)
    console.log(`\n--- Граф кошелька: ${address} (хопов ${hops}, адресов на хоп ${width})`)

    onProgress({ message: 'Загружаем историю кошелька…', hop: 1, hops })
    const [rootTx, ethPriceUsd] = await Promise.all([
      this.etherscanService.getWalletTransactions(address),
      this.etherscanService.getEthPriceUsd(),
    ])
    onProgress({ message: `История кошелька: ${rootTx.length.toLocaleString('ru-RU')} транзакций`, hop: 1, hops, transactions: rootTx.length })

    const result = await this.hopExpansionService.expand(root, rootTx, hops, width, onProgress)
    onProgress({ message: 'Анализируем граф: балансы, контракты, кластеры…', hops, transactions: result.transactions.length })

    return this.buildAndReturn(result.transactions, ethPriceUsd, {
      address,
      hops,
      hopWidth:     width,
      reachedHop:   1 + result.expandedByHop.length,   // до какого хопа дошли цепочки
      hopWallets:   result.expandedByHop.map(a => a.length),
      hop1Tx:       rootTx.length,
    }, { rootAddress: root, keepAddresses: result.expanded, txSteps: result.txSteps })
  }

  @Get('/graph/wallet/:address')
  async getWalletGraph(
    @Param('address') address: string,
    @Query('hops') hops = '2',
    @Query('width') width = '50',
  ) {
    return this.buildWalletGraph(address, Number(hops), Number(width))
  }

  // То же с прогрессом через SSE: {type:'progress', message, hop, hops, transactions} → {type:'done', ...граф}
  @Get('/graph/wallet/:address/stream')
  async getWalletGraphStream(
    @Param('address') address: string,
    @Query('hops') hops = '2',
    @Query('width') width = '50',
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type',  'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection',    'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders()
    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)

    try {
      const graph = await this.buildWalletGraph(address, Number(hops), Number(width), p => send({ type: 'progress', ...p }))
      send({ type: 'done', ...graph })
    } catch (err) {
      console.error('  [Wallet] Ошибка:', err)
      send({ type: 'error', message: String(err) })
    }
    res.end()
  }

  @Get('/graph/token/:address')
  async getTokenGraph(@Param('address') address: string) {
    console.log('\n--- Граф токена:', address)
    const [transactions, ethPriceUsd] = await Promise.all([
      this.etherscanService.getTokenTransactions(address),
      this.etherscanService.getEthPriceUsd(),
    ])
    const ticker = transactions[0]?.tokenSymbol || 'UNKNOWN'
    return this.buildAndReturn(transactions, ethPriceUsd, { tokenAddress: address, ticker }, { tokenAddress: address })
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
        const seenTransfers = new Set<string>()
        const endBlock  = 999999999

        while (hasMore && (MAX_PAGES === 0 || pageNum <= MAX_PAGES)) {
          const url = `https://api.etherscan.io/v2/api?chainid=${CONFIG.etherscanChainId}&apikey=${CONFIG.etherscanApiKey}&module=account&action=tokentx&contractaddress=${address}&startblock=${startBlock}&endblock=${endBlock}&sort=asc&page=1&offset=${PAGE_SIZE}`

          const resp = await fetch(url)
          const data = await resp.json() as { status: string; result: EtherscanTransaction[] | string }

          if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
            hasMore = false
            break
          }

          // Дедупликация: транзакции граничного блока приходят в обоих батчах
          const newTxs = data.result.filter(tx => {
            const key = `${tx.hash}:${tx.from}:${tx.to}:${tx.value}`
            if (seenTransfers.has(key)) return false
            seenTransfers.add(key)
            return true
          })

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

          // Конец — пустой ответ (проверка выше) или батч без продвижения по блокам.
          // Неполный батч концом не считаем: Etherscan иногда отдаёт 999 записей посреди истории
          const lastBlock = Number(data.result[data.result.length - 1].blockNumber)
          if (newTxs.length === 0 || lastBlock <= startBlock) {
            hasMore = false
          } else {
            startBlock = lastBlock  // включительно — дедупликация выше уберёт дубли
            pageNum++
            await new Promise(r => setTimeout(r, DELAY_MS))
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
      }, { tokenAddress: address })

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
