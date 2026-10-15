import type { EtherscanTransaction } from '../types'

// Сумма перевода в единицах самого актива: обычная tx (txlist) — ETH, 18 знаков;
// перевод токена (tokentx) — по tokenDecimal (у USDT/USDC 6, у WBTC 8, у большинства ERC-20 18)
export function txAmount(tx: EtherscanTransaction): number {
  return Number(tx.value) / 10 ** txDecimals(tx)
}

export function txDecimals(tx: EtherscanTransaction): number {
  const decimals = Number(tx.tokenDecimal)
  return tx.tokenDecimal !== undefined && tx.tokenDecimal !== '' && Number.isFinite(decimals) ? decimals : 18
}

// Перевод токена, а не ETH: у таких tx Etherscan заполняет tokenDecimal
export function isTokenTransfer(tx: EtherscanTransaction): boolean {
  return tx.tokenDecimal !== undefined && tx.tokenDecimal !== ''
}
