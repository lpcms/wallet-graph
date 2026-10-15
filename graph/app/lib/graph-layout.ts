// Раскладка «по группам»: центральный адрес в середине, вокруг него кольцами — прямые
// контрагенты без своих связей, а контрагенты со своими связями (хабы) вынесены в стороны,
// каждый со своим веером: в нём все адреса, которые связаны с центром через этот хаб.
//
// Каждый адрес привязывается к одному «родителю» — самому связанному соседу на шаг ближе
// к центру (дерево обхода в ширину), поэтому попадает ровно в одну группу.
// Внутри веера адреса идут кольцами: ближе к хабу — его прямые связи, дальше — следующие.
// Угол каждому хабу выделяется по размеру его группы, чтобы веера не наползали друг на друга.
// Несвязанные части графа раскладываются так же и заполняют кольца вокруг главной.

export interface Point { x: number; y: number }

interface LayoutLink { sourceId: string; targetId: string }

const SPACING  = 1                       // шаг между соседними адресами
const HUB_GAP  = 2 * SPACING             // зазор между кольцами листьев центра и веерами хабов
const FULL     = 2 * Math.PI
const FAN_SPAN = (4 * Math.PI) / 3       // веер хаба — 240°, раскрыт от центра наружу
// Веер ±120°: дальше всего назад (к центру) выступают его края — на r·cos(60°) = r/2
const FAN_BACK = 0.5

// Сколько колец нужно для n адресов в секторе span и их число на каждом кольце
function rings(n: number, span: number): number[] {
  const out: number[] = []
  for (let left = n, k = 1; left > 0; k++) {
    const fit = Math.min(left, Math.max(1, Math.floor((span * k * SPACING) / SPACING)))
    out.push(fit)
    left -= fit
  }
  return out
}

const angleAt = (dir: number, span: number, i: number, n: number) =>
  span >= FULL ? dir + (FULL * i) / n : dir - span / 2 + (span * (i + 0.5)) / n

// Адреса по кольцам вокруг (x, y) в секторе span с центром в направлении dir
function placeRings(pos: Map<string, Point>, members: string[], x: number, y: number, dir: number, span: number) {
  let next = 0
  rings(members.length, span).forEach((count, k) => {
    const r = (k + 1) * SPACING
    for (let i = 0; i < count; i++, next++) {
      const a = angleAt(dir, span, i, count)
      pos.set(members[next], { x: x + r * Math.cos(a), y: y + r * Math.sin(a) })
    }
  })
}

// Части графа: главная (с центром или самым связанным адресом) первой, затем несвязанные с ней
interface Part { root: string; leaves: string[]; hubs: { hub: string; members: string[] }[] }

