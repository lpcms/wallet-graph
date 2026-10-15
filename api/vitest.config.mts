import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Тесты не ходят в сеть: fetch подменяется, ключ фиктивный, очередь Etherscan без пауз
    env: {
      ETHERSCAN_API_KEY:     'test-key',
      ETHERSCAN_INTERVAL_MS: '1',
      PAGE_SIZE:             '1000',
      MAX_PAGES:             '250',
    },
  },
})
