import { describe, expect, it } from 'vitest'
import { findIslands, hubLayout, ISLAND_SCALE, type Point } from '../app/lib/graph-layout'

const link = (a: string, b: string) => ({ sourceId: a, targetId: b })
const dist = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y)
const ids  = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

// центр C; 30 листьев вокруг; 3 хаба, у каждого по 40 своих адресов
function walletLike() {
  const leaves = ids('leaf', 30)
  const hubs   = ids('hub', 3)
  const fans   = hubs.map(h => ids(`${h}-`, 40))
  const nodes  = ['C', ...leaves, ...hubs, ...fans.flat()]
  const links  = [
    ...leaves.map(l => link('C', l)),
    ...hubs.map(h => link('C', h)),
    ...fans.flatMap((fan, i) => fan.map(f => link(hubs[i], f))),
  ]
  return { nodes, links, leaves, hubs, fans }
}

describe('hubLayout', () => {
  it('центральный адрес — в середине, даже если он не самый связанный', () => {
    const { nodes, links } = walletLike()
    const pos = hubLayout(nodes, links, 'C')
    expect(pos.get('C')).toEqual({ x: 0, y: 0 })
    // без указания центра в середину встаёт самый связанный — хаб с 40 адресами
    expect(hubLayout(nodes, links).get('hub0')).toEqual({ x: 0, y: 0 })
  })

  it('расставлены все адреса, и никакие два не совпадают', () => {
    const { nodes, links } = walletLike()
    const pos = hubLayout(nodes, links, 'C')
    expect(pos.size).toBe(nodes.length)
    const points = [...pos.values()]
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++)
        expect(dist(points[i], points[j])).toBeGreaterThan(0.3)
  })

  it('хабы вынесены за кольцо листьев, их адреса — вокруг своего хаба', () => {
    const { nodes, links, leaves, hubs, fans } = walletLike()
    const pos = hubLayout(nodes, links, 'C')
    const c = pos.get('C')!
    const leafMax = Math.max(...leaves.map(l => dist(pos.get(l)!, c)))
    hubs.forEach((h, i) => {
      const hp = pos.get(h)!
      expect(dist(hp, c)).toBeGreaterThan(leafMax)
      for (const f of fans[i]) {
        // адрес ближе к своему хабу, чем к центру и к чужим хабам
        const own = dist(pos.get(f)!, hp)
        expect(own).toBeLessThan(dist(pos.get(f)!, c))
        hubs.filter(o => o !== h).forEach(o => expect(own).toBeLessThan(dist(pos.get(f)!, pos.get(o)!)))
      }
    })
  })

  it('адрес со связями с двумя хабами попадает в одну группу — к более крупному', () => {
    const nodes = ['C', 'big', 'small', 'shared', ...ids('b', 5), 'x']
    const links = [link('C', 'big'), link('C', 'small'), ...ids('b', 5).map(b => link('big', b)),
      link('small', 'x'), link('big', 'shared'), link('small', 'shared')]
    const pos = hubLayout(nodes, links, 'C')
    const s = pos.get('shared')!
    expect(dist(s, pos.get('big')!)).toBeLessThan(dist(s, pos.get('small')!))
  })

  it('несвязанные части стоят отдельно и не наползают на главную', () => {
    const { nodes, links } = walletLike()
    const island = ['I', ...ids('i', 10)]
    const pos = hubLayout([...nodes, ...island], [...links, ...ids('i', 10).map(i => link('I', i))], 'C')
    const mainMax = Math.max(...nodes.map(n => dist(pos.get(n)!, { x: 0, y: 0 })))
    for (const n of island) expect(dist(pos.get(n)!, { x: 0, y: 0 })).toBeGreaterThan(mainMax)
  })

  it('длинная цепочка связей не раздувает граф: размер растёт с числом адресов, а не с глубиной', () => {
    // хаб, от которого тянется цепочка из 40 адресов (так бывает в графах токенов)
    const chain = ids('ch', 40)
    const nodes = ['C', 'hub', ...chain]
    const links = [link('C', 'hub'), link('hub', chain[0]), ...chain.slice(1).map((c, i) => link(chain[i], c))]
    const pos = hubLayout(nodes, links, 'C')
    const radius = Math.max(...[...pos.values()].map(p => dist(p, { x: 0, y: 0 })))
    expect(radius).toBeLessThan(20)
  })

  it('findIslands: адреса, не связанные с главной группой', () => {
    const { nodes, links } = walletLike()
    const allNodes = [...nodes, 'a', 'b', 'p', 'q', 'r']
    const allLinks = [...links, link('a', 'b'), link('p', 'q'), link('q', 'r')]
    const islands = findIslands(allNodes, allLinks, 'C')
    expect([...islands.ids].sort()).toEqual(['a', 'b', 'p', 'q', 'r'])
    expect(islands.groups).toBe(2)
    expect(findIslands(nodes, links, 'C')).toEqual({ ids: new Set(), groups: 0 })
  })

  it('острова расставлены шире главной группы — линия между адресами видна', () => {
    const { nodes, links } = walletLike()
    const pos = hubLayout([...nodes, 'a', 'b'], [...links, link('a', 'b')], 'C')
    // в главной группе соседние адреса стоят на шаг 1, на острове — в ISLAND_SCALE раз дальше
    expect(dist(pos.get('a')!, pos.get('b')!)).toBeCloseTo(ISLAND_SCALE, 5)
  })

  it('раскладка детерминирована', () => {
    const { nodes, links } = walletLike()
    expect([...hubLayout(nodes, links, 'C')]).toEqual([...hubLayout(nodes, links, 'C')])
  })
})
