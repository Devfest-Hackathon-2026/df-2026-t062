// ケアプランの AI 原案（#90）。保存済みのアセスメントだけを根拠に、第1表の候補と第2表のニーズ・目標・サービスの候補を返す。
// ここでは計画版を書き換えない。適用はケアマネが明示的に行う（db/care-plans.ts の applyCarePlanAiDraft）。
// ログには指示文・答え・利用者の値を出さない。
import { GoogleGenAI } from '@google/genai'
import type { CarePlanDrafter } from '../db/care-plans.ts'

/** AI を使わない環境の試しの原案（空）。API の形だけを確かめるのに使う */
export const fakeCarePlanDrafter: CarePlanDrafter = async () => ({
  plan1: {},
  needs: [],
  slots: [],
  conflicts: [],
})

const PROMPT = `あなたは日本の居宅介護支援のケアマネジャーを補助します。
保存済みのアセスメントの値だけを根拠に、居宅サービス計画書の原案を作ってください。
根拠がないことは書かないでください。意向・サービス・頻度・費用・日時を推測で決めないでください。
第1表は plan.intentionAnalysis（課題分析の結果）と plan.overallPolicy（総合的な援助の方針）を中心に、根拠がある場合だけ候補を出してください。
第2表は、ニーズごとに長期目標を1つ、短期目標を0個以上、短期目標ごとにサービスを0個以上出してください。
本人の取組や家族による援助も、根拠があるときはサービス内容と種別に記載してください。保険給付の対象内であることが根拠に明記されている場合だけ insured を true にしてください。
出力は次の形の JSON だけにしてください。説明文や Markdown は付けないでください。
{
  "plan1": { "plan.intentionAnalysis": "…", "plan.overallPolicy": "…" },
  "needs": [
    {
      "need": "生活全般の解決すべき課題",
      "longGoal": { "goal": "長期目標", "periodText": "期間（表示用）" },
      "shortGoals": [
        { "goal": "短期目標", "periodText": "期間（表示用）", "services": [
          { "content": "サービス内容", "insured": false, "kind": "サービス種別", "provider": "サービス提供を行う事業所", "frequency": "週1回", "periodText": "期間" }
        ] }
      ]
    }
  ],
  "slots": [],
  "conflicts": [ { "target": "…", "reason": "根拠が食い違う点" } ]
}
第3表の候補は、保存済みアセスメントに曜日・開始時刻・終了時刻や週単位以外の予定が明記されている場合だけ slots に含めてください。不明な日時を推測しないでください。
slots の例：{"serviceRef":{"need":0,"shortGoal":0,"service":0},"scheduleType":"weekly","weekday":1,"start":"09:00","end":"10:00","endsNextDay":false}
serviceRef はこの原案の needs/shortGoals/services の0始まりの添字です。既存IDやサービス名による対応付けはしません。曜日は月1〜日7。週単位以外は scheduleType:"other" と note を使い、曜日・時刻は付けません。
アセスメント: `

export function geminiCarePlanDrafter(env: NodeJS.ProcessEnv): CarePlanDrafter {
  const model = env.GEMINI_MODEL ?? 'gemini-3.8-flash'
  let ai: GoogleGenAI | undefined
  return async ({ source, clientName }) => {
    ai ??= new GoogleGenAI({ vertexai: true, project: env.GOOGLE_CLOUD_PROJECT, location: env.GEMINI_LOCATION ?? 'global' })
    const input = {
      clientName,
      savedAt: source.savedAt,
      assessment: source.values,
    }
    const r = await ai.models.generateContent({
      model,
      contents: PROMPT + JSON.stringify(input),
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        temperature: 0.2,
      },
    })
    const text = r.text ?? ''
    // 前後の説明文が混ざった場合だけ、最初の { から最後の } を取り出す
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text)
  }
}