function buildParts(nodeIds: string[], links: LayoutLink[], centerId?: string): Part[] {
  const ids = new Set(nodeIds)
  const adj = new Map<string, Set<string>>(nodeIds.map(id => [id, new Set<string>()]))
  for (const { sourceId: a, targetId: b } of links) {
    if (a === b || !ids.has(a) || !ids.has(b)) continue
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  const degree = (id: string) => adj.get(id)!.size
  const index  = new Map(nodeIds.map((id, i) => [id, i]))
  const byDegree = (a: string, b: string) => degree(b) - degree(a) || index.get(a)! - index.get(b)!

  // Корень части — центр или самый связанный адрес; группы — прямые контрагенты корня
  const order = [...nodeIds].sort(byDegree)
  if (centerId && ids.has(centerId)) order.unshift(centerId)

  const visited = new Set<string>()
  const parts: Part[] = []
  for (const root of order) {
    if (visited.has(root)) continue
    visited.add(root)
    // группа каждого адреса — прямой контрагент корня, через которого до него дошёл обход
    const group = new Map<string, string>()
    const members = new Map<string, string[]>()
    const firstRing = [...adj.get(root)!].sort(byDegree)
    firstRing.forEach(k => { visited.add(k); group.set(k, k); members.set(k, []) })
    let layer = firstRing
    while (layer.length) {
      const next: string[] = []
      // слой обходим от самых связанных: адрес достаётся самому крупному соседу
      for (const u of [...layer].sort(byDegree)) {
        for (const w of [...adj.get(u)!].sort(byDegree)) {
          if (visited.has(w)) continue
          visited.add(w)
          group.set(w, group.get(u)!)
          members.get(group.get(u)!)!.push(w)
          next.push(w)
        }
      }
      layer = next
    }
    parts.push({
      root,
      leaves: firstRing.filter(k => !members.get(k)!.length),
      hubs:   firstRing.filter(k => members.get(k)!.length).map(hub => ({ hub, members: members.get(hub)! })),
    })
  }
  return parts
}

// Адреса, не связанные с главной группой ни одной цепочкой переводов («острова»), и число таких групп
export function findIslands(nodeIds: string[], links: LayoutLink[], centerId?: string): { ids: Set<string>; groups: number } {
  const [main, ...rest] = buildParts(nodeIds, links, centerId)
  const mainIds = new Set([main?.root, ...(main?.leaves ?? []), ...(main?.hubs ?? []).flatMap(h => [h.hub, ...h.members])])
  return { ids: new Set(rest.length ? nodeIds.filter(id => !mainIds.has(id)) : []), groups: rest.length }
}

// Во сколько раз шире раскладываются острова — чтобы линии между их адресами были видны
export const ISLAND_SCALE = 3

export function hubLayout(nodeIds: string[], links: LayoutLink[], centerId?: string): Map<string, Point> {
  const parts = buildParts(nodeIds, links, centerId)

  // ── Размер части: кольца листьев + кольца вееров ─────────────────
  // Хабы заполняют кольцо за кольцом: крупные веера ближе к центру, мелкие дальше.
  // Иначе при сотнях хабов (граф токена) они встали бы на одно огромное кольцо с пустотой внутри.
  const measure = (p: Part) => {
    const leafRadius = rings(p.leaves.length, FULL).length * SPACING
    const hubs = p.hubs
      .map(h => ({ ...h, r: rings(h.members.length, FAN_SPAN).length * SPACING }))
      .sort((a, b) => b.r - a.r)
    const hubRings = packRings(hubs, leafRadius + HUB_GAP, h => h.r, FAN_BACK)
    const last = hubRings[hubRings.length - 1]
    return { hubRings, radius: last ? last.radius + last.items[0].r : leafRadius }
  }

  const pos = new Map<string, Point>()
  // Часть раскладывается вокруг (0, 0) и переносится в (x, y) с масштабом scale
  const placePart = (p: Part, x: number, y: number, scale = 1) => {
    const local = new Map<string, Point>()
    local.set(p.root, { x: 0, y: 0 })
    placeRings(local, p.leaves, 0, 0, 0, FULL)
    for (const ring of measure(p).hubRings) {
      spread(ring.items.map(h => 2 * h.r + SPACING), (a, k) => {
        const { hub, members } = ring.items[k]
        const hx = ring.radius * Math.cos(a), hy = ring.radius * Math.sin(a)
        local.set(hub, { x: hx, y: hy })
        placeRings(local, members, hx, hy, a, FAN_SPAN)
      })
    }
    local.forEach((pt, id) => pos.set(id, { x: x + scale * pt.x, y: y + scale * pt.y }))
  }

  // Главная часть — в центре. Острова (в графе токена — десятки, в основном пары адресов)
  // плотно заполняют кольцо за кольцом вокруг неё: крупные ближе, мелкие дальше
  const [main, ...rest] = parts
  placePart(main, 0, 0)

  const others = rest.map(p => ({ p, r: measure(p).radius * ISLAND_SCALE })).sort((a, b) => b.r - a.r)
  // часть — круг целиком, поэтому назад выступает на весь радиус (back = 1)
  for (const ring of packRings(others, measure(main).radius + HUB_GAP, o => o.r, 1)) {
    spread(ring.items.map(o => 2 * o.r + 2 * SPACING), (a, k) => {
      placePart(ring.items[k].p, ring.radius * Math.cos(a), ring.radius * Math.sin(a), ISLAND_SCALE)
    })
  }
  return pos
}

// Раскладывает круги радиуса size(item) по концентрическим кольцам начиная с радиуса inner.
// Элементы отсортированы по убыванию: первый на кольце — самый крупный, по нему считается кольцо.
// back — какая доля радиуса элемента выступает к центру (веер 240° — половина, круг — весь).
function packRings<T>(items: T[], inner: number, size: (t: T) => number, back: number): { radius: number; items: T[] }[] {
  const out: { radius: number; items: T[] }[] = []
  let i = 0
  while (i < items.length) {
    const radius = inner + back * size(items[i]) + SPACING
    const ring: T[] = []
    let used = 0
    while (i + ring.length < items.length) {
      const w = 2 * size(items[i + ring.length]) + SPACING
      if (ring.length && used + w > FULL * radius) break
      ring.push(items[i + ring.length])
      used += w
    }
    out.push({ radius, items: ring })
    inner = radius + size(items[i]) + SPACING
    i += ring.length
  }
  return out
}

// Распределяет элементы с заданной шириной по окружности: угол каждому — по его ширине
function spread(widths: number[], at: (angle: number, index: number) => void) {
  const total = widths.reduce((s, w) => s + w, 0)
  let acc = 0
  widths.forEach((w, k) => {
    at((FULL * (acc + w / 2)) / total, k)
    acc += w
  })
}
