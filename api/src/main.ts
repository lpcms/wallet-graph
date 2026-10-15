import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { CONFIG } from './config'
import { CEX_ADDRESSES } from './constants/cex-addresses'
import { AppModule } from './app.module'

// ===== BOOTSTRAP =====

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableCors()
  await app.listen(CONFIG.port)

  console.log(`\n✅ API запущен: http://localhost:${CONFIG.port}`)
  console.log(`   pageSize     = ${CONFIG.pageSize}`)
  console.log(`   maxPages     = ${CONFIG.maxPages}`)
  console.log(`   maxTx        = ${CONFIG.pageSize * CONFIG.maxPages}`)
  console.log(`   cacheTTL     = ${CONFIG.cacheTtlMs / 60_000} мин`)
  console.log(`   CEX-адресов  = ${CEX_ADDRESSES.size}`)
  console.log(`\n   GET /health`)
  console.log(`   GET /graph/wallet/:address`)
  console.log(`   GET /graph/token/:address`)
  console.log(`   GET /predict/:symbol          (LSTM, кэш 30 мин)`)
  console.log(`   GET /predict/:symbol/retrain  (принудительное переобучение)`)
}

bootstrap()
