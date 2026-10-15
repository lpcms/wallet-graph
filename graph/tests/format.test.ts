import { describe, expect, it } from 'vitest'
import { formatUsd } from '../app/lib/format'

// toLocaleString('ru-RU') разделяет тысячи неразрывным пробелом
const nbsp = (s: string) => s.replace(/\s/g, ' ')

describe('formatUsd', () => {
  it.each([
    [0,              '$0'],
    [742.4,          '$742'],
    [15_300,         '$15,3 тыс.'],
    [612_400,        '$612,4 тыс.'],
    [1_250_000,      '$1,25 млн'],
    [5_769_627,      '$5,77 млн'],
    [3_800_000_000,  '$3,8 млрд'],
    [1.1e12,         '$1,1 трлн'],
    [2.5e15,         '$2 500 трлн'],
  ])('%d → %s', (usd, expected) => {
    expect(nbsp(formatUsd(usd))).toBe(expected)
  })

  it('ставит минус перед знаком доллара', () => {
    expect(formatUsd(-2_000_000)).toBe('-$2 млн')
    expect(formatUsd(-500)).toBe('-$500')
  })
})
