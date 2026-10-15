import { describe, expect, it, vi } from 'vitest'
import { ModelService } from '../src/services/model.service'

describe('ModelService.predict', () => {
  it('одновременные запросы одного символа ждут одно обучение', async () => {
    const service = new ModelService()
    let release!: () => void
    const train = vi.fn(() => new Promise(resolve => { release = () => resolve({ symbol: 'ETH' }) }))
    service['trainAndPredict'] = train as unknown as ModelService['trainAndPredict']

    const first  = service.predict('eth')
    const second = service.predict('ETH')
    release()

    expect(await first).toEqual({ symbol: 'ETH' })
    expect(await second).toEqual({ symbol: 'ETH' })
    expect(train).toHaveBeenCalledTimes(1)
  })
})
