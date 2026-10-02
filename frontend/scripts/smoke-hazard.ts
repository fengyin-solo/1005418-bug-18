// 冒烟测试：模拟浏览器 localStorage，验证隐患点状态流转、回写与幂等。
import assert from 'node:assert'

const store = new Map<string, string>()
// @ts-expect-error 测试环境注入 window/localStorage
globalThis.window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
}

const service = await import('@/api/local-service')
const { listEntries, getEntry, runAction, createEntry, updateEntry, loadOverview, townshipOf } = service

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL - ${name}: ${(error as Error).message}`)
  }
}

// 初始：3 条隐患点（待核查/建档中/重点防范），排水系统 3 条
check('初始隐患点 3 条，统计口径一致', () => {
  const all = listEntries('hazard')
  assert.equal(all.total, 3)
  assert.equal(all.items.filter((r) => r.status === '待核查').length, 1)
})

check('待核查直接列入重点防范：插队不认', () => {
  const r = runAction('hazard', 1, '列入重点防范')
  assert.equal(r.ok, false)
  assert.match(r.message, /依次推进/)
  assert.equal(getEntry('hazard', 1)?.status, '待核查')
})

check('待核查直接登记消除：插队不认', () => {
  const r = runAction('hazard', 1, '登记消除')
  assert.equal(r.ok, false)
  assert.equal(getEntry('hazard', 1)?.status, '待核查')
})

check('建档中 → 列入重点防范：落库那条一次切到位，统计跟着动', () => {
  const before = loadOverview()
  const hazardBefore = before.modules.find((m) => m.name === '隐患点建档')!
  const r = runAction('hazard', 2, '列入重点防范')
  assert.equal(r.ok, true)
  const saved = getEntry('hazard', 2)!
  assert.equal(saved.status, '重点防范')
  assert.equal(saved['隐患状态'], '重点防范') // 记录里的状态字段一起切
  assert.equal(listEntries('hazard').items.find((x) => x.id === 2)?.status, '重点防范')
  const after = loadOverview()
  const hazardAfter = after.modules.find((m) => m.name === '隐患点建档')!
  assert.equal(hazardAfter.created, hazardBefore.created) // 不新增记录，只切状态
})

check('重点防范回写排水系统待办：只多一条，乡镇沿用历史记录', () => {
  const drainage = listEntries('drainage').items
  const todos = drainage.filter((r) => String(r['所属工程']) === 'HAZA-0002')
  assert.equal(todos.length, 1)
  assert.equal(todos[0].status, '待开挖')
  assert.equal(todos[0].pending, true)
  assert.equal(todos[0]['出水口位置'], '白石乡') // 沿用隐患点记录里的所在乡镇
})

check('重复列入重点防范：不重复操作，排水待办不叠加', () => {
  const r = runAction('hazard', 2, '列入重点防范')
  assert.equal(r.ok, false)
  const todos = listEntries('drainage').items.filter((x) => String(x['所属工程']) === 'HAZA-0002')
  assert.equal(todos.length, 1) // 没有凭空多出重点户
})

check('重点防范 → 登记消除：到位；再登记消除不认', () => {
  assert.equal(runAction('hazard', 2, '登记消除').ok, true)
  assert.equal(getEntry('hazard', 2)?.status, '已消除')
  assert.equal(getEntry('hazard', 2)?.pending, false)
  assert.equal(runAction('hazard', 2, '登记消除').ok, false)
})

check('同一隐患编号反复提交：结果不叠加', () => {
  const first = createEntry('hazard', { 隐患编号: 'HAZA-0001', 所在乡镇: '青云镇' })
  assert.equal(first.ok, false) // 与种子数据同编号
  assert.match(first.message, /不叠加/)
  const made = createEntry('hazard', { 隐患编号: 'HAZA-1001', 所在乡镇: '杜桥镇', 威胁人数: '9' })
  assert.equal(made.ok, true)
  const again = createEntry('hazard', { 隐患编号: 'HAZA-1001', 所在乡镇: '杜桥镇' })
  assert.equal(again.ok, false)
  assert.equal(listEntries('hazard').items.filter((r) => r['隐患编号'] === 'HAZA-1001').length, 1)
})

check('所属乡镇为空：按无效值退回重填', () => {
  const r = createEntry('hazard', { 隐患编号: 'HAZA-1002', 所在乡镇: '  ' })
  assert.equal(r.ok, false)
  assert.match(r.message, /退回重填/)
  assert.equal(listEntries('hazard').items.filter((x) => x['隐患编号'] === 'HAZA-1002').length, 0)
})

check('补录所在乡镇：空值退回，填了才落库', () => {
  const blank = updateEntry('hazard', 1, { 所在乡镇: '   ' })
  assert.equal(blank.ok, false)
  const filled = updateEntry('hazard', 1, { 所在乡镇: '青云镇' })
  assert.equal(filled.ok, true)
  assert.equal(townshipOf(getEntry('hazard', 1)), '青云镇')
})

check('列表页与详情页是同一条记录', () => {
  const fromList = listEntries('hazard').items.find((r) => r.id === 3)!
  const fromDetail = getEntry('hazard', 3)!
  assert.deepEqual(fromDetail, fromList)
})

check('新登记的隐患点走完整流程可回写排水待办', () => {
  const row = listEntries('hazard').items.find((r) => r['隐患编号'] === 'HAZA-1001')!
  assert.equal(row.status, '待核查')
  assert.equal(runAction('hazard', Number(row.id), '提交核查').ok, true)
  assert.equal(runAction('hazard', Number(row.id), '列入重点防范').ok, true)
  const todos = listEntries('drainage').items.filter((x) => String(x['所属工程']) === 'HAZA-1001')
  assert.equal(todos.length, 1)
  assert.equal(todos[0]['出水口位置'], '杜桥镇')
})

if (failures > 0) {
  console.error(`${failures} 项未通过`)
  process.exit(1)
}
console.log('全部通过')
