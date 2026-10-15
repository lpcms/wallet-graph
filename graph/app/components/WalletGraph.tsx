'use client'

import { useEffect, useRef, useState, useMemo } from 'react'
import { MultiGraph } from 'graphology'

import Sigma from 'sigma'
import { EdgeRectangleProgram } from 'sigma/rendering'
import { createNodeBorderProgram } from '@sigma/node-border'
import { inferSettings } from 'graphology-layout-forceatlas2'
import forceAtlas2Worker from 'graphology-layout-forceatlas2/worker.js'

import type { Node, Link, GrowthReadiness, MarkovPhase } from '../types/graph'
import { ENTITY_ORDER, ENTITY_STYLES, entityStyle } from '../lib/entities'
import { findIslands, hubLayout, type Point } from '../lib/graph-layout'

const FA2Supervisor =
  'default' in forceAtlas2Worker
    ? (forceAtlas2Worker as unknown as { default: typeof forceAtlas2Worker }).default
    : forceAtlas2Worker

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function shortAddress(address: string): string {
  if (!address || address.length < 12) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

// Приход − расход токена в загруженных переводах: «+1 234,5 USDT»
function formatTokenFlow(amount: number, symbol = 'TOKEN'): string {
  const sign = amount > 0 ? '+' : ''
  return `${sign}${amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${symbol}`
}

function formatUsd(raw: string): string {
  const num = parseFloat(raw.replace('$', ''))
  if (isNaN(num)) return raw
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ===== ПАЛИТРА КЛАСТЕРОВ =====
// 12 различимых цветов — каждый clusterId получает свой по индексу
const CLUSTER_PALETTE = [
  { color: '#6366f1', border: '#a5b4fc' }, // indigo
  { color: '#f59e0b', border: '#fcd34d' }, // amber
  { color: '#10b981', border: '#6ee7b7' }, // emerald
  { color: '#ec4899', border: '#f9a8d4' }, // pink
  { color: '#8b5cf6', border: '#c4b5fd' }, // violet
  { color: '#14b8a6', border: '#5eead4' }, // teal
  { color: '#f97316', border: '#fdba74' }, // orange
  { color: '#06b6d4', border: '#67e8f9' }, // cyan
  { color: '#84cc16', border: '#bef264' }, // lime
  { color: '#e11d48', border: '#fda4af' }, // rose
  { color: '#7c3aed', border: '#c084fc' }, // purple
  { color: '#0ea5e9', border: '#7dd3fc' }, // sky
]

// Назначаем цвет кластеру по его id (детерминировано через хэш)
function clusterColor(clusterId: string): { color: string; border: string } {
  let hash = 0
  for (let i = 0; i < clusterId.length; i++) {
    hash = (hash * 31 + clusterId.charCodeAt(i)) >>> 0
  }
  return CLUSTER_PALETTE[hash % CLUSTER_PALETTE.length]
}

// ===== ЦВЕТ УЗЛА =====
// owner    — по категории владельца (кошелёк, биржа, фонд…), кластер виден по цвету обводки
// behavior — по поведению: покупатели, продавцы, пустые, кластеры
type ColorMode = 'owner' | 'behavior'

function getNodeColor(node: Node, mode: ColorMode): { color: string; borderColor: string } {
  return mode === 'owner' ? getOwnerColor(node) : getBehaviorColor(node)
}

function getOwnerColor(node: Node): { color: string; borderColor: string } {
  const style = entityStyle(node.entityType)
  const inCluster = node.clusterId && (node.clusterSize ?? 1) > 1
  return { color: style.color, borderColor: inCluster ? clusterColor(node.clusterId!).color : style.border }
}

function getBehaviorColor(node: Node): { color: string; borderColor: string } {
  // Биржи — серые полупрозрачные
  if (node.isExchange || node.nodeType === 'EXCHANGE')
    return { color: '#94a3b8', borderColor: '#cbd5e1' }

  // Адреса кластера (размер > 1) — цвет палитры кластера
  if (node.clusterId && (node.clusterSize ?? 1) > 1) {
    const c = clusterColor(node.clusterId)
    return { color: c.color, borderColor: c.border }
  }

  // Одиночные адреса — стандартная схема
  if (node.nodeType === 'DEXSELL' || node.nodeType === 'CEXSELL')
    return { color: '#ef4444', borderColor: '#fca5a5' }
  if (node.nodeType === 'DEXBUY' || node.nodeType === 'CEXBUY' || node.nodeType === 'DEPLOYER')
    return { color: '#22c55e', borderColor: '#86efac' }
  // Пустой — только если баланс действительно известен и равен нулю
  if (node.balanceKnown !== false && (node.usdBalance === '0' || node.usdBalance === '0.000000'))
    return { color: '#f59e0b', borderColor: '#fcd34d' }
  return { color: '#3b82f6', borderColor: '#93c5fd' }
}

// ===== ЦВЕТ РЕБРА =====
function getEdgeColor(link: Link, nodesById: Map<string, Node>): string {
  // Межкластерное ребро — белое/яркое, чтобы выделялось
  if (link.isCrossCluster) return '#ffffff'

  const src = nodesById.get(link.sourceId)
  // Если оба конца — один кластер, берём его цвет (бледнее)
  if (src?.clusterId && (src.clusterSize ?? 1) > 1) {
    return clusterColor(src.clusterId).border
  }

  if (link.linkType === 'DEXBUY'  || link.linkType === 'CEXBUY')  return '#22c55e'
  if (link.linkType === 'DEXSELL' || link.linkType === 'CEXSELL') return '#ef4444'
  return '#64748b'
}

// ===== РАЗМЕР УЗЛА =====
function getNodeSize(node: Node): number {
  // Биржи маленькие и неважные
  if (node.isExchange || node.nodeType === 'EXCHANGE') return 5
  // Размер кластерного узла растёт с размером кластера
  const sz = node.clusterSize ?? 1
  if (sz >= 10) return 18
  if (sz >= 5)  return 14
  if (sz >= 2)  return 11
  return 8
}

// ===== МЕТКА АРХЕТИПА =====
// Почему адреса объединены в кластер
const SIGNAL_LABEL: Record<string, string> = {
  dust_pattern:       'пылевые переводы',
  kmeans_behavior:    'одинаковое поведение (K-means)',
  low_counterparties: 'мало контрагентов',
}

const ARCHETYPE_LABEL: Record<string, string> = {
  DUST_CLUSTER:   '🌫 Dust cluster',
  SENDER:         '↑ Sender',
  RECEIVER:       '↓ Receiver',
  HIGH_FREQUENCY: '⚡ High-freq',
  MIXED:          '⇄ Mixed',
  UNKNOWN:        '? Unknown',
}

// ===== GR HELPERS =====

const GR_COLORS: Record<string, { bg: string; border: string; text: string; bar: string }> = {
  COLD:      { bg: '#f1f5f9', border: '#cbd5e1', text: '#64748b', bar: '#94a3b8' },
  PREPARING: { bg: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8', bar: '#3b82f6' },
  TENSION:   { bg: '#fffbeb', border: '#fde68a', text: '#b45309', bar: '#f59e0b' },
  HOT:       { bg: '#fef2f2', border: '#fecaca', text: '#b91c1c', bar: '#ef4444' },
}

function GRIndicator({ gr }: { gr: GrowthReadiness }) {
  const c      = GR_COLORS[gr.level] ?? GR_COLORS.COLD
  const pct    = Math.min(100, (gr.score / 200) * 100)
  const scored = [
    { label: 'Накопление', value: gr.components.accumulationScore },
    { label: 'Скорость',   value: gr.components.velocityScore },
    { label: 'Баланс',     value: gr.components.balanceScore },
    { label: 'Удержание',  value: gr.components.retentionScore },
  ]
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 8, padding: '10px 12px', marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: c.text, textTransform: 'uppercase', letterSpacing: 1 }}>
          Готовность к росту
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: c.text }}>
          {gr.score}
          <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.6 }}> / 200 pts</span>
        </span>
      </div>
      {/* Прогресс-бар */}
      <div style={{ height: 6, background: '#e2e8f0', borderRadius: 3, marginBottom: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: c.bar, borderRadius: 3, transition: 'width .4s' }} />
      </div>
      <div style={{ fontSize: 11, color: c.text, marginBottom: 8 }}>{gr.label}</div>
      {/* Компоненты */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px' }}>
        {scored.map(s => (
          <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: '#94a3b8' }}>{s.label}</span>
            <span style={{ color: c.text, fontWeight: 600 }}>
              {s.value}
              <span style={{ fontWeight: 400, opacity: 0.55 }}> / 50</span>
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, textAlign: 'right' }}>
        pts — очки активности, макс. 50 на компонент
      </div>
    </div>
  )
}

