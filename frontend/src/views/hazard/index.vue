<template>
  <section class="page" data-module="hazard">
    <header class="page-head">
      <div>
        <h2>隐患点建档管理</h2>
        <p class="page-desc">维护隐患点，围绕隐患编号、所在乡镇、灾害类型、坡体规模做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记隐患点</button>
        <button class="btn" type="button" @click="exportRows">导出隐患点建档清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canRun(action, row)"
              :title="canRun(action, row) ? '' : '状态须依次推进，不能插队'"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无隐患点建档数据，可先登记隐患点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条隐患点建档记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情抽屉：按 id 从同一份落库数据里读，和列表看到的是同一条记录 -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>隐患点详情 · {{ detail['隐患编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ detail[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detail.status }}</dd>
        </dl>
        <div class="township-edit">
          <label class="filter-item">
            <span>所在乡镇（沿用历史记录，为空按无效值退回重填）</span>
            <input v-model="townshipDraft" placeholder="填写所在乡镇" />
          </label>
          <button class="btn" type="button" @click="saveTownship">保存所在乡镇</button>
        </div>
        <p v-if="detailMessage" class="error-text">{{ detailMessage }}</p>
      </aside>
    </div>

    <!-- 登记弹窗：隐患编号是唯一身份，重复提交不叠加；所在乡镇为空退回重填 -->
    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <header class="drawer-head">
          <h3>登记隐患点</h3>
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
        </header>
        <form class="modal-form" @submit.prevent="submitCreate">
          <label v-for="field in createFields" :key="field" class="filter-item">
            <span>{{ field }}</span>
            <input v-model="createForm[field]" :placeholder="`填写${field}`" />
          </label>
          <p class="form-hint">隐患编号是唯一身份，同一编号反复提交结果不叠加；所在乡镇为空按无效值退回重填。</p>
          <p v-if="createError" class="error-text">{{ createError }}</p>
          <div class="modal-actions">
            <button class="btn primary" type="submit">提交登记</button>
            <button class="btn" type="button" @click="closeCreate">取消</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  townshipOf,
  updateEntry,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('hazard')
const columns = ["隐患编号", "所在乡镇", "灾害类型", "坡体规模", "威胁户数", "威胁人数", "发现日期", "隐患状态"]
const actions = ["提交核查", "列入重点防范", "登记消除"]
const statuses = ["待核查", "建档中", "重点防范", "已消除"]
const createFields = columns.filter((column) => column !== '隐患状态')

const rows = ref<EntryRow[]>([])
const dataset = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 统计与图例都按落库的全量数据算，跟清单筛选条件无关，各入口看到的是同一份。
function countByStatus(status: string): number {
  return dataset.value.filter((row) => String(row.status) === status).length
}

const stats = computed(() => [
  { label: '重点防范隐患点', value: countByStatus('重点防范') },
  { label: '待核查隐患点', value: countByStatus('待核查') },
  {
    label: '威胁人数合计',
    value: dataset.value.reduce((sum, row) => sum + (Number(row['威胁人数']) || 0), 0),
  },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({ status, count: countByStatus(status) })),
)

// 动作是否轮到它：状态按 待核查→建档中→重点防范→已消除 一次推进一格，插队的直接禁用。
function canRun(action: string, row: EntryRow): boolean {
  const target = meta.actionTargets[action]
  if (!target) {
    return false
  }
  return statuses.indexOf(target) === statuses.indexOf(String(row.status)) + 1
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

const detail = ref<EntryRow | null>(null)
const detailId = ref<number | null>(null)
const detailMessage = ref('')
const townshipDraft = ref('')

function openDetail(row: EntryRow) {
  detailId.value = Number(row.id)
  refreshDetail()
}

function refreshDetail() {
  if (detailId.value === null) {
    return
  }
  const record = getEntry(meta.key, detailId.value)
  if (!record) {
    closeDetail()
    return
  }
  detail.value = record
  townshipDraft.value = townshipOf(record)
  detailMessage.value = ''
}

function closeDetail() {
  detail.value = null
  detailId.value = null
  detailMessage.value = ''
}

function saveTownship() {
  if (detailId.value === null) {
    return
  }
  const result = updateEntry(meta.key, detailId.value, { 所在乡镇: townshipDraft.value })
  if (!result.ok) {
    detailMessage.value = result.message
    return
  }
  reload()
}

const createOpen = ref(false)
const createForm = ref<Record<string, string>>({})
const createError = ref('')

function openCreate() {
  createForm.value = {}
  createError.value = ''
  createOpen.value = true
}

function closeCreate() {
  createOpen.value = false
}

function submitCreate() {
  const result = createEntry(meta.key, createForm.value)
  if (!result.ok) {
    createError.value = result.message
    return
  }
  createOpen.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    dataset.value = listEntries(meta.key).items
    refreshDetail()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '隐患点建档列表读取失败'
  }
}

onMounted(reload)
</script>
