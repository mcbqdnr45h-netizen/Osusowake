import UIKit
import Capacitor
import WebKit

// ★ 起動時の黒画面対策専用のブリッジ VC サブクラス。
//
//   症状: LaunchScreen.storyboard (クリーム+ロゴ) が消えた後、WKWebView が
//   リモート URL (osusowakejapan.org) の初回ペイントを終えるまでの ~0.6〜1s、
//   不透明な WebView が「真っ黒」を描く (シミュレータで実測・再現済)。
//   webView.isOpaque=false + backgroundColor だけでは、リモートロード開始後の
//   WebKit 描画レイヤが黒を描くのを防げない (dead-url では防げるが live では不可)。
//
//   対策: viewDidLoad で LaunchScreen と同一の「クリーム背景 + 中央ロゴ」カバーを
//   WebView の上に敷き、リモートページのロード完了 (estimatedProgress≒1.0) まで
//   保持する。LaunchScreen とピクセル一致するのでハンドオフはシームレス。
//   → 起動〜Web 初回ペイントまで一貫してクリーム。黒フレームが物理的に出ない。
class MainViewController: CAPBridgeViewController, WKScriptMessageHandler {

    private let brand = UIColor(red: 0.984, green: 0.973, blue: 0.957, alpha: 1.0)
    private var coverView: UIView?
    private var coverLogo: UIImageView?
    private var progressObs: NSKeyValueObservation?
    private var coverRemoved = false
    private var webViewConfigured = false

