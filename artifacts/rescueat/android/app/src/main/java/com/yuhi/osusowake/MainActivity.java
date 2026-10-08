package com.yuhi.osusowake;

import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onStart() {
        super.onStart();
        // ★ Android の WebView は端末の「文字サイズ」設定を textZoom として掛け算し、
        //   アプリ全体が拡大されてレイアウトが崩れる (iOS の WKWebView はこの設定を
        //   無視するため iPhone では発生しない)。iPhone と同じ見た目に固定するため
        //   textZoom を常に 100% にする。
        WebSettings settings = this.bridge.getWebView().getSettings();
        settings.setTextZoom(100);
    }
}
