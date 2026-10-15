import { KNOWN_ADDRESSES, type EntityType } from '../constants/known-addresses'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface EntityInfo {
  type: EntityType
  name?: string
  verified?: boolean   // для кошелька: проверено, что это не контракт
}

// Что известно об адресах сверх списка KNOWN_ADDRESSES (собирается запросами к Etherscan)
export interface EntityHints {
  contracts?: Set<string>          // смарт-контракты
  services?:  Set<string>          // кошельки с 10 000+ tx
  issuers?:   Map<string, string>  // эмитент токена → роль («контракт токена», «создатель токена»…)
  verified?:  Set<string>          // подтверждённые кошельки (EOA)
}

// Категория владельца адреса. Приоритет: известный список → эмитент → контракт →
// сервисный кошелёк → обычный кошелёк. Непроверенные адреса считаются кошельками
// (verified: false): проверяются самые активные и крупные, контракты и сервисы обычно среди них.
export function classifyAddress(address: string, hints: EntityHints = {}): EntityInfo {
  const addr = address.toLowerCase()
  const known = KNOWN_ADDRESSES.get(addr)
  if (known)                        return { type: known.type, name: known.name }
  const issuerRole = hints.issuers?.get(addr)
  if (issuerRole)                   return { type: 'ISSUER', name: issuerRole }
  if (addr === ZERO_ADDRESS)        return { type: 'ISSUER', name: 'минт / сжигание (нулевой адрес)' }
  if (hints.contracts?.has(addr))   return { type: 'UNATTRIBUTED', name: 'смарт-контракт' }
  if (hints.services?.has(addr))    return { type: 'UNATTRIBUTED', name: 'сервисный кошелёк (10 000+ tx)' }
  return { type: 'WALLET', verified: hints.verified?.has(addr) ?? false }
}
