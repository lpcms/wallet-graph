// Типы узлов кошельков
export enum NodeType {
  Cexbuy    = 'CEXBUY',
  Cexsell   = 'CEXSELL',
  Dexbuy    = 'DEXBUY',
  Dexsell   = 'DEXSELL',
  Deployer  = 'DEPLOYER',
  Exchange  = 'EXCHANGE',
  Active    = 'ACTIVE',
}

export enum LinkType {
  Cexbuy   = 'CEXBUY',
  Cexsell  = 'CEXSELL',
  Dexbuy   = 'DEXBUY',
  Dexsell  = 'DEXSELL',
  Deployer = 'DEPLOYER',
  Transfer = 'TRANSFER',
}

// Шаг 3: Growth Readiness
export interface GrowthReadiness {
  score: number
  level: string   // COLD | PREPARING | TENSION | HOT
  label: string
  components: {
    accumulationScore: number
    velocityScore:     number
    balanceScore:      number
    retentionScore:    number
  }
}

// Шаг 3: Markov фазы
export interface MarkovPhase {
  currentPhase: string
  phaseHistory: string[]
  transitions: { from: string; to: string; probability: number }[]
  nextPhaseProbabilities: { phase: string; probability: number }[]
}

export interface Node {
  id: string
  walletAddress: string
  nodeType: string
  tokenBalance: number
  usdBalance: string
  usdValue?: string
  weightedAverageBuyPrice?: number
  weightedAverageSellPrice?: number
  // Шаг 1: CEX
  isExchange?: boolean
  exchangeName?: string
  // Шаг 2: кластеры
  clusterId?: string
  clusterSize?: number
  clusterRole?: string
  clusterArchetype?: string
  kmeansSignals?: string[]
  // K-means: поведенческая группа адреса
  behavior?: {
    group: number   // с 0
    k:     number   // всего групп
    label: string   // чем группа отличается от остальных
  }
  // Шаг 3: аналитика
  gr?: GrowthReadiness
  markov?: MarkovPhase
}

export interface Link {
  sourceId: string
  targetId: string
  sourceAddress: string
  targetAddress: string
  linkType: string
  transactionWeight: number
  usdWeight: number
  unix: number
  txId: string
  isCrossCluster?: boolean
}
