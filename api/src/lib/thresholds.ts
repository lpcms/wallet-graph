// Пороги эвристик кластеризации и аналитики — в долларах, одинаковые для любого актива.
// Раньше они были в штуках актива: 0.001 «пыли» — это ~$2 для ETH, но ~$100 для WBTC
// и ~$0.000004 для токена по $0.004.

export const DUST_USD       = 2     // перевод дешевле — «пыль» (рассылки для привязки адресов)
export const FUNDED_MIN_USD = 100   // «общий источник»: учитываются переводы от этой суммы
export const INACTIVE_USD   = 2     // окно Markov с оборотом меньше — неактивное

// Те же пороги в штуках актива, если его цена неизвестна (прежние значения, подобранные под ETH)
const FALLBACK_UNITS = { dust: 0.001, fundedMin: 0.05, inactive: 0.001 }

export interface AmountThresholds {
  dust:      number          // в штуках актива
  fundedMin: number
  inactive:  number
  priceUsd:  number | null   // цена актива; null — неизвестна, пороги в штуках
}

export function thresholdsFor(priceUsd: number | null): AmountThresholds {
  if (!priceUsd || !Number.isFinite(priceUsd) || priceUsd <= 0) return { ...FALLBACK_UNITS, priceUsd: null }
  return {
    dust:      DUST_USD / priceUsd,
    fundedMin: FUNDED_MIN_USD / priceUsd,
    inactive:  INACTIVE_USD / priceUsd,
    priceUsd,
  }
}
