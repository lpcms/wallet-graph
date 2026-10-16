// Номер хопа каждого адреса — кратчайшее число переводов от исследуемого кошелька
// по связям графа (сам кошелёк — 0, его прямые контрагенты — 1, …)
export function hopDistances(links: { sourceAddress: string; targetAddress: string }[], root: string): Map<string, number> {
  const adj = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a)!.push(b)
  }
  for (const l of links) {
    const a = l.sourceAddress.toLowerCase(), b = l.targetAddress.toLowerCase()
    if (a === b) continue
    link(a, b)
    link(b, a)
  }
  const start = root.toLowerCase()
  const dist = new Map([[start, 0]])
  let layer = [start]
  while (layer.length) {
    const next: string[] = []
    for (const v of layer) {
      for (const w of adj.get(v) ?? []) {
        if (dist.has(w)) continue
        dist.set(w, dist.get(v)! + 1)
        next.push(w)
      }
    }
    layer = next
  }
  return dist
}
