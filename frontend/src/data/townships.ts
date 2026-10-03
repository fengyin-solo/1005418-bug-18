// 所在乡镇的唯一取数入口：筛选、登记表单、详情抽屉都从这里拿，不允许各入口各写一份。
// 沿用历史记录的取值，不在登记或详情里重算乡镇。
export const TOWNSHIPS: readonly string[] = [
  '城关镇',
  '青龙镇',
  '白沙镇',
  '沙坪乡',
  '云岭乡',
  '双河镇',
]

// 所属乡镇为空（含纯空白）时按无效值处理，登记处要退回重填。
export function isInvalidTownship(value: unknown): boolean {
  return String(value ?? '').trim() === ''
}