    // ★★ 最重要: WKWebView が「生まれる瞬間」に isOpaque=false + cream を焼き込む。
    //   CAPBridgeViewController.loadView() は
    //     prepareWebView → webView(with:configuration:) で WKWebView を生成し
    //     直後に `view = webView` する。
    //   デフォルト WKWebView は isOpaque=true。この不透明レイヤは、別プロセスの
    //   WebContent が初回ペイントを返すまで「黒」を描く (cold launch の黒の正体)。
    //   従来は viewDidLoad / viewDidLayoutSubviews で isOpaque=false にしていたが、
    //   それは webView 生成後＝既に黒フレームが1枚合成され得た後で手遅れだった。
    //   ここ(生成点)で非不透明化すれば、WebView は一度も不透明黒を持たない。
    //   → 起動ズーム〜Web 初回ペイントまで、下地の cream が透けて黒フレームが物理的に出ない。
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        // ★ web (index.html) が「React 描画完了 & web スプラッシュ DOM 除去完了」時に
        //   投げる postMessage("coverOff") を受ける口を、WKWebView 生成前に登録する。
        //   これが cover を外す唯一のトリガー (下の userContentController で処理)。
        configuration.userContentController.add(self, name: "coverOff")
        let wv = super.webView(with: frame, configuration: configuration)
        wv.isOpaque = false
        wv.backgroundColor = brand
        wv.scrollView.backgroundColor = brand
        return wv
    }

    // ★★ 保証の核心: cover を外すのは「web が coverOff を投げた瞬間」だけ。
    //   web は React 本体を #root に描画し、かつ web スプラッシュを DOM から完全除去した
    //   "後" に coverOff を投げる (index.html)。 つまりこの通知が来た時点で、cover の
    //   下地は React アプリ本体のみ＝「落ちるロゴ」が画面に物理的に存在しない。
    //   だから cover をここで外しても、位置ズレの有無に関係なくドロップは構造的に不可能。
    //   (従来の estimatedProgress≥0.98 トリガーは React マウント前に発火し得てズレた
    //    web スプラッシュを露出させる元凶だったので撤去した。)
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "coverOff" {
            removeCover(afterDelay: 0)
        }
    }

    // ★ webView 生成直後・hierarchy 追加前に呼ばれる最早フック。ここでも冪等に固める。
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        configureWebViewIfPossible()
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        view.backgroundColor = brand
        installCover()
        configureWebViewIfPossible()

        // フェイルセーフ: 何があってもカバーは最大 8s で必ず外す (永久カバー防止)。
        DispatchQueue.main.asyncAfter(deadline: .now() + 8.0) { [weak self] in
            self?.removeCover(afterDelay: 0)
        }
    }

    // ★ CAPBridgeViewController の webView は viewDidLoad 時点では nil のことがある
    //   (Capacitor が遅延生成)。 その場合 isOpaque=false / cream 背景が適用されず、
    //   WebView が「不透明の黒デフォルト」のまま生成 → クリームカバーの上に乗って
    //   起動時の黒フレームになる。 viewDidLayoutSubviews は webView 生成後に必ず
    //   呼ばれるので、ここで毎回冪等に (1)WebView をクリーム非不透明化 (2)進捗監視の
    //   セットアップ (3)カバーを最前面に維持 する。 これで黒が物理的に出ない。
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        configureWebViewIfPossible()
        // 後から追加され得る webView より常にカバーを前面に保つ (未除去の間)。
        if let cover = coverView, !coverRemoved {
            view.bringSubviewToFront(cover)
        }
        layoutCoverLogoToPhysicalScreen()
    }

    // ★★ ロゴを「物理スクリーン全体」に aspectFit で敷く (＝ネイティブ LaunchScreen と完全一致)。
    //   問題: StatusBar.overlaysWebView:false のため CAPBridgeViewController の view(＝WKWebView)
    //   はステータスバー分だけ上が inset され、画面より縦に短い。 従来はロゴを cover(＝view)の
    //   4辺にピン留めしていたため、ロゴが「短い webView の中央」に来て真の画面中央より
    //   下にずれた (実機 iPhone16 で +80 device px 実測)。 一方 LaunchScreen は全画面 edge-to-edge
    //   で真の 50% に描くので、LaunchScreen→cover のハンドオフでロゴが「下にストンと落ちる」。
    //   対策: cover(inset webView 上)の座標系に、物理スクリーン全体を占める frame を手動計算して
    //   ロゴ img を置く。 view.convert で webView 左上のウィンドウ座標(=ステータスバー高さ)を得て
    //   frame.origin をその逆符号にすれば、img は inset を無視して画面全体を覆う → aspectFit の
    //   中央ロゴが真の画面中央に来て LaunchScreen と 1px も違わない。
    private func layoutCoverLogoToPhysicalScreen() {
        guard let iv = coverLogo, let window = view.window ?? UIApplication.shared.windows.first else { return }
        let screen = window.bounds                       // 物理スクリーン全体 (edge-to-edge)
        let originInWindow = view.convert(CGPoint.zero, to: nil)  // webView 左上のウィンドウ座標
        // cover(=view) 座標系における「画面全体」の矩形。
        iv.frame = CGRect(x: -originInWindow.x,
                          y: -originInWindow.y,
                          width: screen.width,
                          height: screen.height)
    }

    private func configureWebViewIfPossible() {
        guard let wv = webView else { return }
        // 背景は毎回強制 (Capacitor が opaque に戻す場合の保険)。
        wv.isOpaque = false
        wv.backgroundColor = brand
        wv.scrollView.backgroundColor = brand
        // ★ cover 除去は coverOff (web→native) のみが担う。 estimatedProgress≥0.98 は
        //   React マウント前に発火してズレた web スプラッシュを露出させる元凶だったので
        //   トリガーから撤去。 万一 coverOff が届かない異常系は viewDidLoad の 8s 失効が拾う。
        _ = webViewConfigured
    }

    // LaunchScreen.storyboard と同一構成: 全画面クリーム + 物理スクリーン全体に敷いた aspectFit ロゴ。
    //   ※ ロゴは cover の 4辺ピンではなく layoutCoverLogoToPhysicalScreen() で毎レイアウト時に
    //     「物理スクリーン全体」へ手動配置する (inset webView を無視 → 真の画面中央 = LaunchScreen 一致)。
    private func installCover() {
        let cover = UIView(frame: view.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = brand
        cover.clipsToBounds = false   // ロゴ frame が cover 上端(ステータスバー分)を越えても描画させる。

        let iv = UIImageView(image: UIImage(named: "Splash"))
        iv.contentMode = .scaleAspectFit
        iv.translatesAutoresizingMaskIntoConstraints = true  // frame 手動制御。
        cover.addSubview(iv)

        view.addSubview(cover)
        coverView = cover
        coverLogo = iv
        layoutCoverLogoToPhysicalScreen()
    }

    private func removeCover(afterDelay delay: TimeInterval) {
        guard !coverRemoved, let cover = coverView else { return }
        coverRemoved = true
        progressObs?.invalidate()
        progressObs = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            UIView.animate(withDuration: 0.35, animations: {
                cover.alpha = 0
            }, completion: { _ in
                cover.removeFromSuperview()
            })
            self.coverView = nil
            self.coverLogo = nil
        }
    }

    // クリーム背景に白文字だと読めないため、ステータスバー文字を暗くする。
    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .darkContent
    }
}
