// $612,4 тыс. · $1,25 млн · $3,8 млрд · $1,1 трлн
const UNITS = [
  { value: 1e12, label: 'трлн' },
  { value: 1e9,  label: 'млрд' },
  { value: 1e6,  label: 'млн' },
  { value: 1e3,  label: 'тыс.' },
]

export const formatUsd = (usd: number): string => {
  const sign = usd < 0 ? '-' : ''
  const abs  = Math.abs(usd)
  const unit = UNITS.find(u => abs >= u.value)
  if (!unit) return `${sign}$${Math.round(abs).toLocaleString('ru-RU')}`
  const scaled = abs / unit.value
  const num = scaled.toLocaleString('ru-RU', { maximumFractionDigits: scaled < 10 ? 2 : 1 })
  return `${sign}$${num} ${unit.label}`
}

// Цена за единицу: $2 400 · $1,05 · $0,004321 — у дешёвых токенов 4 значащие цифры
export const formatPrice = (usd: number): string =>
  usd >= 1
    ? `$${usd.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}`
    : `$${usd.toLocaleString('ru-RU', { maximumSignificantDigits: 4 })}`

export interface Capitalization {
  nearHops:         number   // граница ближнего окружения, в хопах
  nearUsd:          number
  nearAddresses:    number
  allUsd:           number
  allAddresses:     number
  clusterUsd:       number
  clusterAddresses: number
}

// «капитализация: ближнее окружение (до 2 хопов) $5,9 млн, всё окружение (15 хопов) $180 млн, кластер (1 адр.) $491 тыс.»
// Если хопов не больше границы ближнего окружения, обе суммы совпадают — показываем одну
export function capitalizationText(cap: Capitalization, reachedHop: number): string {
  const cluster = `кластер (${cap.clusterAddresses} адр.) ${formatUsd(cap.clusterUsd)}`
  if (reachedHop <= cap.nearHops) return `капитализация ${formatUsd(cap.nearUsd)}, ${cluster}`
  return `капитализация: ближнее окружение (до ${cap.nearHops} хопов) ${formatUsd(cap.nearUsd)}, ` +
    `всё окружение (${reachedHop} хопов) ${formatUsd(cap.allUsd)}, ${cluster}`
}
