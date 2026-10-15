import { Injectable } from '@nestjs/common'
import { CEX_ADDRESSES } from '../constants/cex-addresses'
import type { EtherscanTransaction, GrowthReadiness, MarkovPhase, ClusterInfo, AddressFeatures, BehaviorProfile } from '../types'
import { kmeans } from 'ml-kmeans'
import { txAmount } from '../lib/amount'
import { UnionFind } from '../lib/union-find'
import { AnalyticsService } from './analytics.service'

// Фиксированный seed: K-means выдаёт одни и те же группы при повторных запросах
const KMEANS_SEED = 42

// Признаки в порядке столбцов матрицы normalize(): [высокое значение, низкое значение]
const FEATURE_LABELS: [string, string][] = [
  ['много транзакций',              'мало транзакций'],
  ['в основном отправляет',         'в основном получает'],
  ['крупные переводы',              'мелкие переводы'],
  ['пылевые переводы',              'без пылевых переводов'],
  ['активен в разные часы',         'активен в узкое окно времени'],
  ['редкая активность',             'частая активность'],
  ['много контрагентов',            'мало контрагентов'],
  ['крупный баланс',                'малый баланс'],
]

// Пустые заглушки для GR и Markov (используются для одиночных адресов)
export function emptyGR(): GrowthReadiness {
  return { score: 0, level: 'COLD', label: 'Нет данных', components: { accumulationScore: 0, velocityScore: 0, balanceScore: 0, retentionScore: 0 } }
}
export function emptyMarkov(): MarkovPhase {
  return { currentPhase: 'INACTIVE', phaseHistory: [], transitions: [], nextPhaseProbabilities: [] }
}

// ===== СЕРВИС КЛАСТЕРИЗАЦИИ =====

@Injectable()
export class ClusterService {

