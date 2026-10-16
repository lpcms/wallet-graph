import { Injectable } from '@nestjs/common'
import type { EtherscanTransaction, GrowthReadiness, MarkovPhase } from '../types'
import { txAmount } from '../lib/amount'

// ===== GROWTH READINESS + MARKOV СЕРВИС =====

@Injectable()
export class AnalyticsService {

  // ── Growth Readiness ─────────────────────────────────────────────────
  // Считает score 0..200+ из 4 компонентов на основе истории транзакций.
  // Не требует внешних данных — только то что уже есть в transactions.

  computeGR(
    addresses: string[],
    transactions: EtherscanTransaction[],
    realBalances: Map<string, number>,
  ): GrowthReadiness {

    const addrSet = new Set(addresses.map(a => a.toLowerCase()))

    // Фильтруем транзакции кластера
    const clusterTxs = transactions.filter(tx =>
      addrSet.has(tx.from?.toLowerCase()) || addrSet.has(tx.to?.toLowerCase())
    )

    if (clusterTxs.length === 0) {
      return this.grFromScore(0)
    }

    // Сортируем по времени
    const sorted = [...clusterTxs].sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp))

    // ── Компонент 1: Accumulation score (0..50) ───────────────────────
    // Сравниваем входящий и исходящий ETH-поток.
    // Чем больше входящих относительно исходящих — тем выше накопление.
    let totalIn = 0, totalOut = 0
    clusterTxs.forEach(tx => {
      const eth = txAmount(tx)
      if (addrSet.has(tx.to?.toLowerCase())   && !addrSet.has(tx.from?.toLowerCase())) totalIn  += eth
      if (addrSet.has(tx.from?.toLowerCase()) && !addrSet.has(tx.to?.toLowerCase()))   totalOut += eth
    })
    const flowTotal = totalIn + totalOut
    const accRatio  = flowTotal > 0 ? totalIn / flowTotal : 0.5
    const accumulationScore = Math.round(accRatio * 50)

    // ── Компонент 2: Velocity score (0..50) ──────────────────────────
    // Скорость нарастания активности: сравниваем первую и вторую половину истории.
    const mid = Math.floor(sorted.length / 2)
    const firstHalf  = sorted.slice(0, mid)
    const secondHalf = sorted.slice(mid)
    const firstSpan  = Math.max(1, (Number(firstHalf[firstHalf.length - 1]?.timeStamp) - Number(firstHalf[0]?.timeStamp)) / 86400)
    const secondSpan = Math.max(1, (Number(secondHalf[secondHalf.length - 1]?.timeStamp) - Number(secondHalf[0]?.timeStamp)) / 86400)
    const firstRate  = firstHalf.length  / firstSpan
    const secondRate = secondHalf.length / secondSpan
    // velocityRatio > 1 — активность растёт, < 1 — падает
    const velocityRatio = firstRate > 0 ? secondRate / firstRate : 1
    const velocityScore = Math.round(Math.min(50, Math.max(0, (velocityRatio - 0.5) * 50)))

    // ── Компонент 3: Balance score (0..50) ───────────────────────────
    // Насколько значителен текущий суммарный баланс кластера.
    // Нормируем по среднему объёму транзакции (относительная метрика).
    const totalEth   = addresses.reduce((s, a) => s + (realBalances.get(a.toLowerCase()) ?? 0), 0)
    const avgTxEth   = flowTotal > 0 ? flowTotal / clusterTxs.length : 0
    const balanceRel = avgTxEth > 0 ? Math.min(1, totalEth / (avgTxEth * 10)) : 0
    const balanceScore = Math.round(balanceRel * 50)

    // ── Компонент 4: Retention score (0..50) ─────────────────────────
    // Удержание — насколько мало кластер тратит относительно накопленного.
    // Высокий retention = держат, не продают.
    const retentionRatio  = flowTotal > 0 ? 1 - (totalOut / flowTotal) : 0.5
    const retentionScore  = Math.round(retentionRatio * 50)

    const score = accumulationScore + velocityScore + balanceScore + retentionScore

    return {
      score,
      ...this.grLevel(score),
      components: { accumulationScore, velocityScore, balanceScore, retentionScore },
    }
  }

  private grLevel(score: number): { level: string; label: string } {
    if (score < 50)  return { level: 'COLD',     label: 'Топлива почти нет' }
    if (score < 90)  return { level: 'PREPARING', label: 'Накопление / подготовка' }
    if (score < 110) return { level: 'TENSION',  label: 'Напряжение — возможен памп' }
    return               { level: 'HOT',      label: 'Перегрев — памп близко' }
  }

  private grFromScore(score: number): GrowthReadiness {
    return {
      score,
      ...this.grLevel(score),
      components: { accumulationScore: 0, velocityScore: 0, balanceScore: 0, retentionScore: 0 },
    }
  }

  // ── Markov-цепи ───────────────────────────────────────────────────────
  // Делим историю транзакций кластера на временные окна (по 7 дней).
  // Для каждого окна определяем фазу: ACCUMULATE | HOLD | DISTRIBUTE | INACTIVE.
  // Строим матрицу переходов и считаем вероятности следующего состояния.

  computeMarkov(
    addresses: string[],
    transactions: EtherscanTransaction[],
    inactiveBelow = 0.001,   // оборот окна (в штуках актива), ниже которого окно неактивно — INACTIVE_USD по цене
  ): MarkovPhase {

    const addrSet = new Set(addresses.map(a => a.toLowerCase()))
    const PHASES  = ['ACCUMULATE', 'HOLD', 'DISTRIBUTE', 'INACTIVE'] as const
    type Phase    = typeof PHASES[number]

    const clusterTxs = transactions.filter(tx =>
      addrSet.has(tx.from?.toLowerCase()) || addrSet.has(tx.to?.toLowerCase())
    )

    if (clusterTxs.length < 3) {
      return this.emptyMarkov()
    }

    // Разбиваем на 7-дневные окна
    const sorted  = [...clusterTxs].sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp))
    const t0      = Number(sorted[0].timeStamp)
    const t1      = Number(sorted[sorted.length - 1].timeStamp)
    const WINDOW  = 7 * 86400  // 7 дней в секундах
    const windows: EtherscanTransaction[][] = []

    for (let wStart = t0; wStart < t1; wStart += WINDOW) {
      const wEnd  = wStart + WINDOW
      const batch = sorted.filter(tx => {
        const ts = Number(tx.timeStamp)
        return ts >= wStart && ts < wEnd
      })
      windows.push(batch)
    }

    // Определяем фазу каждого окна
    const phaseHistory: Phase[] = windows.map(batch => {
      if (batch.length === 0) return 'INACTIVE'

      let inFlow = 0, outFlow = 0
      batch.forEach(tx => {
        const eth = txAmount(tx)
        if (addrSet.has(tx.to?.toLowerCase())   && !addrSet.has(tx.from?.toLowerCase())) inFlow  += eth
        if (addrSet.has(tx.from?.toLowerCase()) && !addrSet.has(tx.to?.toLowerCase()))   outFlow += eth
      })

      const total = inFlow + outFlow
      if (total < inactiveBelow) return 'INACTIVE'

      const ratio = inFlow / total
      if (ratio > 0.7)  return 'ACCUMULATE'
      if (ratio < 0.3)  return 'DISTRIBUTE'
      // Активность есть, но примерно поровну → HOLD (ребалансировка)
      return 'HOLD'
    })

    // Строим матрицу переходов
    const counts = new Map<string, number>()
    const totals = new Map<string, number>()

    for (let i = 0; i < phaseHistory.length - 1; i++) {
      const from = phaseHistory[i]
      const to   = phaseHistory[i + 1]
      const key  = `${from}->${to}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      totals.set(from, (totals.get(from) ?? 0) + 1)
    }

    const transitions: MarkovPhase['transitions'] = []
    counts.forEach((count, key) => {
      const [from, to] = key.split('->')
      const total = totals.get(from) ?? 1
      transitions.push({ from, to, probability: Math.round((count / total) * 100) / 100 })
    })
    transitions.sort((a, b) => b.probability - a.probability)

    // Вероятности следующего состояния из текущей фазы
    const currentPhase = phaseHistory[phaseHistory.length - 1]
    const nextPhaseProbabilities: MarkovPhase['nextPhaseProbabilities'] = PHASES.map(phase => {
      const key   = `${currentPhase}->${phase}`
      const count = counts.get(key) ?? 0
      const total = totals.get(currentPhase) ?? 0
      return { phase, probability: total > 0 ? Math.round((count / total) * 100) / 100 : 0 }
    }).filter(p => p.probability > 0).sort((a, b) => b.probability - a.probability)

    return {
      currentPhase,
      phaseHistory: phaseHistory.slice(-10),  // последние 10 окон
      transitions:  transitions.slice(0, 8),   // топ-8 переходов
      nextPhaseProbabilities,
    }
  }

  private emptyMarkov(): MarkovPhase {
    return {
      currentPhase: 'INACTIVE',
      phaseHistory: [],
      transitions:  [],
      nextPhaseProbabilities: [],
    }
  }
}