// ===== MARKOV HELPERS =====

const PHASE_COLORS: Record<string, string> = {
  ACCUMULATE: '#3b82f6',
  HOLD:       '#8b5cf6',
  DISTRIBUTE: '#f97316',
  INACTIVE:   '#94a3b8',
}
const PHASE_LABELS: Record<string, string> = {
  ACCUMULATE: '📥 Накопление',
  HOLD:       '🤝 Удержание',
  DISTRIBUTE: '📤 Распродажа',
  INACTIVE:   '💤 Неактивен',
}

function MarkovBlock({ markov }: { markov: MarkovPhase }) {
  return (
    <div style={{ marginTop: 8 }}>
      {/* Текущая фаза */}
      <div style={{
        padding: '6px 10px', borderRadius: 8, marginBottom: 8,
        background: (PHASE_COLORS[markov.currentPhase] ?? '#94a3b8') + '22',
        border: `1px solid ${(PHASE_COLORS[markov.currentPhase] ?? '#94a3b8')}55`,
      }}>
        <span style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>Текущая фаза</span>
        <div style={{ fontSize: 13, fontWeight: 600, color: PHASE_COLORS[markov.currentPhase] ?? '#94a3b8', marginTop: 2 }}>
          {PHASE_LABELS[markov.currentPhase] ?? markov.currentPhase}
        </div>
      </div>

      {/* История фаз (мини-чип на каждый период) */}
      {markov.phaseHistory.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
            История (7д/период)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {markov.phaseHistory.map((ph, i) => (
              <div key={i} title={PHASE_LABELS[ph] ?? ph} style={{
                width: 14, height: 14, borderRadius: 3,
                background: PHASE_COLORS[ph] ?? '#94a3b8',
                opacity: 0.7 + (i / markov.phaseHistory.length) * 0.3,
              }} />
            ))}
          </div>
        </div>
      )}

      {/* Следующий шаг */}
      {markov.nextPhaseProbabilities.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
            Следующая фаза
          </div>
          {markov.nextPhaseProbabilities.slice(0, 3).map(p => (
            <div key={p.phase} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: PHASE_COLORS[p.phase] ?? '#94a3b8', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: '#64748b', flex: 1 }}>{PHASE_LABELS[p.phase] ?? p.phase}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#1e293b' }}>{Math.round(p.probability * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ROLE_LABEL: Record<string, string> = {
  ACCUMULATOR: '📥 Accumulator',
  DISTRIBUTOR: '📤 Distributor',
  RELAY:       '↔ Relay',
  UNKNOWN:     '? Unknown',
}

// ===== ТИПЫ =====
interface Props {
  nodes: Node[]
  links: Link[]
  centerAddress?: string   // исследуемый кошелёк — в центре раскладки
}

// Масштаб — по видимым узлам: sigma учитывает и скрытые, и скрытые острова оставляли бы пустоту
function fitVisible(sigma: Sigma, positions: Map<string, Point>, hidden: Set<string> | null) {
  if (!hidden?.size) { sigma.setCustomBBox(null); return }
  const xs: number[] = [], ys: number[] = []
  positions.forEach((p, id) => { if (!hidden.has(id)) { xs.push(p.x); ys.push(p.y) } })
  if (!xs.length) { sigma.setCustomBBox(null); return }
  sigma.setCustomBBox({ x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] })
}

// Центральный адрес выделяется размером и белой обводкой
const CENTER_SIZE   = 20
const CENTER_BORDER = '#ffffff'

// Легенда режима «Поведение»
const BEHAVIOR_LEGEND = [
  { color: '#22c55e', label: 'Buyers'    },
  { color: '#ef4444', label: 'Sellers'   },
  { color: '#3b82f6', label: 'Active'    },
  { color: '#f59e0b', label: 'Empty'     },
  { color: '#94a3b8', label: 'Exchange'  },
  { color: '#6366f1', label: 'Cluster'   },
]

// ===== КОМПОНЕНТ =====
export default function WalletGraph({ nodes, links, centerAddress }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sigmaRef     = useRef<Sigma | null>(null)
  const fa2Ref       = useRef<InstanceType<typeof FA2Supervisor> | null>(null)

  const graphRef     = useRef<MultiGraph | null>(null)
  const layoutRef    = useRef<Map<string, Point> | null>(null)

  const [isPlayed,     setIsPlayed]     = useState(false)
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [colorMode,    setColorMode]    = useState<ColorMode>('owner')
  // Текущий режим для инициализации графа — без перестроения графа при переключении
  const colorModeRef = useRef<ColorMode>(colorMode)

  const centerId = useMemo(
    () => centerAddress
      ? nodes.find(n => n.walletAddress.toLowerCase() === centerAddress.toLowerCase())?.id
      : undefined,
    [nodes, centerAddress],
  )
  // Острова — адреса без связи с главной группой ни одной цепочкой переводов; по умолчанию показаны
  const islands = useMemo(() => findIslands(nodes.map(n => n.id), links, centerId), [nodes, links, centerId])
  const [showIslands, setShowIslands] = useState(true)
  const showIslandsRef = useRef(showIslands)

  // Сколько узлов каждой категории — счётчики легенды «Владелец»
  const entityCounts = useMemo(() => {
    const counts = new Map<string, number>()
    nodes.forEach(n => {
      const type = ENTITY_STYLES[n.entityType as keyof typeof ENTITY_STYLES] ? n.entityType! : 'UNATTRIBUTED'
      counts.set(type, (counts.get(type) ?? 0) + 1)
    })
    return counts
  }, [nodes])
  const verifiedWallets = useMemo(
    () => nodes.filter(n => n.entityType === 'WALLET' && n.entityVerified).length,
    [nodes],
  )

  // Считаем уникальные кластеры для мини-легенды кластеров
  const clusterList = useMemo(() => {
    const seen = new Map<string, { color: string; size: number; role: string; archetype: string }>()
    nodes.forEach(n => {
      if (n.clusterId && (n.clusterSize ?? 1) > 1 && !seen.has(n.clusterId)) {
        seen.set(n.clusterId, {
          color:     clusterColor(n.clusterId).color,
          size:      n.clusterSize ?? 1,
          role:      n.clusterRole ?? 'UNKNOWN',
          archetype: n.clusterArchetype ?? 'UNKNOWN',
        })
      }
    })
    return [...seen.entries()].sort((a, b) => b[1].size - a[1].size)
  }, [nodes])

  // ===== ИНИЦИАЛИЗАЦИЯ ГРАФА =====
  useEffect(() => {
    if (!containerRef.current || !nodes.length) return

    const graph = new MultiGraph()
    const nodesById = new Map(nodes.map(n => [n.id, n]))

    // Раскладка по группам: центр — исследуемый кошелёк (в режиме токена — самый связанный узел)
    const positions = hubLayout(nodes.map(n => n.id), links, centerId)
    layoutRef.current = positions

    nodes.forEach((node) => {
      const isCenter = node.id === centerId
      const { color, borderColor } = getNodeColor(node, colorModeRef.current)
      graph.addNode(node.id, {
        ...positions.get(node.id),
        size:        isCenter ? CENTER_SIZE : getNodeSize(node),
        label:       shortAddress(node.walletAddress),
        forceLabel:  isCenter,
        hidden:      islands.ids.has(node.id) && !showIslandsRef.current,
        node,
        isCenter,
        color,
        borderColor: isCenter ? CENTER_BORDER : borderColor,
        // Биржи полупрозрачны через opacity в label
        opacity:     (node.isExchange || node.nodeType === 'EXCHANGE') ? 0.4 : 1,
      })
    })

    links.forEach((link) => {
      const edgeId = `${link.sourceId}-${link.targetId}`
      if (
        graph.hasNode(link.sourceId) &&
        graph.hasNode(link.targetId) &&
        !graph.hasEdge(edgeId)
      ) {
        graph.addEdgeWithKey(edgeId, link.sourceId, link.targetId, {
          size:  link.isCrossCluster ? 2.5 : 1.5,
          color: getEdgeColor(link, nodesById),
          link,
        })
      }
    })

    const sigma = new Sigma(graph, containerRef.current, {
      defaultNodeType:            'bordered',
      defaultDrawNodeHover:       () => undefined,
      labelColor:                 { color: '#1e293b' },
      labelSize:                  8,
      labelRenderedSizeThreshold: 1,
      nodeProgramClasses: {
        bordered: createNodeBorderProgram({
          borders: [
            { size: { attribute: 'borderSize', defaultValue: 0.6 }, color: { attribute: 'borderColor' } },
            { size: { fill: true }, color: { attribute: 'color' } },
          ],
        }),
      },
      defaultEdgeType:    'rectangle',
      edgeProgramClasses: { rectangle: EdgeRectangleProgram },
      enableEdgeEvents:   true,
    })

    sigma.on('clickNode', ({ node: nodeId }) => {
      setSelectedNode(graph.getNodeAttribute(nodeId, 'node') as Node)
    })
    sigma.on('clickStage', () => setSelectedNode(null))

    sigmaRef.current = sigma
    fitVisible(sigma, positions, showIslandsRef.current ? null : islands.ids)
    graphRef.current = graph

    const fa2 = new FA2Supervisor(graph, {
      settings: { ...inferSettings(graph), gravity: 0.5, slowDown: 30 },
    })
    // Силовая раскладка сама не запускается — она сбила бы группы; включается кнопкой
    fa2Ref.current = fa2
    setIsPlayed(false)

    return () => { fa2.kill(); sigma.kill() }
  }, [nodes, links, centerId, islands])

  // Показ/скрытие островов — без перестроения графа; масштаб подгоняется под видимое
  useEffect(() => {
    showIslandsRef.current = showIslands
    const sigma = sigmaRef.current, positions = layoutRef.current
    if (!sigma || !positions) return
    graphRef.current?.updateEachNodeAttributes((id, attrs) => ({ ...attrs, hidden: islands.ids.has(id) && !showIslands }))
    fitVisible(sigma, positions, showIslands ? null : islands.ids)
    sigma.getCamera().animatedReset({ duration: 300 })
  }, [showIslands, islands])

  // Переключение режима цвета — перекрашиваем узлы без перестроения графа и раскладки
  useEffect(() => {
    colorModeRef.current = colorMode
    graphRef.current?.updateEachNodeAttributes((_, attrs) => {
      const { color, borderColor } = getNodeColor(attrs.node as Node, colorMode)
      return { ...attrs, color, borderColor: attrs.isCenter ? CENTER_BORDER : borderColor }
    })
  }, [colorMode])

  const toggleLayout = () => {
    if (!fa2Ref.current) return
    if (isPlayed) fa2Ref.current.stop()
    else          fa2Ref.current.start()
    setIsPlayed(p => !p)
  }

  // Вернуть раскладку по группам (после ForceAtlas2) и показать граф целиком
  const resetLayout = () => {
    fa2Ref.current?.stop()
    setIsPlayed(false)
    const positions = layoutRef.current
    graphRef.current?.updateEachNodeAttributes((id, attrs) => ({ ...attrs, ...positions?.get(id) }))
    sigmaRef.current?.getCamera().animatedReset({ duration: 300 })
  }

  const zoomIn  = () => sigmaRef.current?.getCamera().animatedZoom({ duration: 300 })
  const zoomOut = () => sigmaRef.current?.getCamera().animatedUnzoom({ duration: 300 })

  const btnBase: React.CSSProperties = {
    background: '#ffffff', color: '#1e293b',
    border: '1px solid #999', borderRadius: 8,
    cursor: 'pointer', fontWeight: 500,
  }

  const isClusterNode = selectedNode?.clusterId && (selectedNode?.clusterSize ?? 1) > 1

  // ===== РЕНДЕР =====
  return (
    <div style={{ position: 'relative', width: '100%', height: 'calc(100vh - 200px)', minHeight: '600px', background: '#1e293b', borderRadius: 12, overflow: 'hidden' }}>

      {/* Канвас */}
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* ── Правый верхний угол: кнопки + легенды ── */}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6, zIndex: 10 }}>

        <button onClick={toggleLayout} style={{ ...btnBase, padding: '6px 12px', fontSize: 13 }}>
          {isPlayed ? '⏸ Pause' : '▶ ForceAtlas2'}
        </button>
        <button onClick={resetLayout} title="Вернуть раскладку по группам" style={{ ...btnBase, padding: '6px 12px', fontSize: 13 }}>
          ⟲ Группы
        </button>
        <button onClick={zoomIn} title="Увеличить" style={{ ...btnBase, height: 34, fontSize: 20, lineHeight: '32px', textAlign: 'center', padding: 0 }}>+</button>
        <button onClick={zoomOut} title="Уменьшить" style={{ ...btnBase, height: 34, fontSize: 20, lineHeight: '32px', textAlign: 'center', padding: 0 }}>−</button>

        {/* Легенда: переключатель режима цвета + категории */}
        <div style={{ background: 'rgba(255,255,255,0.92)', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px', marginTop: 2 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {([['owner', 'Владелец'], ['behavior', 'Поведение']] as const).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setColorMode(mode)}
                style={{
                  flex: 1, padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
                  border: '1px solid #cbd5e1',
                  background: colorMode === mode ? '#1e293b' : '#ffffff',
                  color:      colorMode === mode ? '#ffffff' : '#1e293b',
                  fontWeight: colorMode === mode ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {colorMode === 'owner'
            ? ENTITY_ORDER.map(type => {
                const count = entityCounts.get(type) ?? 0
                return (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, opacity: count ? 1 : 0.4 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: ENTITY_STYLES[type].color, flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: '#1e293b', whiteSpace: 'nowrap', flex: 1 }}>{ENTITY_STYLES[type].label}</span>
                    <span
                      style={{ fontSize: 11, color: '#64748b', marginLeft: 8 }}
                      title={type === 'WALLET' ? 'Проверено, что это не контракт: самые активные и крупные адреса; остальные считаются кошельками без проверки' : undefined}
                    >
                      {count.toLocaleString('ru-RU')}
                      {type === 'WALLET' && count > 0 ? ` (проверено ${verifiedWallets.toLocaleString('ru-RU')})` : ''}
                    </span>
                  </div>
                )
              })
            : BEHAVIOR_LEGEND.map(item => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: '#1e293b', whiteSpace: 'nowrap' }}>{item.label}</span>
                </div>
              ))}

          {colorMode === 'owner' && clusterList.length > 0 && (
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 4, maxWidth: 190, lineHeight: 1.4 }}>
              Цветная обводка — адрес входит в кластер
            </div>
          )}

          {/* Острова: группы адресов без связи с главной группой */}
          {islands.groups > 0 && (
            <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 8, paddingTop: 8 }}>
              <div
                style={{ fontSize: 11, color: '#1e293b', marginBottom: 6, maxWidth: 190, lineHeight: 1.4 }}
                title="Адреса, которые переводили только друг другу: с главной группой их не связывает ни один загруженный перевод"
              >
                Несвязанные группы: {islands.groups} ({islands.ids.size.toLocaleString('ru-RU')} адр.)
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {([[false, 'Скрыть'], [true, 'Показать']] as const).map(([show, label]) => (
                  <button
                    key={label}
                    onClick={() => setShowIslands(show)}
                    style={{
                      flex: 1, padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
                      border: '1px solid #cbd5e1',
                      background: showIslands === show ? '#1e293b' : '#ffffff',
                      color:      showIslands === show ? '#ffffff' : '#1e293b',
                      fontWeight: showIslands === show ? 600 : 400,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Мини-легенда кластеров (только если есть) */}
        {clusterList.length > 0 && (
          <div style={{ background: 'rgba(255,255,255,0.92)', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Clusters</div>
            {clusterList.slice(0, 8).map(([id, info]) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: info.color, flexShrink: 0 }} />
                {id.startsWith('0x') ? (
                  <a
                    href={`https://etherscan.io/address/${id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 11, color: '#1e293b', whiteSpace: 'nowrap', textDecoration: 'none' }}
                    onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                    onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                  >
                    {shortAddress(id)} · {info.size} ↗
                  </a>
                ) : (
                  <span style={{ fontSize: 11, color: '#1e293b', whiteSpace: 'nowrap' }}>
                    {shortAddress(id)} · {info.size}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Панель выбранного узла (левый верхний угол) ── */}
      {selectedNode && (
        <div style={{
          position: 'absolute', top: 12, left: 12,
          background: '#ffffff', border: '1px solid #d1d5db',
          borderRadius: 10, padding: 14, color: '#1e293b',
          width: 280, zIndex: 10, boxShadow: '0 2px 16px rgba(0,0,0,0.18)',
          maxHeight: 'calc(100% - 24px)',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}>

          {/* Цветная полоска — цвет кластера или типа */}
          <div style={{
            height: 3, borderRadius: 2, marginBottom: 10,
            background: isClusterNode
              ? clusterColor(selectedNode.clusterId!).color
              : getNodeColor(selectedNode, colorMode).color,
          }} />

          {/* Метка */}
          <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>
            {isClusterNode ? `Кластер · ${selectedNode.clusterSize} адресов` : 'Кошелёк'}
          </div>

          {/* Адрес — ссылка на Etherscan */}
          <a
            href={`https://etherscan.io/address/${selectedNode.walletAddress}`}
            target="_blank" rel="noopener noreferrer"
            style={{ display: 'block', fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: 1.6, color: '#2563eb', marginBottom: 10, textDecoration: 'none' }}
            onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
            onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
          >
            {selectedNode.walletAddress} ↗
          </a>

          <div style={{ borderTop: '1px solid #e2e8f0', marginBottom: 10 }} />

          {/* Владелец: категория + название или роль */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, fontSize: 13, marginBottom: 7 }}>
            <span style={{ color: '#64748b' }}>Владелец</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#1e293b', textAlign: 'right' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: entityStyle(selectedNode.entityType).color, flexShrink: 0 }} />
              {entityStyle(selectedNode.entityType).label}
              {selectedNode.entityName ? ` · ${selectedNode.entityName}` : ''}
              {selectedNode.entityType === 'WALLET' ? (selectedNode.entityVerified ? ' · проверен' : ' · не проверен') : ''}
            </span>
          </div>

          {/* Строки: базовые */}
          {[
            { label: 'Тип',         value: selectedNode.nodeType,                          green: false },
            {
              label: 'Баланс',
              value: selectedNode.balanceKnown === false ? '—' : formatUsd(selectedNode.usdValue || '$0.00'),
              green: selectedNode.balanceKnown !== false,
            },
            ...(selectedNode.tokenFlow !== undefined ? [{
              label: 'Поток токена',
              value: formatTokenFlow(selectedNode.tokenFlow, selectedNode.tokenSymbol),
              green: false,
            }] : []),
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 7 }}>
              <span style={{ color: '#64748b' }}>{row.label}</span>
              <span style={{ fontWeight: 600, color: row.green ? '#16a34a' : '#1e293b' }}>{row.value}</span>
            </div>
          ))}

          {/* Поведенческая группа K-means */}
          {selectedNode.behavior && (
            <div style={{ fontSize: 13, marginBottom: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#64748b' }}>Поведение (K-means)</span>
                <span style={{ fontWeight: 600, color: '#1e293b' }}>
                  Группа {selectedNode.behavior.group + 1} из {selectedNode.behavior.k}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>{selectedNode.behavior.label}</div>
            </div>
          )}

          {/* Блок кластера — только если нода в кластере */}
          {isClusterNode && (
            <>
              <div style={{ borderTop: '1px solid #e2e8f0', margin: '8px 0' }} />
              <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Кластер</div>

              {[
                { label: 'Роль',      value: ROLE_LABEL[selectedNode.clusterRole ?? ''] ?? selectedNode.clusterRole ?? '—' },
                { label: 'Архетип',   value: ARCHETYPE_LABEL[selectedNode.clusterArchetype ?? ''] ?? selectedNode.clusterArchetype ?? '—' },
                { label: 'Адресов',   value: String(selectedNode.clusterSize ?? 1) },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: '#64748b' }}>{row.label}</span>
                  <span style={{ fontWeight: 500, color: '#1e293b' }}>{row.value}</span>
                </div>
              ))}

              {/* Сигналы объединения */}
              {selectedNode.kmeansSignals && selectedNode.kmeansSignals.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Сигналы</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {selectedNode.kmeansSignals.map(sig => (
                      <span key={sig} style={{
                        fontSize: 10, padding: '2px 7px', borderRadius: 10,
                        background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0',
                      }}>{SIGNAL_LABEL[sig] ?? sig}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Цветная метка кластера */}
              <div style={{
                marginTop: 8, padding: '4px 10px', borderRadius: 6, fontSize: 11,
                background: clusterColor(selectedNode.clusterId!).color + '22',
                border: `1px solid ${clusterColor(selectedNode.clusterId!).color}55`,
                color: clusterColor(selectedNode.clusterId!).color,
                fontWeight: 600, textAlign: 'center',
              }}>
                {selectedNode.clusterId!.startsWith('0x') ? (
                  <a
                    href={`https://etherscan.io/address/${selectedNode.clusterId!}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'inherit', textDecoration: 'none' }}
                    onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                    onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                  >
                    ID: {shortAddress(selectedNode.clusterId!)} ↗
                  </a>
                ) : (
                  <>ID: {shortAddress(selectedNode.clusterId!)}</>
                )}
              </div>

              {/* Growth Readiness */}
              {selectedNode.gr && (
                <>
                  <div style={{ borderTop: '1px solid #e2e8f0', margin: '10px 0 0' }} />
                  <GRIndicator gr={selectedNode.gr} />
                </>
              )}

              {/* Markov фазы */}
              {selectedNode.markov && selectedNode.markov.currentPhase !== 'INACTIVE' && (
                <>
                  <div style={{ borderTop: '1px solid #e2e8f0', margin: '10px 0 0' }} />
                  <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginTop: 8 }}>
                    Markov / Фазы
                  </div>
                  <MarkovBlock markov={selectedNode.markov} />
                </>
              )}
            </>
          )}


          <button
            onClick={() => setSelectedNode(null)}
            style={{ marginTop: 12, width: '100%', padding: '5px 0', fontSize: 12, color: '#94a3b8', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }}
          >
            ✕ Закрыть
          </button>

        </div>
      )}

    </div>
  )
}
