// 役割ごとにしてよい操作（docs/再設計/14_認可.md の権限表）。権限表はここにだけ置く。
// API の入口は、それぞれ操作を 1 つ宣言する（api/app.ts の staffRoute・siteRoute）。

export const OPERATIONS = ['care.work', 'staff.manage', 'form.manage', 'site.manage'] as const
export type Operation = typeof OPERATIONS[number]

/** 事業所に属する役割（staff.role）。足すときは staff.role の CHECK にも足す */
export const STAFF_ROLES = ['caremanager', 'admin'] as const
export type StaffRole = typeof STAFF_ROLES[number]

/** caremanager: ケアマネ、admin: 事業所の責任者、siteAdmin: サイト管理者（site_admins。事業所に属さない） */
export type Role = StaffRole | 'siteAdmin'

const PERMISSIONS: Readonly<Record<Operation, readonly Role[]>> = {
  // 利用者の登録、録音、AI の下書き、書類を作る・直す・保存する・PDF で出す、点検する・点検の結果に判断を付ける
  'care.work': ['caremanager', 'admin'],
  // 自分の事業所の職員を登録する・止める、役割を変える
  'staff.manage': ['admin'],
  // 自分の事業所の様式の登録、要約の項目を直す
  'form.manage': ['admin'],
  // 事業所と最初の責任者の登録、書類の種類と全体の様式の登録
  'site.manage': ['siteAdmin'],
}

/** その役割にその操作を許すか。表にない役割は何もできない */
export const allows = (role: string, op: Operation): boolean => (PERMISSIONS[op] as readonly string[]).includes(role)

/** その役割でできる操作（画面がメニューを出し分けるのに使う） */
export const operationsOf = (role: string): Operation[] => OPERATIONS.filter((op) => allows(role, op))
