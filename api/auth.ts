// ログインの確かめ（Identity Platform / Firebase Authentication の ID トークン）と、アカウントを作ること。
//   AUTH_MODE=firebase（既定）: firebase-admin で ID トークンを確かめる・アカウントを作る。FIREBASE_AUTH_EMULATOR_HOST があればエミュレータ
//   AUTH_MODE=dev: 「dev:<メール>」をトークンとして受け付ける（ローカルとテストだけ。本番では使わない）
export interface AuthUser {
  uid: string
  email?: string
}

export interface Verifier {
  verify(token: string): Promise<AuthUser | null>
}

export class DevVerifier implements Verifier {
  async verify(token: string): Promise<AuthUser | null> {
    if (!token.startsWith('dev:')) return null
    const email = token.slice(4).trim()
    return email ? { uid: `dev:${email}`, email } : null
  }
}

let adminAuth: Promise<import('firebase-admin/auth').Auth> | undefined
/** firebase-admin の Auth（プロセスで 1 つ） */
function firebaseAuth() {
  adminAuth ??= (async () => {
    const { initializeApp, getApps } = await import('firebase-admin/app')
    const { getAuth } = await import('firebase-admin/auth')
    const app = getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT })
    return getAuth(app)
  })()
  return adminAuth
}

export class FirebaseVerifier implements Verifier {
  async verify(token: string): Promise<AuthUser | null> {
    try {
      const d = await (await firebaseAuth()).verifyIdToken(token)
      return { uid: d.uid, email: d.email }
    } catch {
      return null
    }
  }
}

// ---------- アカウントを作る（責任者が職員を登録する・サイト管理者が最初の責任者を登録する。docs/再設計/14_認可.md） ----------
// パスワードはここでは決めない。本人が、パスワードを決めるメール（画面が Firebase の sendPasswordResetEmail で送る）から決める。
// 画面からのアカウント作成は禁止している（infra/gcp/identity.tf の disabled_user_signup）ので、アカウントを作るのはこの入口だけ

export interface Accounts {
  /** そのメールのアカウントの uid。なければ作る（created: true） */
  ensureUser(email: string, displayName: string): Promise<{ uid: string, created: boolean }>
}

/** dev: uid は「dev:<メール>」（DevVerifier と同じ） */
export class DevAccounts implements Accounts {
  async ensureUser(email: string) {
    return { uid: `dev:${email}`, created: false }
  }
}

/** firebase-admin のうち使うところ（テストで差し替える） */
export interface AuthAdmin {
  getUserByEmail(email: string): Promise<{ uid: string }>
  createUser(p: { email: string, displayName: string }): Promise<{ uid: string }>
}

const codeOf = (e: unknown) => (e as { code?: string })?.code

/** firebase-admin でアカウントを作る。api のサービスアカウントに roles/firebaseauth.admin が要る（infra/gcp/iam.tf） */
export class FirebaseAccounts implements Accounts {
  private admin: () => Promise<AuthAdmin>

  constructor(admin: () => Promise<AuthAdmin> = firebaseAuth) {
    this.admin = admin
  }

  async ensureUser(email: string, displayName: string) {
    const auth = await this.admin()
    try {
      return { uid: (await auth.getUserByEmail(email)).uid, created: false }
    } catch (e) {
      if (codeOf(e) !== 'auth/user-not-found') throw e
    }
    try {
      return { uid: (await auth.createUser({ email, displayName })).uid, created: true }
    } catch (e) {
      // 同時に作られた
      if (codeOf(e) === 'auth/email-already-exists') return { uid: (await auth.getUserByEmail(email)).uid, created: false }
      throw e
    }
  }
}

export function defaultAccounts(env: NodeJS.ProcessEnv = process.env): Accounts {
  return env.AUTH_MODE === 'dev' ? new DevAccounts() : new FirebaseAccounts()
}

export function defaultVerifier(env: NodeJS.ProcessEnv = process.env): Verifier {
  if (env.AUTH_MODE === 'dev') {
    if (env.NODE_ENV === 'production' && env.ALLOW_DEV_AUTH !== 'true') throw new Error('AUTH_MODE=dev は本番では使えません')
    return new DevVerifier()
  }
  return new FirebaseVerifier()
}
