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
