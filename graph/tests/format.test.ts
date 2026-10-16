import { describe, expect, it } from 'vitest'
import { capitalizationText, formatPrice, formatUsd } from '../app/lib/format'

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

describe('formatPrice', () => {
  it.each([
    [2400,       '$2 400'],
    [1.0549,     '$1,05'],
    [0.004321,   '$0,004321'],
    [0.00001234, '$0,00001234'],
  ])('%d → %s', (usd, expected) => {
    expect(nbsp(formatPrice(usd))).toBe(expected)
  })
})

describe('capitalizationText', () => {
  const cap = { nearHops: 2, nearUsd: 5_900_000, nearAddresses: 1960, allUsd: 180_000_000, allAddresses: 1990, clusterUsd: 491_000, clusterAddresses: 1 }

  it('много хопов — ближнее и всё окружение отдельно', () => {
    expect(nbsp(capitalizationText(cap, 15))).toBe(
      'капитализация: ближнее окружение (до 2 хопов) $5,9 млн, всё окружение (15 хопов) $180 млн, кластер (1 адр.) $491 тыс.')
  })

  it('до 2 хопов — одна сумма', () => {
    expect(nbsp(capitalizationText({ ...cap, allUsd: cap.nearUsd }, 2))).toBe('капитализация $5,9 млн, кластер (1 адр.) $491 тыс.')
  })
})
