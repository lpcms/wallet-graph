import { Injectable } from '@nestjs/common'

// Стейблкоины — $1 без запроса (у USDT нет пары X/USDT на Binance)
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDS', 'PYUSD', 'USDE', 'BUSD', 'USDP', 'GUSD', 'LUSD'])

// Обёрнутые активы торгуются по цене исходного
const WRAPPED: Record<string, string> = { WETH: 'ETH', STETH: 'ETH', WSTETH: 'ETH', WBTC: 'BTC', CBBTC: 'BTC' }

const CACHE_TTL = 5 * 60 * 1000

// Цена токена в долларах по последней сделке пары SYMBOL/USDT на Binance
@Injectable()
export class PriceService {
  private cache = new Map<string, { price: number | null; at: number }>()
  private exchange: { fetchTicker(pair: string): Promise<{ last?: number }> } | null = null

  async getTokenPriceUsd(symbol: string | undefined): Promise<number | null> {
    const sym = (symbol ?? '').trim().toUpperCase()
    if (!sym) return null
    if (STABLECOINS.has(sym)) return 1

    const base = WRAPPED[sym] ?? sym
    const cached = this.cache.get(base)
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached.price

    let price: number | null = null
    try {
      const last = await this.fetchLast(`${base}/USDT`)
      price = last && Number.isFinite(last) && last > 0 ? last : null
    } catch (err) {
      console.log(`  [Price] ${base}/USDT недоступна: ${(err as Error).message.split('\n')[0]}`)
    }
    console.log(`  [Price] ${sym}: ${price === null ? 'цена неизвестна — пороги в штуках токена' : '$' + price}`)
    this.cache.set(base, { price, at: Date.now() })
    return price
  }

  // ccxt тяжёлый — грузим лениво, один экземпляр биржи на всё время работы
  protected async fetchLast(pair: string): Promise<number | undefined> {
    if (!this.exchange) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ccxt = require('ccxt')
      this.exchange = new ccxt.binance({ enableRateLimit: true })
    }
    return (await this.exchange!.fetchTicker(pair)).last
  }
}
