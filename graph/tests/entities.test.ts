import { describe, expect, it } from 'vitest'
import { ENTITY_ORDER, ENTITY_STYLES, entityStyle } from '../app/lib/entities'

describe('категории владельцев', () => {
  it('легенда: 8 категорий в порядке со скриншота, DEX сразу после CEX', () => {
    expect(ENTITY_ORDER).toEqual(['WALLET', 'CEX', 'DEX', 'FUND', 'DEFI', 'ISSUER', 'PERSON', 'UNATTRIBUTED'])
  })

  it('у каждой категории свой цвет', () => {
    const colors = Object.values(ENTITY_STYLES).map(s => s.color)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('неизвестный или пустой тип показывается как неатрибутированный', () => {
    expect(entityStyle('SOMETHING_NEW')).toBe(ENTITY_STYLES.UNATTRIBUTED)
    expect(entityStyle(undefined)).toBe(ENTITY_STYLES.UNATTRIBUTED)
    expect(entityStyle('CEX').label).toBe('Биржа (CEX)')
  })
})
