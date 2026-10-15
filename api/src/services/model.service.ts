import { Injectable } from '@nestjs/common'
import type { LayersModel, Tensor } from '@tensorflow/tfjs'
import { CONFIG } from '../config'

type TensorFlow = typeof import('@tensorflow/tfjs')

// ===== MODEL SERVICE (Шаг 4: LSTM) =====
// Загружает OHLCV с Binance, считает индикаторы,
// обучает LSTM через tensorflow.js и предсказывает:
//   1. Направление цены: UP | DOWN (бинарная классификация)
//   2. Фазу рынка: TREND | SIDEWAYS | REVERSAL (3 класса)

export interface Candle {
  time:   number   // unix ms
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}

export interface Indicators {
  rsi:    number   // RSI-14
  macdH:  number   // MACD histogram
  bbPct:  number   // Bollinger %B (0=нижняя, 1=верхняя полоса)
  atr:    number   // ATR-14 нормализованный
  volRel: number   // объём / скользящее среднее объёма (20)
}

export interface PredictionResult {
  symbol:      string
  timeframe:   string
  lastClose:   number
  direction:   'UP' | 'DOWN'
  dirConf:     number   // уверенность 0..1
  phase:       'TREND' | 'SIDEWAYS' | 'REVERSAL'
  phaseConf:   number
  trainedOn:   number   // кол-во свечей
  trainedAt:   string   // ISO timestamp
  indicators:  Indicators
}

// Нативный TensorFlow (tfjs-node) считает в C++ и в разы быстрее чистого JS.
// Если нативная библиотека не загрузилась — откатываемся на @tensorflow/tfjs.
// Загружается лениво (require), чтобы TensorFlow не замедлял старт сервера и не грузился,
// пока никто не запросил прогноз.
let tfInstance: TensorFlow | null = null
export function loadTf(): TensorFlow {
  if (tfInstance) return tfInstance
  // tfjs-node 4.x вызывает util.isNullOrUndefined / util.isArray, удалённые в Node 23+
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const util = require('util')
  util.isNullOrUndefined ??= (v: unknown) => v === null || v === undefined
  util.isArray ??= Array.isArray
  let tf: TensorFlow
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    tf = require('@tensorflow/tfjs-node')
  } catch (err) {
    console.warn(`  [Model] tfjs-node недоступен, используем чистый JS: ${(err as Error).message}`)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    tf = require('@tensorflow/tfjs')
  }
  console.log(`  [Model] TensorFlow backend: ${tf.getBackend()}`)
  tfInstance = tf
  return tf
}

@Injectable()
export class ModelService {

  // Обучения, которые идут прямо сейчас: повторный запрос того же символа
  // ждёт уже запущенное обучение, а не запускает второе
  private inflight = new Map<string, Promise<PredictionResult>>()

  // Кэш обученных моделей: symbol → {model, result, trainedAt}
  private cache = new Map<string, {
    dirModel:   LayersModel
    phaseModel: LayersModel
    result:     PredictionResult
    trainedAt:  number
  }>()

  private readonly CACHE_TTL = 30 * 60 * 1000  // 30 минут

  // ── 1. Загрузка OHLCV с Binance ────────────────────────────────────
  async fetchCandles(symbol: string, timeframe = '1h', limit = CONFIG.lstmCandles): Promise<Candle[]> {
    // ccxt тяжёлый (сотни бирж) — грузим лениво, только при первом прогнозе
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ccxt = require('ccxt')
    const exchange = new ccxt.binance({ enableRateLimit: true })

    // Нормализуем символ: DODO → DODO/USDT, ETH → ETH/USDT
    const pair = symbol.toUpperCase().includes('/')
      ? symbol.toUpperCase()
      : `${symbol.toUpperCase()}/USDT`

    console.log(`  [LSTM] Загружаем ${limit} свечей ${pair} ${timeframe}...`)

    try {
      const raw = await exchange.fetchOHLCV(pair, timeframe, undefined, limit)
      return raw.map((c: number[]) => ({
        time:   c[0],
        open:   c[1],
        high:   c[2],
        low:    c[3],
        close:  c[4],
        volume: c[5],
      }))
    } catch (err) {
      throw new Error(`Binance fetchOHLCV failed for ${pair}: ${err}`)
    }
  }

