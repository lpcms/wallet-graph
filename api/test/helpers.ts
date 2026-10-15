import { vi } from 'vitest'
import type { EtherscanTransaction } from '../src/types'

let hashCounter = 0

export function tx(from: string, to: string, eth: number, block = 1, timeStamp = 1_700_000_000): EtherscanTransaction {
  return {
    hash:        `0x${(++hashCounter).toString(16).padStart(64, '0')}`,
    from,
    to,
    value:       BigInt(Math.round(eth * 1e6)) * 10n ** 12n + '',
    timeStamp:   String(timeStamp),
    blockNumber: String(block),
  }
}

export const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

// Подменяет fetch: handler получает query-параметры запроса к Etherscan и возвращает тело ответа
export function mockEtherscan(handler: (q: URLSearchParams) => unknown) {
  const calls: URLSearchParams[] = []
  const fetchMock = vi.fn(async (url: string | URL) => {
    const q = new URL(String(url)).searchParams
    calls.push(q)
    return { json: async () => handler(q) } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

export const ok = (result: unknown) => ({ status: '1', message: 'OK', result })
export const noData = () => ({ status: '0', message: 'No data found', result: null })
