import { Module } from '@nestjs/common'
import { ClusterService } from './services/cluster.service'
import { AnalyticsService } from './services/analytics.service'
import { EtherscanService } from './services/etherscan.service'
import { GraphBuilderService } from './services/graph-builder.service'
import { ModelService } from './services/model.service'
import { GraphController } from './controllers/graph.controller'

// ===== MODULE =====

@Module({
  controllers: [GraphController],
  providers:   [EtherscanService, GraphBuilderService, ClusterService, AnalyticsService, ModelService],
})
export class AppModule {}