  // ── 2. Технические индикаторы ───────────────────────────────────────

  private calcRSI(closes: number[], period = 14): number[] {
    const rsi: number[] = Array(period).fill(50)
    let avgGain = 0, avgLoss = 0

    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1]
      if (diff >= 0) avgGain += diff; else avgLoss -= diff
    }
    avgGain /= period
    avgLoss /= period

    for (let i = period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1]
      const gain = diff > 0 ? diff : 0
      const loss = diff < 0 ? -diff : 0
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      const rs  = avgLoss === 0 ? 100 : avgGain / avgLoss
      rsi.push(100 - 100 / (1 + rs))
    }
    return rsi
  }

  private calcEMA(values: number[], period: number): number[] {
    const k   = 2 / (period + 1)
    const ema = [values[0]]
    for (let i = 1; i < values.length; i++) {
      ema.push(values[i] * k + ema[i - 1] * (1 - k))
    }
    return ema
  }

  private calcMACD(closes: number[]): number[] {
    const ema12 = this.calcEMA(closes, 12)
    const ema26 = this.calcEMA(closes, 26)
    const macd  = ema12.map((v, i) => v - ema26[i])
    const signal = this.calcEMA(macd, 9)
    return macd.map((v, i) => v - signal[i])  // histogram
  }

  private calcBB(closes: number[], period = 20): number[] {
    const bbPct: number[] = []
    for (let i = 0; i < closes.length; i++) {
      if (i < period) { bbPct.push(0.5); continue }
      const slice = closes.slice(i - period, i)
      const mean  = slice.reduce((s, v) => s + v, 0) / period
      const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period)
      const upper = mean + 2 * std
      const lower = mean - 2 * std
      bbPct.push(std === 0 ? 0.5 : (closes[i] - lower) / (upper - lower))
    }
    return bbPct
  }

  private calcATR(candles: Candle[], period = 14): number[] {
    const tr  = candles.map((c, i) => {
      if (i === 0) return c.high - c.low
      const prev = candles[i - 1].close
      return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev))
    })
    const atr: number[] = [tr[0]]
    for (let i = 1; i < tr.length; i++) {
      atr.push((atr[i - 1] * (period - 1) + tr[i]) / period)
    }
    // Нормализуем ATR как долю от цены закрытия
    return atr.map((v, i) => candles[i].close > 0 ? v / candles[i].close : 0)
  }

  private calcVolRel(volumes: number[], period = 20): number[] {
    return volumes.map((v, i) => {
      if (i < period) return 1
      const avg = volumes.slice(i - period, i).reduce((s, x) => s + x, 0) / period
      return avg > 0 ? v / avg : 1
    })
  }

  private buildIndicators(candles: Candle[]): Indicators[] {
    const closes  = candles.map(c => c.close)
    const volumes = candles.map(c => c.volume)

    const rsi    = this.calcRSI(closes)
    const macdH  = this.calcMACD(closes)
    const bbPct  = this.calcBB(closes)
    const atr    = this.calcATR(candles)
    const volRel = this.calcVolRel(volumes)

    return candles.map((_, i) => ({
      rsi:    rsi[i]    / 100,           // нормализуем 0..1
      macdH:  Math.tanh(macdH[i] * 10), // сжимаем через tanh
      bbPct:  Math.max(0, Math.min(1, bbPct[i])),
      atr:    Math.min(1, atr[i] * 10),
      volRel: Math.min(3, volRel[i]) / 3,
    }))
  }

  // ── 3. Формирование обучающей выборки ──────────────────────────────
  // lookback окон по 30 свечей → предсказываем следующую свечу

  private buildDataset(candles: Candle[], indicators: Indicators[], lookback = CONFIG.lstmLookback) {
    const closes = candles.map(c => c.close)

    // Нормализуем цены относительно первой свечи окна
    const Xs: number[][][] = []
    const yDir:   number[] = []  // 1=UP 0=DOWN
    const yPhase: number[] = []  // 0=TREND 1=SIDEWAYS 2=REVERSAL

    for (let i = lookback; i < candles.length - 1; i++) {
      const window = candles.slice(i - lookback, i)
      const indWin = indicators.slice(i - lookback, i)
      const basePrice = window[0].close

      // Входной вектор: [normClose, normVol, rsi, macdH, bbPct, atr, volRel]
      const X = window.map((c, j) => [
        (c.close  - basePrice) / (basePrice || 1),
        Math.min(1, indWin[j].volRel),
        indWin[j].rsi,
        indWin[j].macdH,
        indWin[j].bbPct,
        indWin[j].atr,
        indWin[j].volRel,
      ])
      Xs.push(X)

      // Метка направления
      yDir.push(closes[i + 1] > closes[i] ? 1 : 0)

      // Метка фазы: считаем по последним 10 свечам окна
      const last10 = window.slice(-10).map(c => c.close)
      const trend  = (last10[last10.length - 1] - last10[0]) / (last10[0] || 1)
      const hiLo   = Math.max(...last10) - Math.min(...last10)
      const avgPr  = last10.reduce((s, v) => s + v, 0) / last10.length
      const range  = hiLo / (avgPr || 1)

      if (Math.abs(trend) > 0.02)       yPhase.push(0)  // TREND
      else if (range < 0.015)           yPhase.push(1)  // SIDEWAYS
      else                              yPhase.push(2)  // REVERSAL
    }

    return { Xs, yDir, yPhase }
  }

  // ── 4. Обучение модели (Conv1D — быстрее LSTM в ~8x на чистом JS) ──
  // Conv1D захватывает локальные паттерны в ценовом ряду без тяжёлых
  // рекуррентных весов. На 1000 свечей обучается за ~30–60 секунд.
  async trainModels(candles: Candle[], indicators: Indicators[]): Promise<{ dirModel: LayersModel; phaseModel: LayersModel }> {
    const tf = loadTf()

    const LOOKBACK = CONFIG.lstmLookback
    const FEATURES = 7
    const { Xs, yDir, yPhase } = this.buildDataset(candles, indicators, LOOKBACK)

    console.log(`  [Model] Обучающая выборка: ${Xs.length} примеров, lookback=${LOOKBACK}`)

    const xTensor    = tf.tensor3d(Xs, [Xs.length, LOOKBACK, FEATURES])
    const yDirTensor = tf.tensor2d(yDir.map(v => [v, 1 - v]), [yDir.length, 2])
    const yPhTensor  = tf.oneHot(tf.tensor1d(yPhase, 'int32'), 3)

    // Строим Conv1D модель (одна фабрика для направления и фазы)
    const buildModel = (outUnits: number) => {
      const m = tf.sequential()
      // Conv1D: 32 фильтра, ядро 3 — ловит паттерны из 3 свечей
      m.add(tf.layers.conv1d({
        filters: 32, kernelSize: 3, activation: 'relu',
        inputShape: [LOOKBACK, FEATURES],
        kernelInitializer: 'glorotUniform',
      }))
      // Ещё один Conv1D: 16 фильтров, ядро 3
      m.add(tf.layers.conv1d({
        filters: 16, kernelSize: 3, activation: 'relu',
        kernelInitializer: 'glorotUniform',
      }))
      // GlobalAveragePooling сворачивает временное измерение в вектор
      m.add(tf.layers.globalAveragePooling1d())
      m.add(tf.layers.dense({ units: 16, activation: 'relu' }))
      m.add(tf.layers.dropout({ rate: 0.1 }))
      m.add(tf.layers.dense({ units: outUnits, activation: 'softmax' }))
      m.compile({ optimizer: tf.train.adam(0.001), loss: 'categoricalCrossentropy', metrics: ['accuracy'] })
      return m
    }

    const dirModel   = buildModel(2)
    const phaseModel = buildModel(3)

    console.log('  [Model] Обучаем модель направления...')
    await dirModel.fit(xTensor, yDirTensor, {
      epochs: CONFIG.lstmEpochs, batchSize: CONFIG.lstmBatch, verbose: 0,
    })

    console.log('  [Model] Обучаем модель фазы...')
    await phaseModel.fit(xTensor, yPhTensor, {
      epochs: CONFIG.lstmEpochs, batchSize: CONFIG.lstmBatch, verbose: 0,
    })

    xTensor.dispose()
    yDirTensor.dispose()
    yPhTensor.dispose()

    return { dirModel, phaseModel }
  }

  // ── 5. Предсказание по последнему окну ────────────────────────────
  async predict(symbol: string, forceRetrain = false): Promise<PredictionResult> {
    const key = symbol.toUpperCase()

    // Проверяем кэш
    const cached = this.cache.get(key)
    if (!forceRetrain && cached && Date.now() - cached.trainedAt < this.CACHE_TTL) {
      console.log(`  [Model] Кэш HIT: ${symbol} (${Math.round((Date.now() - cached.trainedAt) / 60000)} мин назад)`)
      return cached.result
    }

    const running = this.inflight.get(key)
    if (running) {
      console.log(`  [Model] Ждём уже идущее обучение: ${symbol}`)
      return running
    }

    const job = this.trainAndPredict(symbol).finally(() => this.inflight.delete(key))
    this.inflight.set(key, job)
    return job
  }

  private async trainAndPredict(symbol: string): Promise<PredictionResult> {
    const tf = loadTf()

    // Загружаем данные
    const t0         = Date.now()
    const candles    = await this.fetchCandles(symbol)
    const indicators = this.buildIndicators(candles)

    // Обучаем
    const { dirModel, phaseModel } = await this.trainModels(candles, indicators)
    console.log(`  [Model] Обучение заняло ${((Date.now() - t0) / 1000).toFixed(1)}с`)

    // Предсказываем по последнему окну (30 свечей)
    const LOOKBACK = CONFIG.lstmLookback
    const last     = candles.slice(-LOOKBACK)
    const lastInd  = indicators.slice(-LOOKBACK)
    const basePrice = last[0].close

    const inputArr = last.map((c, j) => [
      (c.close - basePrice) / (basePrice || 1),
      Math.min(1, lastInd[j].volRel),
      lastInd[j].rsi,
      lastInd[j].macdH,
      lastInd[j].bbPct,
      lastInd[j].atr,
      lastInd[j].volRel,
    ])

    const inputTensor = tf.tensor3d([inputArr], [1, CONFIG.lstmLookback, 7])

    const dirPred   = dirModel.predict(inputTensor) as Tensor
    const phasePred = phaseModel.predict(inputTensor) as Tensor

    const dirArr   = await dirPred.data()   as Float32Array
    const phaseArr = await phasePred.data() as Float32Array

    inputTensor.dispose()
    dirPred.dispose()
    phasePred.dispose()

    const PHASES = ['TREND', 'SIDEWAYS', 'REVERSAL'] as const
    const phaseIdx = phaseArr.indexOf(Math.max(...Array.from(phaseArr)))

    const lastCandle = candles[candles.length - 1]
    const lastIndic  = indicators[indicators.length - 1]

    const result: PredictionResult = {
      symbol:      symbol.toUpperCase(),
      timeframe:   '1h',
      lastClose:   lastCandle.close,
      direction:   dirArr[0] > dirArr[1] ? 'UP' : 'DOWN',
      dirConf:     Math.round(Math.max(dirArr[0], dirArr[1]) * 1000) / 1000,
      phase:       PHASES[phaseIdx],
      phaseConf:   Math.round(phaseArr[phaseIdx] * 1000) / 1000,
      trainedOn:   candles.length,
      trainedAt:   new Date().toISOString(),
      indicators: {
        rsi:    Math.round(lastIndic.rsi * 100 * 10) / 10,
        macdH:  Math.round(lastIndic.macdH * 10000) / 10000,
        bbPct:  Math.round(lastIndic.bbPct * 1000) / 1000,
        atr:    Math.round(lastIndic.atr * 10000) / 10000,
        volRel: Math.round(lastIndic.volRel * 3 * 100) / 100,
      },
    }

    // Кэшируем; старые модели этого символа освобождаем, иначе их веса копятся в памяти
    const prev = this.cache.get(symbol.toUpperCase())
    if (prev) {
      prev.dirModel.dispose()
      prev.phaseModel.dispose()
    }
    this.cache.set(symbol.toUpperCase(), { dirModel, phaseModel, result, trainedAt: Date.now() })
    console.log(`  [Model] Готово: ${symbol} dir=${result.direction}(${result.dirConf}) phase=${result.phase}(${result.phaseConf})`)

    return result
  }
}
