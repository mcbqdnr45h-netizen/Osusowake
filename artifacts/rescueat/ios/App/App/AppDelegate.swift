import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    // ★ 起動ズームで「真っ黒」が出る真因＝アプリスイッチャ/起動スナップショットが黒。
    //   iOS は app が background に入る瞬間に画面スナップショットを撮り、次回起動の
    //   ズームアニメで“起動画像”として使う。ところが WKWebView の中身は別プロセス
    //   描画のためスナップショットに写らず「黒」で撮られる (WebKit の既知挙動)。
    //   → 一度でも web 表示中に background 化すると「黒スナップショット」が焼かれ、
    //     以後の起動ズームが毎回黒くなる (MainViewController の起動カバーでは防げない。
    //     あれは“起動直後の live 描画”を覆うだけで、background 時の撮影は覆わないから)。
    //   対策: resignActive/enterBackground の瞬間に window 最前面へ cream+ロゴカバーを
    //   敷き、スナップショットを必ずクリームで撮らせる。becomeActive で外す。
    //   これで起動ズーム・アプリスイッチャの黒が物理的に出なくなる。
    private let brandColor = UIColor(red: 0.984, green: 0.973, blue: 0.957, alpha: 1.0)
    // ★ カバーは「専用の別 UIWindow」にする。理由:
    //   - AppDelegate.window が実際に可視な key window とは限らない (storyboard 生成 window
    //     と別インスタンスを掴んでいると addSubview しても不可視 window に乗り無効)。
    //   - WKWebView は別プロセス描画のレイヤなので、同一 window 内の subview 順では
    //     スナップショット合成順で負ける事がある。
    //   → windowLevel = .alert+1 の独立 window なら、必ず WebView の上・必ず可視・
    //     スナップショットにも最前面で写る。これで黒撮影が物理的に不可能になる。
    private var coverWindow: UIWindow?

    private func showSnapshotCover() {
        guard coverWindow == nil else { return }
        let w: UIWindow
        if let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first {
            w = UIWindow(windowScene: scene)
        } else {
            w = UIWindow(frame: window?.bounds ?? UIScreen.main.bounds)
        }
        w.windowLevel = .alert + 1
        w.backgroundColor = brandColor
        let vc = UIViewController()
        vc.view.backgroundColor = brandColor
        let iv = UIImageView(image: UIImage(named: "Splash"))
        iv.contentMode = .scaleAspectFit
        iv.translatesAutoresizingMaskIntoConstraints = false
        vc.view.addSubview(iv)
        NSLayoutConstraint.activate([
            iv.topAnchor.constraint(equalTo: vc.view.topAnchor),
            iv.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
            iv.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            iv.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
        ])
        w.rootViewController = vc
        // key は奪わない (WebView の first responder を壊さない)。可視化のみ。
        w.isHidden = false
        coverWindow = w
    }

    private func hideSnapshotCover() {
        coverWindow?.isHidden = true
        coverWindow = nil
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // ★ 起動時の白画面対策: window 背景をスプラッシュと同じ #FBF8F4 に。
        //    WKWebView が osusowakejapan.org のロードを完了する前に背景が透ける
        //    タイミングがあっても、 白ではなくブランド色が見えるようになる。
        let brand = UIColor(red: 0.984, green: 0.973, blue: 0.957, alpha: 1.0)
        if window == nil { window = UIWindow(frame: UIScreen.main.bounds) }
        window?.backgroundColor = brand
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // ★ スナップショット撮影は resignActive〜enterBackground の間に起きる。
        //   この瞬間に cream+ロゴカバーを最前面へ → 黒 WebView ではなくクリームで撮らせる。
        showSnapshotCover()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // 念のため background 突入時も冪等にカバーを維持 (resignActive を経ない経路の保険)。
        showSnapshotCover()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // 復帰の最初期に外す (becomeActive まで残すと一瞬クリームが見えるため早めに剥がす)。
        hideSnapshotCover()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // ★ 前面化しきったらカバーを外す (二重の保険。willEnterForeground で外れているはず)。
        hideSnapshotCover()
        // ★ アプリ前面化時にアプリアイコンのバッジを 0 にクリアする。
        //   push 側は新着の合図として badge=1 を送るが、ユーザーがアプリを開いたら消す
        //   （旧実装は badge=1 が出っぱなしで消えなかった）。
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0)
        } else {
            application.applicationIconBadgeNumber = 0
        }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // ★ Capacitor PushNotifications 必須コールバック
    //   これが無いと APNs から device token が来ても Capacitor 層に届かず、
    //   JS 側の addListener('registration', ...) が永久に発火しない。
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

}
