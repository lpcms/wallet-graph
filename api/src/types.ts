import type { EntityType } from './constants/known-addresses'

// ===== ТИПЫ =====

export interface EtherscanTransaction {
  hash: string
  from: string
  to: string
  value: string
  timeStamp: string
  blockNumber: string
  tokenSymbol?: string
  tokenDecimal?: string
}

export interface GraphNode {
  id: string
  walletAddress: string
  nodeType: string
  tokenBalance: number
  usdBalance: string
  usdValue: string
  balanceKnown: boolean       // false — реальный баланс ETH не запрашивался (граф токена)
  tokenFlow?: number          // граф токена: приход − расход токена в загруженных переводах
  tokenSymbol?: string
  entityType: EntityType       // категория владельца (легенда «Владелец»)
  entityName?: string         // название (Binance, Uniswap…) или роль («смарт-контракт», «создатель токена»)
  entityVerified?: boolean    // для кошелька: проверено, что это не контракт
  isExchange: boolean
  exchangeName?: string
  clusterId?: string
  clusterSize?: number
  clusterRole?: string
  clusterArchetype?: string
  kmeansSignals?: string[]
  behavior?: BehaviorProfile
  gr?: GrowthReadiness
  markov?: MarkovPhase
}

export interface GraphLink {
  sourceId: string
  targetId: string
  sourceAddress: string
  targetAddress: string
  linkType: string
  transactionWeight: number
  usdWeight?: number          // только для переводов ETH: цены токена нет
  unix: number
  txId: string
  isCrossCluster: boolean
}

// Growth Readiness уровни
// <50  — топлива почти нет
// 50–90 — подготовка / накопление
// 90–110 — напряжение, возможен памп
// >150  — перегрев / памп близко
export interface GrowthReadiness {
  score: number          // 0..200+, нормализованный индикатор
  level: string          // COLD | PREPARING | TENSION | HOT
  label: string          // человекочитаемое описание
  components: {          // из чего сложился score
    accumulationScore:  number  // насколько кластер накапливает
    velocityScore:      number  // скорость нарастания активности
    balanceScore:       number  // относительный вес баланса
    retentionScore:     number  // удержание (мало исходящих)
  }
}

// Markov: фазы жизненного цикла кластера
export interface MarkovPhase {
  currentPhase: string        // ACCUMULATE | HOLD | DISTRIBUTE | INACTIVE
  phaseHistory: string[]      // последние N фаз (хронологически)
  transitions: {              // матрица вероятностей переходов
    from: string
    to: string
    probability: number
  }[]
  nextPhaseProbabilities: {   // вероятности следующего состояния
    phase: string
    probability: number
  }[]
}

export interface ClusterInfo {
  clusterId: string
  addresses: string[]
  totalEth: number
  totalUsd: number
  role: string
  archetype: string
  signals: string[]
  gr: GrowthReadiness         // шаг 3: Growth Readiness
  markov: MarkovPhase         // шаг 3: Markov фазы
  behavior: Record<string, BehaviorProfile>  // K-means группа каждого адреса кластера
}

// Поведенческая группа адреса по K-means: адреса со схожим паттерном транзакций
export interface BehaviorProfile {
  group: number   // номер группы, с 0
  k:     number   // всего групп
  label: string   // чем группа отличается от остальных
}

// ===== ВЕКТОР ФИЧ АДРЕСА =====
// 8 нормализованных признаков, описывающих поведение кошелька.
// Именно по этому вектору k-means ищет похожие адреса.

export interface AddressFeatures {
  address:        string
  txCount:        number   // [0] общее кол-во транзакций
  sendRatio:      number   // [1] доля исходящих (0..1)
  avgEthPerTx:    number   // [2] средний ETH на транзакцию
  dustRatio:      number   // [3] доля пылевых tx (<0.001 ETH)
  activeHours:    number   // [4] кол-во уникальных часов активности (0..24)
  avgGapHours:    number   // [5] среднее время между tx в часах
  uniqueCounterparties: number // [6] кол-во уникальных контрагентов
  balanceEth:     number   // [7] текущий баланс ETH
}