  // ── Шаг 1: вычислить вектор фич для каждого адреса ──────────────────
  private buildFeatures(
    transactions: EtherscanTransaction[],
    realBalances: Map<string, number>,
  ): Map<string, AddressFeatures> {

    const isCex = (addr: string) => CEX_ADDRESSES.has(addr.toLowerCase())
    const result = new Map<string, AddressFeatures>()

    // Собираем транзакции по каждому адресу
    const byAddr = new Map<string, EtherscanTransaction[]>()
    transactions.forEach(tx => {
      if (!tx.from || !tx.to) return
      if (isCex(tx.from) || isCex(tx.to)) return
      ;[tx.from.toLowerCase(), tx.to.toLowerCase()].forEach(addr => {
        if (!byAddr.has(addr)) byAddr.set(addr, [])
        byAddr.get(addr)!.push(tx)
      })
    })

    byAddr.forEach((txs, address) => {
      const sends    = txs.filter(tx => tx.from?.toLowerCase() === address)
      const receives = txs.filter(tx => tx.to?.toLowerCase()   === address)
      const txCount  = txs.length

      // [1] Доля исходящих
      const sendRatio = txCount > 0 ? sends.length / txCount : 0

      // [2] Средний ETH на транзакцию
      const totalEth = txs.reduce((s, tx) => s + txAmount(tx), 0)
      const avgEthPerTx = txCount > 0 ? totalEth / txCount : 0

      // [3] Доля пылевых транзакций (< 0.001 ETH)
      const dustTx   = txs.filter(tx => txAmount(tx) < 0.001 && Number(tx.value) > 0)
      const dustRatio = txCount > 0 ? dustTx.length / txCount : 0

      // [4] Активные часы суток (уникальные, 0..24)
      const hours = new Set(txs.map(tx => new Date(Number(tx.timeStamp) * 1000).getUTCHours()))
      const activeHours = hours.size

      // [5] Среднее время между транзакциями в часах
      const timestamps = txs.map(tx => Number(tx.timeStamp)).sort((a, b) => a - b)
      let avgGapHours = 0
      if (timestamps.length > 1) {
        const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i])
        avgGapHours = (gaps.reduce((s, g) => s + g, 0) / gaps.length) / 3600
      }

      // [6] Уникальных контрагентов
      const counterparties = new Set([
        ...sends.map(tx => tx.to?.toLowerCase()).filter(Boolean),
        ...receives.map(tx => tx.from?.toLowerCase()).filter(Boolean),
      ])

      // [7] Баланс
      const balanceEth = realBalances.get(address) ?? 0

      result.set(address, {
        address,
        txCount,
        sendRatio,
        avgEthPerTx,
        dustRatio,
        activeHours,
        avgGapHours,
        uniqueCounterparties: counterparties.size,
        balanceEth,
      })
    })

    return result
  }

  // ── Шаг 2: нормализация (min-max по каждой фиче) ─────────────────────
  private normalize(featMap: Map<string, AddressFeatures>): { addresses: string[]; matrix: number[][] } {
    const addresses = [...featMap.keys()]
    if (addresses.length === 0) return { addresses: [], matrix: [] }

    const raw: number[][] = addresses.map(addr => {
      const f = featMap.get(addr)!
      return [
        f.txCount,
        f.sendRatio,
        f.avgEthPerTx,
        f.dustRatio,
        f.activeHours,
        f.avgGapHours,
        f.uniqueCounterparties,
        f.balanceEth,
      ]
    })

    // Min-max по каждому из 8 признаков
    const dims = raw[0].length
    const mins = Array(dims).fill(Infinity)
    const maxs = Array(dims).fill(-Infinity)

    raw.forEach(vec => vec.forEach((v, i) => {
      if (v < mins[i]) mins[i] = v
      if (v > maxs[i]) maxs[i] = v
    }))

    const matrix = raw.map(vec =>
      vec.map((v, i) => {
        const range = maxs[i] - mins[i]
        return range > 0 ? (v - mins[i]) / range : 0
      })
    )

    return { addresses, matrix }
  }

  // ── Описание K-means групп ───────────────────────────────────────────
  // Для каждой группы берём 1–2 признака, по которым её центр сильнее всего (≥ 0.5σ)
  // отклоняется от среднего по всем адресам: «в основном отправляет, мелкие переводы».
  private describeGroups(matrix: number[][], labels: number[], k: number): string[] {
    const dims = FEATURE_LABELS.length
    const mean = Array(dims).fill(0)
    const std  = Array(dims).fill(0)
    matrix.forEach(vec => vec.forEach((v, d) => { mean[d] += v / matrix.length }))
    matrix.forEach(vec => vec.forEach((v, d) => { std[d] += (v - mean[d]) ** 2 / matrix.length }))
    std.forEach((v, d) => { std[d] = Math.sqrt(v) })

    return Array.from({ length: k }, (_, group) => {
      const members = matrix.filter((_, i) => labels[i] === group)
      if (members.length === 0) return 'пустая группа'
      const centroid = Array.from({ length: dims }, (_, d) => members.reduce((s, vec) => s + vec[d], 0) / members.length)
      const traits = centroid
        .map((c, d) => ({ d, z: std[d] > 0 ? (c - mean[d]) / std[d] : 0 }))
        .filter(t => Math.abs(t.z) >= 0.5)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
        .slice(0, 2)
        .map(t => FEATURE_LABELS[t.d][t.z > 0 ? 0 : 1])
      return traits.length ? traits.join(', ') : 'типичное поведение'
    })
  }

  // ── Шаг 3: k-means — найти оптимальное K через elbow method ──────────
  private chooseK(matrix: number[][], maxK: number): number {
    if (matrix.length < 4) return 1

    // Считаем inertia (сумму квадратов расстояний до центроида) для K=1..maxK
    const inertias: number[] = []
    for (let k = 1; k <= maxK; k++) {
      try {
        const result = kmeans(matrix, k, { initialization: 'kmeans++', maxIterations: 100, seed: KMEANS_SEED })
        // Считаем inertia вручную
        let inertia = 0
        matrix.forEach((vec, i) => {
          const centroid = result.centroids[result.clusters[i]]
          inertia += vec.reduce((s, v, d) => s + (v - centroid[d]) ** 2, 0)
        })
        inertias.push(inertia)
      } catch {
        inertias.push(inertias[inertias.length - 1] ?? 0)
      }
    }

    // Elbow: ищем точку максимального перегиба (вторая производная)
    if (inertias.length < 3) return 1
    let bestK = 2
    let bestCurv = -Infinity
    for (let i = 1; i < inertias.length - 1; i++) {
      const curv = inertias[i - 1] - 2 * inertias[i] + inertias[i + 1]
      if (curv > bestCurv) { bestCurv = curv; bestK = i + 1 }
    }
    return bestK
  }

  // ── Шаг 4: Union-Find эвристики (работают поверх k-means) ────────────
  private applyHeuristics(
    uf: UnionFind,
    transactions: EtherscanTransaction[],
  ): void {
    const isCex = (addr: string) => CEX_ADDRESSES.has(addr.toLowerCase())

    // Эвристика 1: Dust sweep
    // Один адрес рассылает < 0.001 ETH на 5+ адресов в течение 30 минут.
    // Объединяем только получателей между собой — отправитель не входит в кластер.
    {
      const DUST_ETH    = 0.001
      const TIME_WINDOW = 1800  // 30 минут
      const MIN_BATCH   = 5

      const dustSends = new Map<string, EtherscanTransaction[]>()
      transactions.forEach(tx => {
        if (isCex(tx.from) || isCex(tx.to)) return
        const eth = txAmount(tx)
        if (eth > 0 && eth < DUST_ETH) {
          if (!dustSends.has(tx.from)) dustSends.set(tx.from, [])
          dustSends.get(tx.from)!.push(tx)
        }
      })

      dustSends.forEach((txList, sender) => {
        if (txList.length < MIN_BATCH) return
        txList.sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp))
        for (let i = 0; i < txList.length; i++) {
          const batch: string[] = []
          const t0 = Number(txList[i].timeStamp)
          for (let j = i; j < txList.length; j++) {
            if (Number(txList[j].timeStamp) - t0 > TIME_WINDOW) break
            if (txList[j].to && !isCex(txList[j].to)) batch.push(txList[j].to)
          }
          if (batch.length >= MIN_BATCH) {
            // Объединяем только получателей, не sender
            for (let k = 1; k < batch.length; k++) uf.union(batch[0], batch[k])
            console.log(`  [Dust] ${sender.slice(0, 10)}... → batch ${batch.length}`)
          }
        }
      })
    }

    // Эвристика 2: Funded by same address — строгая версия
    // Фандер отправил 2..20 адресам похожие суммы в течение 24 часов.
    // Объединяем только получателей между собой.
    {
      const MIN_ETH     = 0.05   // минимальная сумма
      const MAX_TARGETS = 20     // если > 20 — это биржа/роутер, не частный кошелёк
      const TIME_WINDOW = 86400  // 24 часа

      const fundedBy = new Map<string, { to: string; eth: number; ts: number }[]>()
      transactions.forEach(tx => {
        if (!tx.from || !tx.to) return
        if (isCex(tx.from) || isCex(tx.to)) return
        const eth = txAmount(tx)
        if (eth >= MIN_ETH) {
          if (!fundedBy.has(tx.from)) fundedBy.set(tx.from, [])
          fundedBy.get(tx.from)!.push({ to: tx.to, eth, ts: Number(tx.timeStamp) })
        }
      })

      fundedBy.forEach((records) => {
        // Дедупликация по адресу получателя
        const unique = [...new Map(records.map(r => [r.to.toLowerCase(), r])).values()]
        if (unique.length < 2 || unique.length > MAX_TARGETS) return

        unique.sort((a, b) => a.ts - b.ts)
        if (unique[unique.length - 1].ts - unique[0].ts > TIME_WINDOW) return

        // Суммы должны быть похожи: отклонение < 50% от медианы
        const amounts = unique.map(r => r.eth).sort((a, b) => a - b)
        const median  = amounts[Math.floor(amounts.length / 2)]
        const similar = amounts.filter(a => Math.abs(a - median) / (median || 1) < 0.5)
        if (similar.length < unique.length * 0.7) return

        const arr = unique.map(r => r.to)
        for (let k = 1; k < arr.length; k++) uf.union(arr[0], arr[k])
        console.log(`  [Funded] batch ${arr.length} похожих получателей`)
      })
    }

    // Эвристика 3: Взаимные переводы туда-обратно в течение 30 минут
    // Требуем минимум 2 пары близких по времени транзакций.
    {
      const TIME_WINDOW = 1800  // 30 минут
      const MIN_PAIRS   = 2

      const pairs = new Map<string, number[]>()
      transactions.forEach(tx => {
        if (!tx.from || !tx.to) return
        if (isCex(tx.from) || isCex(tx.to)) return
        const a = tx.from.toLowerCase()
        const b = tx.to.toLowerCase()
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        if (!pairs.has(key)) pairs.set(key, [])
        pairs.get(key)!.push(Number(tx.timeStamp))
      })

      pairs.forEach((timestamps, key) => {
        if (timestamps.length < MIN_PAIRS * 2) return
        timestamps.sort((a, b) => a - b)
        let closeCount = 0
        for (let i = 0; i < timestamps.length - 1; i++) {
          if (timestamps[i + 1] - timestamps[i] <= TIME_WINDOW) closeCount++
        }
        if (closeCount >= MIN_PAIRS) {
          const [addrA, addrB] = key.split('|')
          uf.union(addrA, addrB)
        }
      })
    }
  }

  // ── Главный метод ────────────────────────────────────────────────────
  buildClusters(
    transactions: EtherscanTransaction[],
    realBalances: Map<string, number>,
    ethPriceUsd: number,
    analyticsService: AnalyticsService,
    skipAnalytics = false,  // true для больших наборов — пропускаем GR/Markov для одиночных
  ): Map<string, ClusterInfo> {

    // ── 1. Вектор фич + нормализация ─────────────────────────────────
    const featMap              = this.buildFeatures(transactions, realBalances)
    const { addresses, matrix } = this.normalize(featMap)

    // ── 2. K-means: определяем оптимальное K (макс. 8, не больше N/3) ─
    const uf    = new UnionFind()
    transactions.forEach(tx => {
      if (tx.from) uf.add(tx.from)
      if (tx.to)   uf.add(tx.to)
    })

    const behaviorMap = new Map<string, BehaviorProfile>() // address → K-means группа

    // Для больших наборов сэмплируем адреса для k-means (макс 500)
    // иначе матрица расстояний O(n²) убивает производительность
    const MAX_KMEANS = 500
    let kMatrix   = matrix
    if (matrix.length > MAX_KMEANS) {
      const step = Math.floor(matrix.length / MAX_KMEANS)
      kMatrix    = matrix.filter((_, i) => i % step === 0).slice(0, MAX_KMEANS)
      console.log(`  [K-means] сэмпл ${kMatrix.length} из ${matrix.length} адресов`)
    }

    if (kMatrix.length >= 4) {
      const maxK  = Math.min(8, Math.floor(kMatrix.length / 3))
      const bestK = this.chooseK(kMatrix, maxK)
      console.log(`  [K-means] адресов=${kMatrix.length} K=${bestK}`)

      try {
        const { clusters: labels } = kmeans(matrix, bestK, { initialization: 'kmeans++', maxIterations: 200, seed: KMEANS_SEED })
        const groupLabels = this.describeGroups(matrix, labels, bestK)
        labels.forEach((group, i) => behaviorMap.set(addresses[i], { group, k: bestK, label: groupLabels[group] }))

        // K-means только ПОМЕЧАЕТ адреса поведенческой группой — не объединяет через Union-Find.
        // Union-Find объединение делают только строгие эвристики ниже.
        // Это предотвращает слияние всех адресов в один гигантский кластер.
        console.log(`  [K-means] группы: ${groupLabels.map((l, g) => `${g + 1}) ${l} (${labels.filter(x => x === g).length})`).join('; ')}`)
      } catch (err) {
        console.log(`  [K-means] ошибка: ${err}, используем только эвристики`)
      }
    } else {
      console.log(`  [K-means] слишком мало адресов (${matrix.length}), пропускаем`)
    }

    // ── 3. Union-Find эвристики (dust, funded, взаимные) ─────────────
    this.applyHeuristics(uf, transactions)

    // ── 4. Собираем итоговые кластеры ─────────────────────────────────
    const rawClusters = uf.getClusters()

    const clusterEth = new Map<string, number>()
    rawClusters.forEach((addrs, root) => {
      const total = addrs.reduce((sum, addr) => sum + (realBalances.get(addr) ?? 0), 0)
      clusterEth.set(root, total)
    })

    // Входящий/исходящий поток ETH каждого кластера — за один проход по tx.
    // Переводы внутри кластера не считаются. Раньше поток считался проходом по всем tx
    // для каждого кластера — O(кластеров × tx), на 18 тыс. адресов это минуты.
    const clusterIn  = new Map<string, number>()
    const clusterOut = new Map<string, number>()
    transactions.forEach(tx => {
      const fromRoot = tx.from ? uf.find(tx.from) : undefined
      const toRoot   = tx.to   ? uf.find(tx.to)   : undefined
      if (fromRoot === toRoot) return
      const eth = txAmount(tx)
      if (fromRoot) clusterOut.set(fromRoot, (clusterOut.get(fromRoot) || 0) + eth)
      if (toRoot)   clusterIn.set(toRoot,    (clusterIn.get(toRoot)    || 0) + eth)
    })

    const getClusterRole = (root: string): string => {
      const totalIn  = clusterIn.get(root)  || 0
      const totalOut = clusterOut.get(root) || 0
      if (totalIn === 0 && totalOut === 0) return 'UNKNOWN'
      const ratio = totalIn / (totalIn + totalOut)
      if (ratio > 0.7) return 'ACCUMULATOR'
      if (ratio < 0.3) return 'DISTRIBUTOR'
      return 'RELAY'
    }

    // Определяем archetype кластера по средним фичам его адресов
    const getArchetype = (addrs: string[]): string => {
      const feats = addrs.map(a => featMap.get(a.toLowerCase())).filter(Boolean) as AddressFeatures[]
      if (feats.length === 0) return 'UNKNOWN'
      const avgSendRatio = feats.reduce((s, f) => s + f.sendRatio, 0) / feats.length
      const avgDustRatio = feats.reduce((s, f) => s + f.dustRatio, 0) / feats.length
      const avgTxCount   = feats.reduce((s, f) => s + f.txCount,   0) / feats.length
      if (avgDustRatio > 0.4)   return 'DUST_CLUSTER'   // преимущественно пылевые tx
      if (avgSendRatio > 0.8)   return 'SENDER'         // в основном отправляет
      if (avgSendRatio < 0.2)   return 'RECEIVER'       // в основном получает
      if (avgTxCount   > 50)    return 'HIGH_FREQUENCY' // высокочастотный
      return 'MIXED'
    }

    // Ограничение: кластер с > 50 адресами — скорее всего ложное срабатывание.
    // Такие кластеры разбиваем: каждый адрес становится одиночным узлом.
    const MAX_CLUSTER_SIZE = 50

    // Индекс «адрес → номера его tx» строится один раз. Аналитика получает только tx кластера
    // в исходном порядке — результат тот же, что при передаче всех tx (она их всё равно
    // фильтрует), но без перебора всех транзакций для каждого из тысяч кластеров.
    const txIndex = new Map<string, number[]>()
    const indexTx = (addr: string, i: number) => {
      if (!txIndex.has(addr)) txIndex.set(addr, [])
      txIndex.get(addr)!.push(i)
    }
    transactions.forEach((tx, i) => {
      const from = tx.from?.toLowerCase()
      const to   = tx.to?.toLowerCase()
      if (from) indexTx(from, i)
      if (to && to !== from) indexTx(to, i)
    })
    const clusterTxs = (addrs: string[]): EtherscanTransaction[] => {
      if (addrs.length === 1) return (txIndex.get(addrs[0].toLowerCase()) ?? []).map(i => transactions[i])
      const idx = new Set<number>()
      addrs.forEach(a => txIndex.get(a.toLowerCase())?.forEach(i => idx.add(i)))
      return [...idx].sort((x, y) => x - y).map(i => transactions[i])
    }

    // K-means группы участников кластера (адреса без признаков — только биржевые tx — пропускаем)
    const behaviorOf = (addrs: string[]): Record<string, BehaviorProfile> => {
      const out: Record<string, BehaviorProfile> = {}
      addrs.forEach(a => {
        const b = behaviorMap.get(a.toLowerCase())
        if (b) out[a] = b
      })
      return out
    }

    const result = new Map<string, ClusterInfo>()
    let multiCount = 0

    rawClusters.forEach((addrs, root) => {
      const ethTotal  = clusterEth.get(root) ?? 0

      // Если кластер слишком большой — сбрасываем в одиночные
      if (addrs.length > MAX_CLUSTER_SIZE) {
        addrs.forEach(addr => {
          const txs = skipAnalytics ? [] : clusterTxs([addr])
          result.set(addr, {
            clusterId: addr,
            addresses: [addr],
            totalEth:  realBalances.get(addr) ?? 0,
            totalUsd:  (realBalances.get(addr) ?? 0) * ethPriceUsd,
            role:      'UNKNOWN',
            archetype: 'UNKNOWN',
            signals:   [],
            gr:        skipAnalytics ? emptyGR() : analyticsService.computeGR([addr], txs, realBalances),
            markov:    skipAnalytics ? emptyMarkov() : analyticsService.computeMarkov([addr], txs),
            behavior:  behaviorOf([addr]),
          })
        })
        console.log(`  [Cluster] SPLIT: ${root.slice(0, 10)}... был слишком большим (${addrs.length} адресов)`)
        return
      }

      const role      = getClusterRole(root)
      const archetype = getArchetype(addrs)

      // Сигналы: какие именно признаки объединили этот кластер
      const behavior = behaviorOf(addrs)
      const signals: string[] = []
      if (addrs.length > 1) {
        const feats = addrs.map(a => featMap.get(a)).filter(Boolean) as AddressFeatures[]
        const avgDust = feats.reduce((s, f) => s + f.dustRatio, 0) / (feats.length || 1)
        if (avgDust > 0.3)                          signals.push('dust_pattern')
        // Все участники в одной K-means группе — поведение подтверждает общего владельца
        const groups = new Set(Object.values(behavior).map(b => b.group))
        if (Object.keys(behavior).length > 1 && groups.size === 1) signals.push('kmeans_behavior')
        if (feats.some(f => f.uniqueCounterparties < 3)) signals.push('low_counterparties')
      }

      // GR и Markov считаем только для кластеров с несколькими адресами
      // При skipAnalytics — пропускаем для одиночных (экономия на больших наборах)
      const isMulti = addrs.length > 1
      const withAnalytics = isMulti || !skipAnalytics
      const txs    = withAnalytics ? clusterTxs(addrs) : []
      const gr     = withAnalytics ? analyticsService.computeGR(addrs, txs, realBalances) : emptyGR()
      const markov = withAnalytics ? analyticsService.computeMarkov(addrs, txs) : emptyMarkov()

      const info: ClusterInfo = {
        clusterId: root,
        addresses: addrs,
        totalEth:  ethTotal,
        totalUsd:  ethTotal * ethPriceUsd,
        role,
        archetype,
        signals,
        gr,
        markov,
        behavior,
      }
      addrs.forEach(addr => result.set(addr, info))

      if (addrs.length > 1) {
        multiCount++
        console.log(
          `  [Cluster] ${root.slice(0, 10)}... addrs=${addrs.length}` +
          ` role=${role} arch=${archetype} eth=${ethTotal.toFixed(4)}`
        )
      }
    })

    console.log(`  Итого кластеров >1 адреса: ${multiCount}`)
    return result
  }
}
