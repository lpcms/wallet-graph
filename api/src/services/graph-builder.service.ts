import { Injectable } from '@nestjs/common'
import { CEX_ADDRESSES } from '../constants/cex-addresses'
import type { EtherscanTransaction, GraphNode, GraphLink, ClusterInfo } from '../types'
import { isTokenTransfer, txAmount } from '../lib/amount'

// ===== ГРАФ-БИЛДЕР =====

interface AddressStats {
  sends:    number
  receives: number
  netFlow:  number   // приход − расход в единицах актива (ETH или токен)
}

@Injectable()
export class GraphBuilderService {

  private getNodeType({ sends, receives }: AddressStats): string {
    if (sends === 0 && receives > 0)   return 'DEXBUY'
    if (sends > 0   && receives === 0) return 'DEXSELL'
    if (sends > receives * 2)          return 'CEXSELL'
    if (receives > sends * 2)          return 'CEXBUY'
    return 'ACTIVE'
  }

  // Число исходящих/входящих tx и чистый поток актива (приход − расход) каждого адреса —
  // за один проход по tx. Раньше это считалось перебором всех tx для каждого узла:
  // на 6 тыс. узлов ~30 секунд.
  private getAddressStats(txs: EtherscanTransaction[]): Map<string, AddressStats> {
    const stats = new Map<string, AddressStats>()
    const of = (addr: string) => {
      let s = stats.get(addr)
      if (!s) stats.set(addr, s = { sends: 0, receives: 0, netFlow: 0 })
      return s
    }
    for (const tx of txs) {
      const from = tx.from?.toLowerCase()
      const to   = tx.to?.toLowerCase()
      if (from) of(from).sends++
      if (to)   of(to).receives++
      if (!tx.value || tx.value === '0') continue
      const amount = txAmount(tx)
      if (to) of(to).netFlow += amount
      // перевод самому себе считается только как приход
      if (from && from !== to) of(from).netFlow -= amount
    }
    return stats
  }

  buildGraph(
    transactions: EtherscanTransaction[],
    realBalances: Map<string, number>,
    ethPriceUsd: number,
    clusterMap: Map<string, ClusterInfo>,
  ): { nodes: GraphNode[]; links: GraphLink[] } {

    const addressMap = new Map<string, string>()
    const nodes: GraphNode[] = []
    const links: GraphLink[]  = []
    let counter = 1

    transactions.forEach(tx => {
      if (tx.from && !addressMap.has(tx.from.toLowerCase()))
        addressMap.set(tx.from.toLowerCase(), String(counter++))
      if (tx.to   && !addressMap.has(tx.to.toLowerCase()))
        addressMap.set(tx.to.toLowerCase(),   String(counter++))
    })

    const stats = this.getAddressStats(transactions)
    // Граф токена: суммы в tx — в единицах токена, а не ETH
    const tokenTx     = transactions.find(isTokenTransfer)
    const tokenSymbol = tokenTx?.tokenSymbol || 'TOKEN'

    addressMap.forEach((id, address) => {
      const addrStats  = stats.get(address)!
      const realEth    = realBalances.get(address)
      // Без реального баланса для ETH-графа оцениваем его чистым потоком ETH, как раньше.
      // В графе токена поток — в токенах: выдавать его за баланс ETH нельзя, баланс неизвестен.
      const ethBalance = realEth !== undefined ? realEth
        : !tokenTx ? Math.max(0, addrStats.netFlow)
        : undefined
      const usdAmount    = (ethBalance ?? 0) * ethPriceUsd
      const exchangeName = CEX_ADDRESSES.get(address.toLowerCase())
      const isExchange   = !!exchangeName
      const cluster      = clusterMap.get(address.toLowerCase())

      nodes.push({
        id,
        walletAddress: address,
        nodeType:      isExchange ? 'EXCHANGE' : this.getNodeType(addrStats),
        tokenBalance:  ethBalance ?? 0,
        usdBalance:    (ethBalance ?? 0).toFixed(6),
        usdValue:      `$${usdAmount.toFixed(2)}`,
        balanceKnown:  ethBalance !== undefined,
        ...(tokenTx && { tokenFlow: addrStats.netFlow, tokenSymbol }),
        isExchange,
        exchangeName,
        clusterId:     cluster?.clusterId,
        clusterSize:   cluster?.addresses.length,
        clusterRole:        cluster?.role,
        clusterArchetype:   cluster?.archetype,
        kmeansSignals:      cluster?.signals,
        behavior:           cluster?.behavior[address],
        gr:                 cluster?.gr,
        markov:             cluster?.markov,
      })
    })

    transactions.forEach(tx => {
      if (!tx.from || !tx.to) return
      const sourceId = addressMap.get(tx.from.toLowerCase())
      const targetId = addressMap.get(tx.to.toLowerCase())
      if (!sourceId || !targetId) return

      const amount         = txAmount(tx)
      const srcCluster     = clusterMap.get(tx.from.toLowerCase())?.clusterId
      const tgtCluster     = clusterMap.get(tx.to.toLowerCase())?.clusterId
      const isCrossCluster = !!(srcCluster && tgtCluster && srcCluster !== tgtCluster)

      links.push({
        sourceId,
        targetId,
        sourceAddress:     tx.from,
        targetAddress:     tx.to,
        linkType:          'TRANSFER',
        transactionWeight: amount,
        // В долларах — только переводы ETH: цены токена у нас нет, а курс ETH к ней не относится
        ...(!isTokenTransfer(tx) && { usdWeight: amount * ethPriceUsd }),
        unix:              Number(tx.timeStamp) * 1000,
        txId:              tx.hash,
        isCrossCluster,
      })
    })

    return { nodes, links }
  }
}
