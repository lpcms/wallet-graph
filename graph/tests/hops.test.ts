import { describe, expect, it } from 'vitest'
import { clamp, estimateMinutes } from '../app/lib/hops'

describe('хопы: параметры', () => {
  it('ограничивает ввод диапазоном', () => {
    expect(clamp(0, 1, 15)).toBe(1)
    expect(clamp(99, 1, 15)).toBe(15)
    expect(clamp(7.6, 1, 15)).toBe(8)
    expect(clamp(NaN, 5, 50)).toBe(5)
  })

  it('оценка времени растёт с числом хопов и шириной, шаг — полминуты', () => {
    expect(estimateMinutes(1, 10)).toBe(2.5)    // без раскрытия — только история и анализ
    expect(estimateMinutes(15, 10)).toBe(3.5)   // +168 запросов ≈ +1 мин
    expect(estimateMinutes(15, 50)).toBe(7.5)
    expect(estimateMinutes(15, 50)).toBeGreaterThan(estimateMinutes(2, 50))
  })
})

describe('цвет хопа', () => {
  it('у каждого хопа свой цвет, кошелёк — белый, без хопа — серый', async () => {
    const { hopColor } = await import('../app/lib/hops')
    expect(hopColor(0)).toBe('#ffffff')
    expect(hopColor(undefined)).toBe('#64748b')
    const colors = Array.from({ length: 15 }, (_, i) => hopColor(i + 1))
    expect(new Set(colors).size).toBe(15)
    // hex, а не hsl: WebGL-рендер sigma понимает только hex/rgb
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    expect(hopColor(1)).toBe('#42d3f0')    // hsl(190, 85%, 60%) = rgb(66, 211, 240) — голубой
    expect(hopColor(15)).toBe('#f04299')   // hsl(330, 85%, 60%) = rgb(240, 66, 153) — малиновый
  })
})
