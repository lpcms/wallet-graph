'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import type { Node, Link } from './types/graph'
import { API_URL } from './lib/api'
import { formatUsd } from './lib/format'

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

interface Capitalization {
  fullUsd:          number
  fullAddresses:    number
  clusterUsd:       number
  clusterAddresses: number
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

  // Накопительный режим
  const [fullMode, setFullMode] = useState(false)
  const [fullProgress, setFullProgress] = useState<{
    page: number; loaded: number; message: string; done: boolean; cached?: boolean
  } | null>(null)

  // LSTM
  const [prediction, setPrediction]   = useState<PredictionResult | null>(null)
  const [predLoading, setPredLoading] = useState(false)
  const [predSymbol, setPredSymbol]   = useState('')

  // ── Обычная загрузка ─────────────────────────────────────────────
  const fetchGraph = async () => {
    if (!input.trim()) return
    setLoading(true)
    setError('')
    setInfo('')
    setTicker('')
    setFullProgress(null)
    try {
      const endpoint = mode === 'wallet'
        ? `${API_URL}/graph/wallet/${input.trim()}`
        : `${API_URL}/graph/token/${input.trim()}`
      const res  = await fetch(endpoint)
      const data = await res.json()
      if (!data.nodes?.length) {
        setError(data.message || 'Данные не найдены')
        setNodes([]); setLinks([])
      } else {
        setNodes(data.nodes)
        setLinks(data.links)
        if (mode === 'token' && data.ticker) setTicker(data.ticker)
        const cap: Capitalization | undefined = data.capitalization
        const capText = cap
          ? `, полная капитализация ${formatUsd(cap.fullUsd)}` +
            `, кластер (${cap.clusterAddresses} адр.) ${formatUsd(cap.clusterUsd)}`
          : ''
        setInfo(`Загружено: ${data.nodes.length} кошельков, ${data.links.length} транзакций${capText}`)
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
        setLinks(data.links ?? [])
        if (data.ticker) setTicker(data.ticker)
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

  const handleBuild = () => {
    if (mode === 'token' && fullMode) fetchFullGraph()
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
            ? (fullMode && mode === 'token' ? '⏳ Загружаем...' : '⏳ Загрузка...')
            : (fullMode && mode === 'token' ? '🔍 Полный скан' : 'Построить граф')}
        </button>
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

      <style>{`@keyframes progressPulse { 0%,100%{opacity:1} 50%{opacity:.4} }`}</style>

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
      {nodes.length > 0 && <WalletGraph nodes={nodes} links={links} />}
    </main>
  )
}
