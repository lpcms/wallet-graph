// Параметры раскрытия хопов в графе кошелька и оценка времени построения
export const HOPS_MIN = 1
export const HOPS_MAX = 15
export const WIDTH_MIN = 5
export const WIDTH_MAX = 50

// Etherscan на бесплатном ключе — 3 запроса/с. Сама история кошелька, балансы и проверки
// занимают ~2,5 мин; каждый раскрытый адрес — запрос его транзакций плюс ~20% на проверку контрактов
const BASE_SEC        = 150
const SEC_PER_REQUEST = 0.35

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value) || min))
}

// Сколько минут займёт граф в худшем случае (если на каждом хопе найдутся все width адресов)
export function estimateMinutes(hops: number, width: number): number {
  const requests = Math.max(0, hops - 1) * width * 1.2
  return Math.ceil(((BASE_SEC + requests * SEC_PER_REQUEST) / 60) * 2) / 2
}

// Цвет узла по номеру хопа: сам кошелёк — белый, дальше от голубого (1-й хоп) к малиновому (15-й)
export function hopColor(hop: number | undefined): string {
  if (hop === undefined) return '#64748b'
  if (hop === 0) return '#ffffff'
  const t = Math.min(hop - 1, HOPS_MAX - 1) / (HOPS_MAX - 1)
  return hslToHex(190 + t * 140, 0.85, 0.6)
}

// sigma рисует через WebGL и понимает hex/rgb, но не hsl — переводим в #rrggbb
function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}
