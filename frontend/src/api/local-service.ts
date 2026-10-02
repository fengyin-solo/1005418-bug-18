import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 所在乡镇只有这一个取数口径：列表、详情、登记校验、回写排水系统都从这里读，不各取各的。
const TOWNSHIP_FIELD = '所在乡镇'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 每个模块的最后一个字段是状态字段（隐患状态、排水状态……），流转时跟着 workflow 一起切。
function statusFieldOf(meta: ModuleMeta): string {
  const last = meta.fields[meta.fields.length - 1] ?? ''
  return last.endsWith('状态') ? last : ''
}

export function townshipOf(row: EntryRow | null | undefined): string {
  if (!row) {
    return ''
  }
  return String(row[TOWNSHIP_FIELD] ?? '').trim()
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 列表拿到的是副本：页面只能读，写回必须走本模块的函数，落库的那份不会被绕开。
export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters).map((row) => clone(row))
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 详情按 id 从同一份落库数据里取，保证列表页与详情页看到的是同一条记录。
export function getEntry(key: string, id: number): EntryRow | undefined {
  const found = listRows(key).find((row) => Number(row.id) === id)
  return found ? clone(found) : undefined
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 状态按 meta.statuses 的固定次序一次推进一格，插队的一律不认。
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
    return {
      ok: false,
      message: `${meta.entity}状态须按「${meta.statuses.join('→')}」依次推进，不能由「${current}」直接切到「${target}」`,
    }
  }
  // 列入重点防范会把所在乡镇回写到排水系统待办，乡镇为空按无效值退回重填。
  if (key === 'hazard' && target === '重点防范' && !townshipOf(rows[index])) {
    return { ok: false, message: `${TOWNSHIP_FIELD}为空，按无效值退回重填` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const statusField = statusFieldOf(meta)
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (statusField) {
    updated[statusField] = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 重点防范一落定，就把同一条隐患点记录回写到排水系统待办，一次切换到位。
  if (key === 'hazard' && target === '重点防范') {
    writeBackDrainageTodo(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 回写排水系统待办：以隐患编号为锚，同一编号只落一条，不会凭空多出重点户；
// 所在乡镇沿用隐患点记录里的历史值，不重算。
function writeBackDrainageTodo(hazard: EntryRow): void {
  const code = String(hazard['隐患编号'] ?? '').trim()
  if (!code) {
    return
  }
  const rows = listRows('drainage')
  if (rows.some((row) => String(row['所属工程'] ?? '').trim() === code)) {
    return
  }
  const todo: EntryRow = {
    id: nextId(rows),
    status: '待开挖',
    pending: true,
    abnormal: false,
    排水编号: `DRAI-${code}`,
    所属工程: code,
    排水形式: '截排水沟',
    总长度: '待补录',
    断面尺寸: '待补录',
    出水口位置: townshipOf(hazard),
    验收日期: '',
    排水状态: '待开挖',
  }
  saveRows('drainage', [...rows, todo])
}

// 登记新记录：编号是唯一身份，同一编号反复提交结果不叠加；所在乡镇为空按无效值退回重填。
export function createEntry(key: string, values: Record<string, string>): ActionResult {
  const meta = moduleMeta(key)
  const codeField = meta.fields[0]
  const code = String(values[codeField] ?? '').trim()
  if (!code) {
    return { ok: false, message: `${codeField}不能为空，退回重填` }
  }
  const rows = listRows(key)
  if (rows.some((row) => String(row[codeField] ?? '').trim() === code)) {
    return { ok: false, message: `${codeField} ${code} 已登记，重复提交的结果不叠加` }
  }
  if (meta.fields.includes(TOWNSHIP_FIELD) && !String(values[TOWNSHIP_FIELD] ?? '').trim()) {
    return { ok: false, message: `${TOWNSHIP_FIELD}为空，按无效值退回重填` }
  }
  const firstStatus = meta.statuses[0]
  const statusField = statusFieldOf(meta)
  const record: EntryRow = {
    id: nextId(rows),
    status: firstStatus,
    pending: firstStatus !== meta.statuses[meta.statuses.length - 1],
    abnormal: false,
  }
  for (const field of meta.fields) {
    record[field] = String(values[field] ?? '').trim()
  }
  record[codeField] = code
  if (statusField) {
    record[statusField] = firstStatus
  }
  saveRows(key, [...rows, record])
  return { ok: true, message: `${meta.entity}已登记，当前状态「${firstStatus}」` }
}

// 补录字段（退回重填后走这里）：编号是身份不允许改；所在乡镇为空按无效值退回重填。
export function updateEntry(
  key: string,
  id: number,
  patch: Record<string, string>,
): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const codeField = meta.fields[0]
  const applied: string[] = []
  const updated: EntryRow = { ...rows[index] }
  for (const [field, value] of Object.entries(patch)) {
    if (!meta.fields.includes(field) || field === codeField) {
      continue
    }
    updated[field] = String(value ?? '').trim()
    applied.push(field)
  }
  if (applied.length === 0) {
    return { ok: false, message: '没有可补录的字段' }
  }
  if (meta.fields.includes(TOWNSHIP_FIELD) && !townshipOf(updated)) {
    return { ok: false, message: `${TOWNSHIP_FIELD}为空，按无效值退回重填` }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已补录${applied.join('、')}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
