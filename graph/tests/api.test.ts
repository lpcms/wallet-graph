import { afterEach, describe, expect, it, vi } from 'vitest'

describe('API_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('по умолчанию указывает на локальный API', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined)
    const { API_URL } = await import('../app/lib/api')
    expect(API_URL).toBe('http://localhost:3001')
  })

  it('берётся из NEXT_PUBLIC_API_URL без завершающего слэша', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/')
    const { API_URL } = await import('../app/lib/api')
    expect(API_URL).toBe('https://api.example.com')
  })
})
