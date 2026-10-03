import { MODULE_BY_KEY } from '@/data/modules'
import { isInvalidTownship } from '@/data/townships'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 隐患点编号、所在乡镇两个字段名在隐患点模块各处复用，集中写一份。
const HAZARD_KEY = 'hazard'
const HAZARD_CODE_FIELD = '隐患编号'
const HAZARD_TOWN_FIELD = '所在乡镇'
// 排水系统里承接「重点户」待办的模块与标记字段。
const DRAINAGE_KEY = 'drainage'
const DRAINAGE_CODE_FIELD = '排水编号'

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

// 列表、详情抽屉、概览统计都通过这里读同一份落库记录，不另存副本。
export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === Number(id))
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 待处理标记由模块语义决定：隐患点进入「重点防范」即不算待处理，其余模块沿用末态判定。
function resolvePending(meta: ModuleMeta, target: string): boolean {
  if (meta.key === HAZARD_KEY) {
    return target !== '重点防范' && target !== '已消除'
  }
  return target !== meta.statuses[meta.statuses.length - 1]
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
  // 始终在落库的那一条上改，清单和概览读到的都是这次切换后的状态。
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (meta.linearFlow) {
    const currentIndex = meta.statuses.indexOf(current)
    const targetIndex = meta.statuses.indexOf(target)
    // 固定次序推进：只允许往后走一步，未登记状态、插队、跳步一律不认。
    if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
      return {
        ok: false,
        message: `当前状态「${current}」不能直接办理「${action}」，状态须按 ${meta.statuses.join('→')} 的次序推进`,
      }
    }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: resolvePending(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 隐患点列入重点防范后，把结果回写到排水系统的待办；同一隐患编号只落一项重点户。
  if (key === HAZARD_KEY && target === '重点防范') {
    syncKeyHouseholdTodo(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 排水系统重点户待办：按隐患编号幂等回写，反复提交不叠加，也不会凭空多出一项。
function syncKeyHouseholdTodo(hazard: EntryRow): void {
  const code = String(hazard[HAZARD_CODE_FIELD] ?? '')
  const rows = listRows(DRAINAGE_KEY)
  const exists = rows.some((row) => String(row[HAZARD_CODE_FIELD] ?? '') === `重点户-${code}`)
  if (exists) {
    return
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const todo: EntryRow = {
    id: nextId,
    status: '待开挖',
    pending: true,
    abnormal: false,
    [DRAINAGE_CODE_FIELD]: `重点户-${code}`,
    所属工程: '重点户排水待办',
    排水形式: '重点户排水通道',
    总长度: 0,
    断面尺寸: '',
    出水口位置: '',
    验收日期: '',
    排水状态: '待开挖',
    [HAZARD_CODE_FIELD]: code,
    待办来源: '重点防范',
  }
  saveRows(DRAINAGE_KEY, [...rows, todo])
}

export type HazardDraft = {
  隐患编号: string
  所在乡镇: string
  灾害类型: string
  坡体规模: string
  威胁户数: number | string
  威胁人数: number | string
  发现日期: string
}

// 登记隐患点：同一隐患编号反复提交结果不叠加；重复提交沿用历史记录里的所在乡镇，不重算。
export function submitHazard(draft: HazardDraft): ActionResult {
  const code = String(draft[HAZARD_CODE_FIELD] ?? '').trim()
  if (!code) {
    return { ok: false, message: '隐患编号不能为空，请补全后重新提交' }
  }
  const township = String(draft[HAZARD_TOWN_FIELD] ?? '').trim()
  // 所属乡镇为空时按无效值处理，整单退回重填。
  if (isInvalidTownship(township)) {
    return { ok: false, message: '所属乡镇为空属于无效值，请选择所在乡镇后重新提交' }
  }
  const rows = listRows(HAZARD_KEY)
  const existing = rows.find((row) => String(row[HAZARD_CODE_FIELD] ?? '') === code)
  if (existing) {
    // 幂等：命中已有编号直接返回那条，不新增、不覆盖、不改状态。
    return { ok: true, id: Number(existing.id), message: `隐患编号 ${code} 已登记，结果不重复叠加` }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id: nextId,
    status: '待核查',
    pending: true,
    abnormal: false,
    [HAZARD_CODE_FIELD]: code,
    [HAZARD_TOWN_FIELD]: township,
    灾害类型: String(draft.灾害类型 ?? '').trim(),
    坡体规模: String(draft.坡体规模 ?? '').trim(),
    威胁户数: draft.威胁户数 === '' ? '' : Number(draft.威胁户数) || 0,
    威胁人数: draft.威胁人数 === '' ? '' : Number(draft.威胁人数) || 0,
    发现日期: String(draft.发现日期 ?? '').trim(),
    隐患状态: '待核查',
  }
  saveRows(HAZARD_KEY, [...rows, row])
  return { ok: true, id: nextId, message: `隐患点 ${code} 已登记，当前状态「待核查」` }
}

// 隐患点总览指标：全部从落库的同一份记录现算，概览页、清单、详情不再各算各的。
export function hazardStats(): { label: string; value: number }[] {
  const rows = listRows(HAZARD_KEY)
  const countByStatus = (status: string) =>
    rows.filter((row) => String(row.status) === status).length
  const totalPeople = rows.reduce((sum, row) => sum + (Number(row.威胁人数) || 0), 0)
  return [
    { label: '重点防范隐患点', value: countByStatus('重点防范') },
    { label: '待核查隐患点', value: countByStatus('待核查') },
    { label: '威胁人数合计', value: totalPeople },
  ]
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
