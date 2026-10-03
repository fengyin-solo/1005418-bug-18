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
        <select v-if="field === '所在乡镇'" v-model="filters[field]">
          <option value="">全部乡镇</option>
          <option v-for="town in townships" :key="town" :value="town">{{ town }}</option>
        </select>
        <input v-else v-model="filters[field]" :placeholder="`按${field}检索`" />
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
          <td v-for="column in columns" :key="column">
            <button v-if="column === '隐患编号'" class="link" type="button" @click="openDetail(row.id)">
              {{ row[column] ?? '—' }}
            </button>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row.id)">详情</button>
            <button
              v-if="nextAction(row.status)"
              class="link"
              type="button"
              @click="runAction(String(nextAction(row.status)), row)"
            >
              {{ nextAction(row.status) }}
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

    <!-- 登记弹窗：所在乡镇只能选统一目录里的值，空值整单退回重填。 -->
    <div v-if="creating" class="drawer-mask" @click.self="closeCreate">
      <div class="form-dialog">
        <h3>登记隐患点</h3>
        <form @submit.prevent="submitCreate">
          <label v-for="field in createTextFields" :key="field" class="dialog-field">
            <span>{{ field }}</span>
            <input v-model="draft[field]" :placeholder="`请填写${field}`" />
          </label>
          <label class="dialog-field">
            <span>所在乡镇</span>
            <select v-model="draft.所在乡镇">
              <option value="" disabled>请选择所在乡镇</option>
              <option v-for="town in townships" :key="town" :value="town">{{ town }}</option>
            </select>
          </label>
          <p v-if="createError" class="error-text">{{ createError }}</p>
          <div class="dialog-actions">
            <button class="btn ghost" type="button" @click="closeCreate">取消</button>
            <button class="btn primary" type="submit">提交登记</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 详情抽屉：直接按 id 读落库的那一条，与列表、总览同源同值。 -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="detail-drawer">
        <h3>隐患点详情</h3>
        <dl class="detail-list">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ detail[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detail.status }}</dd>
        </dl>
        <p class="drawer-tip">状态按 {{ statuses.join(' → ') }} 固定次序推进，插队操作不予受理。</p>
        <p v-if="detailError" class="error-text">{{ detailError }}</p>
        <div class="dialog-actions">
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
          <button
            v-if="nextAction(detail.status)"
            class="btn primary"
            type="button"
            @click="runAction(String(nextAction(detail.status)), detail)"
          >
            {{ nextAction(detail.status) }}
          </button>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  hazardStats,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitHazard,
} from '@/api/local-service'
import { TOWNSHIPS } from '@/data/townships'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('hazard')
const columns = ['隐患编号', '所在乡镇', '灾害类型', '坡体规模', '威胁户数', '威胁人数', '发现日期', '隐患状态']
const statuses = ['待核查', '建档中', '重点防范', '已消除']
// 登记弹窗里走文本框的字段；所在乡镇单独走统一目录的下拉。
const createTextFields = ['隐患编号', '灾害类型', '坡体规模', '威胁户数', '威胁人数', '发现日期'] as const
const townships = TOWNSHIPS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const stats = ref(hazardStats())
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 固定次序下，当前状态只对应一个合法动作；末态或异常状态没有可办动作。
function nextAction(status: string): string | undefined {
  const index = meta.statuses.indexOf(String(status))
  if (index < 0 || index >= meta.statuses.length - 1) {
    return undefined
  }
  const nextStatus = meta.statuses[index + 1]
  return meta.actions.find((action) => meta.actionTargets[action] === nextStatus)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

const creating = ref(false)
const createError = ref('')
const emptyDraft = () => ({
  隐患编号: '',
  所在乡镇: '',
  灾害类型: '',
  坡体规模: '',
  威胁户数: '',
  威胁人数: '',
  发现日期: '',
})
const draft = ref(emptyDraft())

function openCreate() {
  draft.value = emptyDraft()
  createError.value = ''
  creating.value = true
}

function closeCreate() {
  creating.value = false
}

function submitCreate() {
  createError.value = ''
  const result = submitHazard({ ...draft.value })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  creating.value = false
  reload()
  if (typeof result.id === 'number') {
    openDetail(result.id)
  }
}

const detail = ref<EntryRow | null>(null)
const detailError = ref('')

function openDetail(id: number) {
  detailError.value = ''
  // 抽屉不拿列表里的行副本，每次都按 id 回读落库记录。
  detail.value = getEntry(meta.key, id) ?? null
}

function closeDetail() {
  detail.value = null
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  detailError.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    if (detail.value) {
      detailError.value = result.message
    } else {
      errorMessage.value = result.message
    }
    return
  }
  // 动作只改落库那一条：列表、指标、抽屉全部回读同一处。
  reload()
  if (detail.value) {
    detail.value = getEntry(meta.key, Number(row.id)) ?? detail.value
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = hazardStats()
    // 抽屉若开着也跟着刷新，保证与列表看到的是同一条记录的最新状态。
    if (detail.value) {
      detail.value = getEntry(meta.key, Number(detail.value.id)) ?? detail.value
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '隐患点建档列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 20;
}
.form-dialog {
  width: 420px;
  background: #fff;
  padding: 20px;
  margin: 40px auto;
  border-radius: 8px;
  align-self: flex-start;
}
.detail-drawer {
  width: 420px;
  background: #fff;
  min-height: 100%;
  padding: 20px;
}
.dialog-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  font-size: 13px;
}
.dialog-field span {
  color: var(--muted);
}
.dialog-field input,
.dialog-field select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.detail-list {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 6px 12px;
  margin: 12px 0;
  font-size: 13px;
}
.detail-list dt {
  color: var(--muted);
}
.detail-list dd {
  margin: 0;
}
.drawer-tip {
  font-size: 12px;
  color: var(--muted);
}
</style>
