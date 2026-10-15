import * as dotenv from 'dotenv'
dotenv.config()


// ===== КОНФИГ ИЗ .env =====

export const CONFIG = {
  // Etherscan
  etherscanApiKey:  process.env.ETHERSCAN_API_KEY   || '',
  etherscanChainId: process.env.ETHERSCAN_CHAIN_ID  || '1',
  // Минимальный интервал между запросами к Etherscan (бесплатный ключ — 3 запроса/с)
  etherscanIntervalMs: Number(process.env.ETHERSCAN_INTERVAL_MS) || 350,

  // Обычный режим (/graph/token/:address)
  pageSize:    Number(process.env.PAGE_SIZE)    || 1000,
  maxPages:    Number(process.env.MAX_PAGES)    || 5,
  cacheTtlMs:  Number(process.env.CACHE_TTL_MS) || 300_000,

  // Полное сканирование (/graph/token/:address/full)
  fullPageSize: Number(process.env.FULL_PAGE_SIZE) || 1000,
  fullMaxPages: Number(process.env.FULL_MAX_PAGES) || 0,      // 0 = без ограничений
  fullDelayMs:  Number(process.env.FULL_DELAY_MS)  || 220,
  fullCacheTtl: Number(process.env.FULL_CACHE_TTL) || 3_600_000,

  // Сервер
  port: Number(process.env.PORT) || 3001,

  // LSTM модель (шаг 4)
  lstmEpochs:   Number(process.env.LSTM_EPOCHS)   || 10,
  lstmBatch:    Number(process.env.LSTM_BATCH)    || 64,
  lstmLookback: Number(process.env.LSTM_LOOKBACK) || 30,
  lstmCandles:  Number(process.env.LSTM_CANDLES)  || 1000,
}
