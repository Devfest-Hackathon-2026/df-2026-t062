
import './Landing.css'
import { linkProps } from '../../lib/router.tsx'

export function Landing() {
  return (
    <div className="landing">
      <header className="landing-header">
        
<a href="/" className="landing-logo">
  <img
    src="/landing/logo.png"
    alt="ネコノテ"
    className="landing-logo-image"
  />
</a>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-content">
            <p className="landing-label">
              ケアマネジャーのためのAI書類作成支援
            </p>

            <h1>
  書類の負担を減らし、
  <br />
  <span>ケアに集中。</span>
</h1>

            <p className="landing-description">
  書類・メモを登録するだけで、AIが下書きを作成。
  <br />
  確認・修正まで、ひとつの画面でサポート。
</p>

            <a {...linkProps('/app')} className="landing-cta">
              無料で試す
            </a>
          </div>

         
<div className="landing-hero-image">
  <img
    src="/landing/devices.png"
    alt="ネコノテのPC・タブレットでの利用画面"
    className="landing-devices"
  />
</div>

        </section>

<section className="landing-support">
  <div className="landing-support-heading">
    <h2>3つの<br />サポート</h2>
  </div>

  <div className="landing-support-item">
    <div className="landing-support-icon">
  <img src="/landing/support-document.png" alt="" />
</div>
    <div>
      <h3>書類を作る</h3>
      <p>アセスメントや計画書の下書きをAIが支援。</p>
    </div>
  </div>

  <div className="landing-support-item">
    <div className="landing-support-icon">
  <img src="/landing/support-info.png" alt="" />
</div>
    <div>
      <h3>情報をまとめる</h3>
      <p>利用者情報や既存書類を整理。</p>
    </div>
  </div>

  <div className="landing-support-item">
    <div className="landing-support-icon">
  <img src="/landing/support-calendar.png" alt="" />
</div>
    <div>
      <h3>面談を準備する</h3>
      <p>次回確認したい内容をAIが整理。</p>
    </div>
  </div>
</section>

<section className="landing-flow">
  <div className="landing-flow-heading">
    <p>3ステップでかんたん</p>
    <h2>ご利用の流れ</h2>
  </div>

  <div className="landing-flow-steps">
    <article className="landing-flow-card">
      <div className="landing-flow-text">
        <div className="landing-flow-title">
          <span className="landing-flow-number">1</span>
          <h3>書類・メモを登録</h3>
        </div>
        <p>既存書類や面談メモを登録。</p>
      </div>
      <div className="landing-flow-icon">
  <img src="/landing/step-upload.png" alt="" />
</div>
    </article>

    <article className="landing-flow-card">
      <div className="landing-flow-text">
        <div className="landing-flow-title">
          <span className="landing-flow-number">2</span>
          <h3>AIで書類作成</h3>
        </div>
        <p>必要書類を作成・確認。</p>
      </div>
      <div className="landing-flow-icon">
  <img src="/landing/step-ai.png" alt="" />
</div>
    </article>

    <article className="landing-flow-card">
      <div className="landing-flow-text">
        <div className="landing-flow-title">
          <span className="landing-flow-number">3</span>
          <h3>確認・修正して保存</h3>
        </div>
        <p>内容を整えて保存。</p>
      </div>
      <div className="landing-flow-icon">
  <img src="/landing/step-check.png" alt="" />
</div>
    </article>
  </div>
</section>

      </main>
    </div>
  )
}
