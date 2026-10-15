// ===== UNION-FIND =====

export class UnionFind {
  private parent = new Map<string, string>()
  private rank   = new Map<string, number>()

  add(addr: string): void {
    const a = addr.toLowerCase()
    if (!this.parent.has(a)) {
      this.parent.set(a, a)
      this.rank.set(a, 0)
    }
  }

  find(addr: string): string {
    const a = addr.toLowerCase()
    if (!this.parent.has(a)) this.add(a)
    const p = this.parent.get(a)!
    if (p !== a) this.parent.set(a, this.find(p))
    return this.parent.get(a)!
  }

  union(addrA: string, addrB: string): void {
    const rootA = this.find(addrA)
    const rootB = this.find(addrB)
    if (rootA === rootB) return
    const rankA = this.rank.get(rootA) ?? 0
    const rankB = this.rank.get(rootB) ?? 0
    if (rankA < rankB) {
      this.parent.set(rootA, rootB)
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA)
    } else {
      this.parent.set(rootB, rootA)
      this.rank.set(rootA, rankA + 1)
    }
  }

  getClusters(): Map<string, string[]> {
    const clusters = new Map<string, string[]>()
    for (const addr of this.parent.keys()) {
      const root = this.find(addr)
      if (!clusters.has(root)) clusters.set(root, [])
      clusters.get(root)!.push(addr)
    }
    return clusters
  }
}
