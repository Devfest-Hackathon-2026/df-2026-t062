// 職員の管理（責任者の staff.manage）と、サイト管理者（site.manage）の DB の読み書き。docs/再設計/14_認可.md。
// サイト管理者の関数は、利用者の情報を持つ表を読まない。
import { tx, type Db, type Tx } from './pool.ts'
import { auditContextOf, Forbidden, NotFound, type Staff } from './repo.ts'
import { writeSecurityAudit, type AuditContext } from './audit.ts'

/** そのアカウント（uid）は、もう職員かサイト管理者として登録されている（409） */
export class AlreadyRegistered extends Error {}

export interface StaffMember { id: string, name: string, email: string | null, role: string, disabled: boolean, createdAt: string }

const member = (r: Record<string, unknown>): StaffMember => ({
  id: r.id as string, name: r.name as string, email: r.email as string | null, role: r.role as string,
  disabled: r.disabled_at !== null, createdAt: (r.created_at as Date).toISOString(),
})

/** 自分の事業所の職員（止めた人も含む） */
export async function listStaff(db: Db, officeId: string): Promise<StaffMember[]> {
  const r = await db.query('SELECT id, name, email, role, disabled_at, created_at FROM staff WHERE office_id = $1 ORDER BY created_at, id', [officeId])
  return r.rows.map(member)
}

/** そのアカウントが、どこかの事業所の職員かサイト管理者として、もう登録されていれば AlreadyRegistered */
async function assertNew(c: Tx, authUid: string) {
  const r = await c.query('SELECT 1 FROM staff WHERE auth_uid = $1 UNION ALL SELECT 1 FROM site_admins WHERE auth_uid = $1 LIMIT 1', [authUid])
  if (r.rows.length) throw new AlreadyRegistered(authUid)
}

/** 職員の行を足す（auth_uid の一意で、同時に登録しても 1 つ） */
async function insertStaff(c: Tx, officeId: string, s: { authUid: string, name: string, email: string, role: string }): Promise<StaffMember> {
  await assertNew(c, s.authUid)
  try {
    const r = await c.query(
      'INSERT INTO staff (office_id, auth_uid, name, email, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role, disabled_at, created_at',
      [officeId, s.authUid, s.name, s.email, s.role],
    )
    return member(r.rows[0])
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AlreadyRegistered(s.authUid)
    throw e
  }
}

export interface NewStaff { authUid: string, name: string, email: string, role: string }

/** 責任者が、自分の事業所に職員を登録する（アカウントは api/auth.ts の Accounts が先に作る） */
export async function createStaff(db: Db, actor: Staff, s: NewStaff): Promise<StaffMember> {
  return tx(db, async (c) => {
    const m = await insertStaff(c, actor.officeId, s)
    await writeSecurityAudit(c, {
      officeId: actor.officeId,
      actorStaffId: actor.id,
      targetStaffId: m.id,
      targetType: 'staff',
      targetId: m.id,
      action: 'staff.create',
      detail: { role: m.role },
      context: auditContextOf(actor),
    })
    return m
  })
}

/** role は api/permissions.ts の STAFF_ROLES のどれか（入口で確かめる） */
export interface StaffChange { role?: string, disabled?: boolean }

/**
 * 職員を止める・戻す・役割を変える。ほかの事業所の職員は「無い」（404）。
 * 自分は止められず、役割も変えられない（事業所に責任者がいなくなるのを防ぐ）。止めたり役割を変えたりしたら、次のリクエストから効く
 */
export async function updateStaff(db: Db, actor: Staff, staffId: string, change: StaffChange): Promise<StaffMember> {
  return tx(db, async (c) => {
    const target = (await c.query('SELECT id FROM staff WHERE id = $1 AND office_id = $2', [staffId, actor.officeId])).rows[0]
    if (!target) throw new NotFound(staffId)
    if (target.id === actor.id) throw new Forbidden('自分を止めたり、自分の役割を変えたりはできません')
    const r = await c.query(
      `UPDATE staff SET
         role = COALESCE($3, role),
         disabled_at = CASE WHEN $4::boolean IS NULL THEN disabled_at WHEN $4 THEN COALESCE(disabled_at, now()) ELSE NULL END
       WHERE id = $1 AND office_id = $2
       RETURNING id, name, email, role, disabled_at, created_at`,
      [staffId, actor.officeId, change.role ?? null, change.disabled ?? null],
    )
    await writeSecurityAudit(c, {
      officeId: actor.officeId,
      actorStaffId: actor.id,
      targetStaffId: staffId,
      targetType: 'staff',
      targetId: staffId,
      action: 'staff.update',
      detail: { changed: Object.keys(change) },
      context: auditContextOf(actor),
    })
    return member(r.rows[0])
  })
}

// ---------- サイト管理者 ----------

export interface SiteAdmin { id: string, name: string, email: string }

export async function siteAdminByAuth(db: Db, authUid: string): Promise<SiteAdmin | null> {
  const r = (await db.query('SELECT id, name, email FROM site_admins WHERE auth_uid = $1', [authUid])).rows[0]
  return r ? { id: r.id, name: r.name, email: r.email } : null
}

export interface NewOffice { name: string, phone?: string | null, fax?: string | null, admin: Omit<NewStaff, 'role'> }

/** サイト管理者が、事業所とその最初の責任者を登録する（1 つのトランザクション。責任者のアカウントは先に作る） */
export async function createOffice(db: Db, o: NewOffice, context?: AuditContext): Promise<{ office: { id: string, name: string, createdAt: string }, admin: StaffMember }> {
  return tx(db, async (c) => {
    await assertNew(c, o.admin.authUid)
    const r = (await c.query('INSERT INTO offices (name, phone, fax) VALUES ($1, $2, $3) RETURNING id, name, created_at', [o.name, o.phone ?? null, o.fax ?? null])).rows[0]
    const admin = await insertStaff(c, r.id, { ...o.admin, role: 'admin' })
    await writeSecurityAudit(c, {
      officeId: r.id,
      targetStaffId: admin.id,
      targetType: 'office',
      targetId: r.id,
      action: 'office.create',
      detail: { adminStaffId: admin.id },
      context,
    })
    return { office: { id: r.id, name: r.name, createdAt: (r.created_at as Date).toISOString() }, admin }
  })
}

/** 事業所の一覧（名前だけ。利用者・書類の表は読まない） */
export async function listOffices(db: Db): Promise<{ id: string, name: string, createdAt: string }[]> {
  const r = await db.query('SELECT id, name, created_at FROM offices ORDER BY created_at, id')
  return r.rows.map((o) => ({ id: o.id, name: o.name, createdAt: (o.created_at as Date).toISOString() }))
}
