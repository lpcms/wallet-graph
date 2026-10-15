// Категории владельцев адресов (поле entityType узла) — цвета и подписи легенды «Владелец»
export type EntityType = 'WALLET' | 'CEX' | 'DEX' | 'FUND' | 'DEFI' | 'ISSUER' | 'PERSON' | 'UNATTRIBUTED'

export interface EntityStyle {
  label:  string
  color:  string   // заливка узла
  border: string   // обводка, если узел не в кластере
}

// Порядок — порядок строк в легенде
export const ENTITY_STYLES: Record<EntityType, EntityStyle> = {
  WALLET:       { label: 'Кошельки',             color: '#3b82f6', border: '#93c5fd' },
  CEX:          { label: 'Биржа (CEX)',          color: '#facc15', border: '#fde68a' },
  DEX:          { label: 'Биржа (DEX)',          color: '#f97316', border: '#fdba74' },
  FUND:         { label: 'Фонд / маркет-мейкер', color: '#d946ef', border: '#f0abfc' },
  DEFI:         { label: 'DeFi-протокол',        color: '#22d3ee', border: '#a5f3fc' },
  ISSUER:       { label: 'Эмитент',              color: '#22c55e', border: '#86efac' },
  PERSON:       { label: 'Известная персона',    color: '#f472b6', border: '#fbcfe8' },
  UNATTRIBUTED: { label: 'Не атрибутировано',    color: '#a5b4c8', border: '#e2e8f0' },
}

export const ENTITY_ORDER = Object.keys(ENTITY_STYLES) as EntityType[]

// Неизвестный тип (например, ответ старой версии API) показываем как неатрибутированный
export function entityStyle(type: string | undefined): EntityStyle {
  return ENTITY_STYLES[type as EntityType] ?? ENTITY_STYLES.UNATTRIBUTED
}
