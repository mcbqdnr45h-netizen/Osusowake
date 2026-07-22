import React from 'react';

interface State {
  hasError: boolean;
  errorMessage: string;
}

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error?.message ?? 'Unknown error' };
  }

  private autoRecoverTimer: number | null = null;

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
    // ── 全エラー自動回復ポリシー ──────────────────────────────────────
    // ユーザーにオレンジ画面を見せない方針:
    //   ① ステイルチャンク系 (デプロイ直後の古いキャッシュ) → 即時ハードリロード
    //   ② その他エラー → セッションごとに最大1回だけ自動リロード、
    //                    既にリロード済みなら 600ms 後に boundary を自己リセットして
    //                    再レンダリング (一過性レンダリング競合の救済)。
    // 無限ループ防止のため sessionStorage で回数管理。
    const msg = String(error?.message ?? '');
    const isStaleChunk =
      msg.includes('MIME type') ||
      msg.includes('dynamically imported module') ||
      msg.includes('Loading chunk') ||
      msg.includes('Loading CSS chunk') ||
      msg.includes('Importing a module script failed');

    try {
      const RELOAD_KEY = isStaleChunk ? '__staleChunkReloaded' : '__errorReloaded';
      if (!sessionStorage.getItem(RELOAD_KEY)) {
        sessionStorage.setItem(RELOAD_KEY, '1');
        if (isStaleChunk) {
          // ★ ステイルチャンクはキャッシュバスト付きで最新 index.html を強制取得する。
          //   Instagram/iOS の in-app WebView は plain reload だと旧 index.html を
          //   キャッシュから返し、削除済みチャンクを 404 で引いて白画面のままになる。
          //   クエリを変えると必ずネットワークから取り直す。
          const url = new URL(window.location.href);
          url.searchParams.set('_cb', String(Date.now()));
          window.location.replace(url.toString());
        } else {
          window.location.reload();
        }
        return;
      }
    } catch { /* sessionStorage 不可環境は次の自己リセットへフォールバック */ }

    // 自動リロード使用済み: 600ms 後にサイレントで boundary を解除し再描画を試みる
    if (this.autoRecoverTimer == null) {
      this.autoRecoverTimer = window.setTimeout(() => {
        this.autoRecoverTimer = null;
        this.setState({ hasError: false, errorMessage: '' });
      }, 600);
    }
  }

  componentWillUnmount() {
    if (this.autoRecoverTimer != null) {
      window.clearTimeout(this.autoRecoverTimer);
      this.autoRecoverTimer = null;
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: '#F26419',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        padding: '24px',
        boxSizing: 'border-box',
      }}>
        <div style={{ color: 'white', fontSize: '20px', fontWeight: 'bold', marginBottom: '12px', textAlign: 'center' }}>
          一時的に問題が発生しました
        </div>
        <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: '13px', marginBottom: '8px', textAlign: 'center', maxWidth: '280px', lineHeight: 1.5 }}>
          再読み込みすると解消することが多いです。
        </div>
        <button
          onClick={this.handleReload}
          style={{
            marginTop: '20px',
            backgroundColor: 'white',
            color: '#F26419',
            border: 'none',
            borderRadius: '14px',
            padding: '13px 32px',
            fontSize: '16px',
            fontWeight: 'bold',
            cursor: 'pointer',
          }}
        >
          再読み込み
        </button>
      </div>
    );
  }
}
