import { afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { EtherscanService } from '../src/services/etherscan.service'
import type { EtherscanTransaction } from '../src/types'
import { addr, mockEtherscan, noData, ok, tx } from './helpers'

afterEach(() => { vi.unstubAllGlobals() })

describe('EtherscanService.getWalletTransactions', () => {
  it('загружает всю историю дальше лимита 10 000 без дублей', async () => {
    const wallet = addr(1)
    // 25 500 tx по 3 в блоке: окна по 10 000 разрезают блоки на границах
    const history: EtherscanTransaction[] = []
    for (let i = 0; i < 25_500; i++) history.push(tx(wallet, addr(2 + (i % 7)), 1, 1 + Math.floor(i / 3)))
    history.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber))

    mockEtherscan(q => {
      const page = Number(q.get('page')), offset = Number(q.get('offset'))
      if (page * offset > 10_000) return { status: '0', message: 'NOTOK', result: 'Result window is too large' }
      const endBlock = Number(q.get('endblock'))
      const slice = history.filter(t => Number(t.blockNumber) <= endBlock)
        .slice((page - 1) * offset, page * offset)
      return slice.length ? ok(slice) : { status: '0', message: 'No transactions found', result: [] }
    })

    const result = await new EtherscanService().getWalletTransactions(wallet)

    expect(result).toHaveLength(25_500)
    expect(new Set(result.map(t => t.hash)).size).toBe(25_500)
  })
})

describe('EtherscanService.getTokenTransactions', () => {
  it('собирает страницы по порядку до первой неполной', async () => {
    const token = addr(0x70)
    const transfers = Array.from({ length: 2_500 }, (_, i) => tx(addr(1 + (i % 9)), addr(20 + (i % 5)), 1, 5_000 - i))
    const calls = mockEtherscan(q => {
      const page = Number(q.get('page')), offset = Number(q.get('offset'))
      if (page * offset > 10_000) return { status: '0', message: 'NOTOK', result: 'Result window is too large' }
      const slice = transfers.slice((page - 1) * offset, page * offset)
      return slice.length ? ok(slice) : { status: '0', message: 'No transactions found', result: [] }
    })

    const result = await new EtherscanService().getTokenTransactions(token)

    expect(result.map(t => t.hash)).toEqual(transfers.map(t => t.hash))
    expect(calls.length).toBeLessThanOrEqual(10)   // одна параллельная пачка
  })
})

describe('EtherscanService.request (через getBalance)', () => {
  it('повторяет запрос после ответа rate limit', async () => {
    let n = 0
    const calls = mockEtherscan(() => (++n === 1
      ? { status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (3/sec)' }
      : ok('2500000000000000000')))

    expect(await new EtherscanService().getBalance(addr(1))).toBe(2.5)
    expect(calls).toHaveLength(2)
  })
})

describe('EtherscanService.getBalances', () => {
  it('запрашивает балансы пачками по 20 адресов', async () => {
    const addresses = Array.from({ length: 45 }, (_, i) => addr(100 + i))
    const calls = mockEtherscan(q => ok(q.get('address')!.split(',').map(a => ({ account: a, balance: '1000000000000000000' }))))

    const balances = await new EtherscanService().getBalances(addresses)

    expect(calls.map(q => q.get('address')!.split(',').length)).toEqual([20, 20, 5])
    expect(balances.size).toBe(45)
    expect(balances.get(addr(100))).toBe(1)
  })

  it('при отказе balancemulti запрашивает адреса по одному', async () => {
    mockEtherscan(q => q.get('action') === 'balancemulti'
      ? { status: '0', message: 'NOTOK', result: 'Error' }
      : ok('3000000000000000000'))

    const balances = await new EtherscanService().getBalances([addr(1), addr(2)])

    expect([...balances.values()]).toEqual([3, 3])
  })
})

describe('EtherscanService.getContracts', () => {
  it('проверяет по 5 адресов и возвращает только контракты', async () => {
    const contract = addr(7)
    const calls = mockEtherscan(q => {
      const batch = q.get('contractaddresses')!.split(',')
      return batch.includes(contract) ? ok([{ contractAddress: contract }]) : noData()
    })

    const result = await new EtherscanService().getContracts(Array.from({ length: 12 }, (_, i) => addr(i + 1)))

    expect(calls).toHaveLength(3)
    expect([...result]).toEqual([contract])
  })
})

describe('EtherscanService.getHighActivity', () => {
  it('отмечает адреса, у которых есть 10 000-я транзакция', async () => {
    const busy = addr(1)
    mockEtherscan(q => {
      expect(q.get('page')).toBe('10000')
      expect(q.get('offset')).toBe('1')
      return q.get('address') === busy ? ok([tx(busy, addr(2), 1)]) : { status: '0', message: 'No transactions found', result: [] }
    })

    const result = await new EtherscanService().getHighActivity([busy, addr(2)])

    expect([...result]).toEqual([busy])
  })
})
