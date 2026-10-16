'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import type { Node, Link } from './types/graph'
import { API_URL } from './lib/api'
import { capitalizationText, formatPrice, type Capitalization } from './lib/format'
import { clamp, estimateMinutes, HOPS_MAX, HOPS_MIN, WIDTH_MAX, WIDTH_MIN } from './lib/hops'

const WalletGraph = dynamic(() => import('./components/WalletGraph'), { ssr: false })

interface PredictionResult {
  symbol:    string
  timeframe: string
  lastClose: number
  direction: 'UP' | 'DOWN'
  dirConf:   number
  phase:     'TREND' | 'SIDEWAYS' | 'REVERSAL'
  phaseConf: number
  trainedOn: number
  trainedAt: string
  indicators: { rsi: number; macdH: number; bbPct: number; atr: number; volRel: number }
  error?:    string
}

type SearchMode = 'wallet' | 'token'


// Поля «Хопов» и «Адресов на хоп»
const numberInputStyle = {
  width: 64, padding: '8px 10px', borderRadius: 8,
  border: '1px solid #334155', background: '#1e293b', color: '#fff', fontSize: 14,
}

export default function Home() {
  const [nodes, setNodes] = useState<Node[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode]   = useState<SearchMode>('token')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [info, setInfo]         = useState('')
  const [ticker, setTicker]     = useState('')
  // Цена токена с Binance (null — неизвестна, пороги эвристик в штуках токена)
  const [tokenPrice, setTokenPrice] = useState<number | null | undefined>(undefined)
  // Адрес в центре графа: исследуемый кошелёк (в режиме токена — самый связанный узел)
  const [center, setCenter]     = useState('')

  // Граф кошелька: сколько хопов раскрывать и сколько адресов на каждом
  const [hops, setHops]         = useState(15)
  const [hopWidth, setHopWidth] = useState(10)

  // Накопительный режим
  const [fullMode, setFullMode] = useState(false)
  const [fullProgress, setFullProgress] = useState<{
    page: number; loaded: number; message: string; done: boolean; cached?: boolean
  } | null>(null)

  // LSTM
  const [prediction, setPrediction]   = useState<PredictionResult | null>(null)
  const [predLoading, setPredLoading] = useState(false)
  const [predSymbol, setPredSymbol]   = useState('')

  // ── Граф токена ───────────────────────────────────────────────────
  const fetchGraph = async () => {
    if (!input.trim()) return
    setLoading(true)
    setError('')
    setInfo('')
    setTicker('')
    setTokenPrice(undefined)
    setFullProgress(null)
    try {
      const res  = await fetch(`${API_URL}/graph/token/${input.trim()}`)
      const data = await res.json()
      if (!data.nodes?.length) {
        setError(data.message || 'Данные не найдены')
        setNodes([]); setLinks([])
      } else {
        setNodes(data.nodes)
        setCenter('')
        setLinks(data.links)
        if (data.ticker) setTicker(data.ticker)
        setTokenPrice(data.assetPriceUsd ?? null)
        setInfo(`Загружено: ${data.nodes.length} кошельков, ${data.links.length} транзакций`)
      }
    } catch {
      setError('Ошибка соединения с API')
    }
    setLoading(false)
  }

  // ── Полная загрузка (SSE) ─────────────────────────────────────────
  const fetchFullGraph = () => {
    if (!input.trim()) return
    setLoading(true)
    setError('')
    setInfo('')
    setTicker('')
    setTokenPrice(undefined)
    setNodes([])
    setLinks([])
    setFullProgress({ page: 0, loaded: 0, message: 'Подключаемся...', done: false })

    const es = new EventSource(`${API_URL}/graph/token/${input.trim()}/full`)

    es.onmessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data)

      if (data.type === 'progress') {
        setFullProgress({
          page:    data.page,
          loaded:  data.loaded,
          message: data.message || `Загружено ${data.loaded.toLocaleString()} транзакций...`,
          done:    false,
          cached:  data.cached,
        })
      }
      if (data.type === 'analyzing') {
        setFullProgress({ page: 0, loaded: data.loaded, message: 'Анализируем кластеры...', done: false })
      }
      if (data.type === 'done') {
        setNodes(data.nodes ?? [])
        setCenter('')
        setLinks(data.links ?? [])
        if (data.ticker) setTicker(data.ticker)
        setTokenPrice(data.assetPriceUsd ?? null)
        setInfo(`Загружено: ${data.nodesCount} кошельков, ${data.totalTransactions} транзакций`)
        setFullProgress(prev => ({ ...prev!, done: true, message: 'Готово!' }))
        setLoading(false)
        es.close()
      }
      if (data.type === 'error') {
        setError(data.message)
        setLoading(false)
        setFullProgress(null)
        es.close()
      }
    }

    es.onerror = () => {
      setError('Ошибка SSE соединения')
      setLoading(false)
      setFullProgress(null)
      es.close()
    }
  }

  // ── Граф кошелька с прогрессом по хопам (SSE) ─────────────────────
  const fetchWalletGraph = () => {
    const address = input.trim()
    if (!address) return
    setLoading(true)
    setError('')
    setInfo('')
    setTicker('')
    setTokenPrice(undefined)
    setFullProgress({ page: 0, loaded: 0, message: 'Подключаемся…', done: false })

    const es = new EventSource(`${API_URL}/graph/wallet/${address}/stream?hops=${hops}&width=${hopWidth}`)
    const finish = () => { setLoading(false); es.close() }

    es.onmessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.type === 'progress') {
        setFullProgress({ page: 0, loaded: data.transactions ?? 0, message: data.message, done: false })
      }
      if (data.type === 'done') {
        setFullProgress(null)
        if (!data.nodes?.length) {
          setError(data.message || 'Данные не найдены')
          setNodes([]); setLinks([])
        } else {
          setNodes(data.nodes)
          setCenter(address.toLowerCase())
          setLinks(data.links)
          const cap: Capitalization | undefined = data.capitalization
          const capText = cap ? `, ${capitalizationText(cap, data.reachedHop ?? 1)}` : ''
          const hopText = data.reachedHop ? `, хопов: ${data.reachedHop} из ${data.hops}` : ''
          setInfo(`Загружено: ${data.nodes.length} кошельков, ${data.links.length} транзакций${hopText}${capText}`)
        }
        finish()
      }
      if (data.type === 'error') {
        setError(data.message)
        setFullProgress(null)
        finish()
      }
    }
    es.onerror = () => {
      setError('Ошибка соединения с API')
      setFullProgress(null)
      finish()
    }
  }

  const handleBuild = () => {
    if (mode === 'wallet') fetchWalletGraph()
    else if (fullMode) fetchFullGraph()
    else fetchGraph()
  }

  // ── LSTM ──────────────────────────────────────────────────────────
  const fetchPrediction = async (sym?: string) => {
    const s = (sym ?? predSymbol ?? ticker).trim()
    if (!s) return
    setPredLoading(true)
    setPrediction(null)
    try {
      const res  = await fetch(`${API_URL}/predict/${s}`)
      const data = await res.json()
      setPrediction(data)
    } catch {
      setPrediction({ error: 'Ошибка соединения с API' } as PredictionResult)
    }
    setPredLoading(false)
  }

  const btnStyle = (active: boolean) => ({
    padding: '8px 20px', borderRadius: 8, cursor: 'pointer',
    fontSize: 14, border: '1px solid #334155',
    background: active ? '#3b82f6' : '#1e293b',
    color: '#fff',
  })

  return (
    <main style={{ padding: 32, background: '#0a0f1e', minHeight: '100vh' }}>
      <h1 style={{ color: '#fff', marginBottom: 8 }}>Wallet Graph</h1>
      <p style={{ color: '#64748b', marginBottom: 24 }}>
        Визуализация связей между кошельками на основе реальных данных Etherscan
      </p>

      {/* Переключатель режима */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button style={btnStyle(mode === 'token')} onClick={() => setMode('token')}>
          🪙 По токену (ERC-20)
        </button>
        <button style={btnStyle(mode === 'wallet')} onClick={() => setMode('wallet')}>
          👛 По кошельку
        </button>
      </div>

      {/* Поле ввода + кнопки */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleBuild()}
          placeholder={mode === 'wallet' ? 'Адрес кошелька: 0x...' : 'Адрес контракта токена: 0x...'}
          style={{
            padding: '10px 16px', borderRadius: 8,
            border: '1px solid #334155', background: '#1e293b',
            color: '#fff', fontSize: 15, width: 460,
          }}
        />

        {/* Чекбокс «Все транзакции» — только для токена */}
        {mode === 'token' && (
          <label style={{
            display: 'flex', alignItems: 'center', gap: 7,
            cursor: 'pointer', userSelect: 'none',
            color: fullMode ? '#6366f1' : '#94a3b8',
            fontSize: 14, fontWeight: fullMode ? 600 : 400,
            padding: '8px 14px',
            border: `1px solid ${fullMode ? '#6366f1' : '#334155'}`,
            borderRadius: 8,
            background: fullMode ? '#1e1b4b' : '#1e293b',
            transition: 'all .15s',
          }}>
            <input
              type="checkbox"
              checked={fullMode}
              onChange={e => setFullMode(e.target.checked)}
              style={{ accentColor: '#6366f1', width: 15, height: 15, cursor: 'pointer' }}
            />
            Все транзакции
          </label>
        )}

        {/* Хопы — только для кошелька */}
        {mode === 'wallet' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#94a3b8', fontSize: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Хопов
              <input
                type="number" min={HOPS_MIN} max={HOPS_MAX} value={hops}
                onChange={e => setHops(clamp(Number(e.target.value), HOPS_MIN, HOPS_MAX))}
                style={numberInputStyle}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Адресов на хоп
              <input
                type="number" min={WIDTH_MIN} max={WIDTH_MAX} value={hopWidth}
                onChange={e => setHopWidth(clamp(Number(e.target.value), WIDTH_MIN, WIDTH_MAX))}
                style={numberInputStyle}
              />
            </label>
            <span style={{ fontSize: 12, color: '#64748b' }} title="Etherscan на бесплатном ключе — 3 запроса в секунду">
              ≈ до {estimateMinutes(hops, hopWidth).toLocaleString('ru-RU')} мин
            </span>
          </div>
        )}

        <button
          onClick={handleBuild}
          disabled={loading}
          style={{
            padding: '10px 24px', borderRadius: 8,
            background: loading ? '#334155' : fullMode && mode === 'token' ? '#6366f1' : '#3b82f6',
            color: '#fff', border: 'none',
            cursor: loading ? 'default' : 'pointer',
            fontSize: 15, fontWeight: 500,
          }}
        >
          {loading
            ? (fullMode && mode === 'token' ? 'Загружаем…' : 'Загрузка…')
            : (fullMode && mode === 'token' ? '🔍 Полный скан' : 'Построить граф')}
        </button>

        {/* Прелоадер — крутится, пока строится граф */}
        {loading && <span className="spinner" role="status" aria-label="Граф строится" />}
      </div>

      {/* Подсказка */}
      <p style={{ color: '#475569', fontSize: 13, marginBottom: 4 }}>
        {mode === 'token'
          ? 'Пример: 0xdAC17F958D2ee523a2206206994597C13D831ec7 (USDT)'
          : 'Пример: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 (Vitalik Buterin)'}
      </p>
      {mode === 'token' && (
        <p style={{ color: '#475569', fontSize: 12, marginBottom: 20 }}>
          «Все транзакции» — загружает полную историю токена (может занять несколько минут)
        </p>
      )}

      {/* Статус */}
      {error && <p style={{ color: '#ef4444', fontSize: 15, marginBottom: 16 }}>⚠️ {error}</p>}
      {info && (
        <p style={{ color: 'rgb(22, 163, 74)', fontSize: 20, fontWeight: 600, marginBottom: 16 }}>
          ✅ {info}{ticker ? ` · Токен: ${ticker}` : ''}
          {ticker && tokenPrice !== undefined && (
            <span style={{ fontSize: 15, fontWeight: 400, color: tokenPrice === null ? '#f59e0b' : 'rgb(22, 163, 74)' }}>
              {tokenPrice === null ? ' (цена неизвестна — пороги эвристик в штуках токена)' : ` (${formatPrice(tokenPrice)})`}
            </span>
          )}
        </p>
      )}

      {/* Прогресс полной загрузки */}
      {fullProgress && !fullProgress.done && (
        <div style={{
          marginBottom: 16, background: '#1e293b', borderRadius: 10,
          padding: '14px 18px', border: '1px solid #334155',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: '#94a3b8', fontSize: 13 }}>{fullProgress.message}</span>
            <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>
              {fullProgress.loaded.toLocaleString()} tx
              {fullProgress.cached ? ' · из кэша' : ''}
            </span>
          </div>
          <div style={{ height: 6, background: '#334155', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              background: 'linear-gradient(90deg, #6366f1, #3b82f6)',
              width: '100%',
              animation: 'progressPulse 1.5s ease-in-out infinite',
            }} />
          </div>
          {fullProgress.page > 0 && (
            <div style={{ fontSize: 11, color: '#475569', marginTop: 6 }}>
              Страница {fullProgress.page} · ~{Math.round(fullProgress.page * 0.25)}с прошло
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes progressPulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @keyframes spin { to { transform: rotate(360deg) } }
        .spinner {
          width: 26px; height: 26px; border-radius: 50%;
          border: 3px solid #334155; border-top-color: #3b82f6;
          animation: spin .8s linear infinite;
          display: inline-block; flex-shrink: 0;
        }
      `}</style>

      {/* ── LSTM прогноз ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <input
            value={predSymbol}
            onChange={e => setPredSymbol(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && fetchPrediction()}
            placeholder="Символ: ETH, BTC, DODO..."
            style={{
              padding: '8px 14px', borderRadius: 8,
              border: '1px solid #334155', background: '#1e293b',
              color: '#fff', fontSize: 14, width: 220,
            }}
          />
          <button
            onClick={() => fetchPrediction()}
            disabled={predLoading}
            style={{
              padding: '8px 18px', borderRadius: 8,
              background: predLoading ? '#334155' : '#7c3aed',
              color: '#fff', border: 'none',
              cursor: predLoading ? 'default' : 'pointer',
              fontSize: 14, fontWeight: 500,
            }}
          >
            {predLoading ? '⏳ Обучение...' : '🤖 LSTM прогноз'}
          </button>
          {ticker && !predLoading && (
            <button
              onClick={() => fetchPrediction(ticker)}
              style={{
                padding: '8px 14px', borderRadius: 8,
                background: '#1e293b', color: '#94a3b8',
                border: '1px solid #334155', cursor: 'pointer', fontSize: 13,
              }}
            >
              Прогноз для {ticker}
            </button>
          )}
        </div>

        {prediction && !prediction.error && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
            <div style={{
              background: prediction.direction === 'UP' ? '#052e16' : '#450a0a',
              border: `1px solid ${prediction.direction === 'UP' ? '#166534' : '#991b1b'}`,
              borderRadius: 10, padding: '12px 18px', minWidth: 140,
            }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Направление</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: prediction.direction === 'UP' ? '#4ade80' : '#f87171' }}>
                {prediction.direction === 'UP' ? '↑ Вверх' : '↓ Вниз'}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                уверенность {Math.round(prediction.dirConf * 100)}%
              </div>
            </div>

            <div style={{ background: '#0c1a2e', border: '1px solid #1e3a5f', borderRadius: 10, padding: '12px 18px', minWidth: 140 }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Фаза рынка</div>
              <div style={{
                fontSize: 20, fontWeight: 600,
                color: prediction.phase === 'TREND' ? '#60a5fa' : prediction.phase === 'SIDEWAYS' ? '#fbbf24' : '#f472b6',
              }}>
                {prediction.phase === 'TREND' ? '📈 Тренд' : prediction.phase === 'SIDEWAYS' ? '↔ Боковик' : '🔄 Разворот'}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                уверенность {Math.round(prediction.phaseConf * 100)}%
              </div>
            </div>

            <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: '12px 18px', minWidth: 200 }}>
              <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                {prediction.symbol} · {prediction.timeframe} · ${prediction.lastClose.toLocaleString()}
              </div>
              {[
                { label: 'RSI',     value: String(prediction.indicators.rsi) },
                { label: 'BB %B',   value: Math.round(prediction.indicators.bbPct * 100) + '%' },
                { label: 'Vol/Avg', value: prediction.indicators.volRel + 'x' },
              ].map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: '#64748b' }}>{r.label}</span>
                  <span style={{ color: '#e2e8f0', fontWeight: 500 }}>{r.value}</span>
                </div>
              ))}
              <div style={{ fontSize: 10, color: '#334155', marginTop: 6 }}>
                обучено на {prediction.trainedOn} свечах
              </div>
            </div>
          </div>
        )}

        {prediction?.error && (
          <p style={{ color: '#ef4444', fontSize: 13 }}>⚠️ {prediction.error}</p>
        )}
      </div>

      {/* Граф */}
      {nodes.length > 0 && <WalletGraph nodes={nodes} links={links} centerAddress={center || undefined} />}
    </main>
  )
}
