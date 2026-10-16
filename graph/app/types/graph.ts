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
  balanceKnown?: boolean   // false — реальный баланс ETH не запрашивался (граф токена)
  entityType?: string      // категория владельца: WALLET, CEX, DEX, FUND, DEFI, ISSUER, PERSON, UNATTRIBUTED
  entityName?: string      // название (Binance, Uniswap…) или роль («смарт-контракт»)
  entityVerified?: boolean // для кошелька: проверено, что это не контракт
  tokenFlow?: number       // граф токена: приход − расход токена
  tokenSymbol?: string
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
  hop?: number             // граф кошелька: число переводов от исследуемого кошелька (0 — он сам)
  chainHop?: number        // шаг цепочки раскрытия, на котором адрес впервые встретился (≥ hop)
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
  usdWeight?: number       // только для переводов ETH
  unix: number
  txId: string
  isCrossCluster?: boolean
}
