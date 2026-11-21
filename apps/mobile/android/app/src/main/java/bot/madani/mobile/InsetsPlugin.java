package bot.madani.mobile;

import android.graphics.Color;
import android.view.View;
import android.view.Window;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.BackEventCompat;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;
import java.util.Locale;

/**
 * The window's insets, edge to edge (capacitor.config.ts turns SystemBars' own handling off). The web view always gets
 * the system bars as --safe-area-inset-* and never the keyboard's inset, which goes one of two ways:
 * - "ride", the chat composer's field: the window keeps its full height and the page hears the keyboard's start (its
 *   height, duration and start time, before its first frame) and its end, so the transcript rides it on the compositor
 *   and takes the space in one frame once it stops;
 * - "resize", any other field: the window ends at the keyboard (at once on the way up, when it has gone on the way
 *   down), so Chromium keeps the focused field in view as adjustResize did.
 */
@CapacitorPlugin(name = "MadaniInsets")
public class InsetsPlugin extends Plugin {

    private boolean ride = false;
    private boolean animating = false;
    private int ime = 0;
    private int padding = 0;
    /** the keyboard height the page last heard, in px */
    private int told = 0;
    private Insets bars = Insets.NONE;
    private String injected = "";

    @Override
    public void load() {
        Window window = getActivity().getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        View decor = window.getDecorView();
        // after every plugin's load, so the keyboard plugin's animation callback on the decor view is replaced
        decor.post(() -> {
            ViewCompat.setOnApplyWindowInsetsListener(decor, this::onInsets);
            ViewCompat.setWindowInsetsAnimationCallback(decor, new KeyboardMove());
            ViewCompat.requestApplyInsets(decor);
            // added after @capacitor/app's own, so while enabled it hears back first
            getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), backGesture);
        });
        WebView web = getBridge().getWebView();
        if (web != null) {
            web.setOverScrollMode(View.OVER_SCROLL_NEVER);
            WebSettings settings = web.getSettings();
            settings.setOffscreenPreRaster(true);
        }
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                injected = "";
                inject();
            }
        });
    }

    /** Which way the keyboard goes for the field that now has focus: `{ ride: true }` for the chat composer's. */
    @PluginMethod
    public void setMode(PluginCall call) {
        boolean next = Boolean.TRUE.equals(call.getBoolean("ride", false));
        getBridge().executeOnMainThread(() -> {
            if (next != ride) {
                ride = next;
                if (!animating) {
                    pad(ride ? 0 : ime);
                    emit(ride ? ime : 0, true, 0);
                    inject();
                }
            }
            call.resolve();
        });
    }

    /**
     * While on, back goes to the page as a gesture: its start and progress (Android 14 and later report them), a cancel,
     * and the commit, which a back button or an older Android sends alone.
     */
    @PluginMethod
    public void setBackGesture(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getBridge().executeOnMainThread(() -> {
            backGesture.setEnabled(on);
            call.resolve();
        });
    }

    private final OnBackPressedCallback backGesture = new OnBackPressedCallback(false) {
        @Override
        public void handleOnBackStarted(@NonNull BackEventCompat event) {
            back("start", event.getProgress());
        }

        @Override
        public void handleOnBackProgressed(@NonNull BackEventCompat event) {
            back("progress", event.getProgress());
        }

        @Override
        public void handleOnBackCancelled() {
            back("cancel", null);
        }

        @Override
        public void handleOnBackPressed() {
            back("commit", null);
        }
    };

    private void back(String phase, Float progress) {
        JSObject event = new JSObject();
        event.put("phase", phase);
        if (progress != null) event.put("progress", progress);
        notifyListeners("back", event);
    }

    /** The bars' icons, light or dark, and the page's ground (#rrggbb) for the window behind the web view. */
    @PluginMethod
    public void setBars(PluginCall call) {
        String status = call.getString("status", "dark");
        String ground = call.getString("ground", "");
        // a live scan draws the camera behind a see-through web view: its bars go light on it and nothing is painted
        boolean camera = Boolean.TRUE.equals(call.getBoolean("camera", false));
        getBridge().executeOnMainThread(() -> {
            Window window = getActivity().getWindow();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!camera && "dark".equals(status));
            Integer color = parse(ground);
            if (camera) {
                controller.setAppearanceLightNavigationBars(false);
            } else if (color != null) {
                controller.setAppearanceLightNavigationBars(luminance(color) > 0.5);
                window.getDecorView().setBackgroundColor(color);
                WebView web = getBridge().getWebView();
                if (web != null) web.setBackgroundColor(color);
            }
            call.resolve();
        });
    }

    private WindowInsetsCompat onInsets(View view, WindowInsetsCompat insets) {
        bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        ime = insets.isVisible(WindowInsetsCompat.Type.ime()) ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
        if (!ride && (ime > padding || !animating)) pad(ime);
        if (ride && !animating && ime != told) emit(ime, true, 0);
        inject();
        return new WindowInsetsCompat.Builder(insets)
            .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
            .setVisible(WindowInsetsCompat.Type.ime(), false)
            .build();
    }

    private final class KeyboardMove extends WindowInsetsAnimationCompat.Callback {

        KeyboardMove() {
            super(DISPATCH_MODE_STOP);
        }

        @Override
        public void onPrepare(@NonNull WindowInsetsAnimationCompat animation) {
            if (isKeyboard(animation)) animating = true;
        }

        @NonNull
        @Override
        public WindowInsetsAnimationCompat.BoundsCompat onStart(
            @NonNull WindowInsetsAnimationCompat animation,
            @NonNull WindowInsetsAnimationCompat.BoundsCompat bounds
        ) {
            if (isKeyboard(animation) && ride) emit(ime, false, animation.getDurationMillis());
            return bounds;
        }

        @NonNull
        @Override
        public WindowInsetsCompat onProgress(@NonNull WindowInsetsCompat insets, @NonNull List<WindowInsetsAnimationCompat> running) {
            return insets;
        }

        @Override
        public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
            if (!isKeyboard(animation)) return;
            animating = false;
            pad(ride ? 0 : ime);
            if (ride) emit(ime, true, 0);
            inject();
        }
    }

    private static boolean isKeyboard(WindowInsetsAnimationCompat animation) {
        return (animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0;
    }

    private void pad(int bottom) {
        if (bottom == padding) return;
        padding = bottom;
        View decor = getActivity().getWindow().getDecorView();
        decor.setPadding(0, 0, 0, bottom);
    }

    private float css(int px) {
        return px / getActivity().getResources().getDisplayMetrics().density;
    }

    private void emit(int height, boolean settled, long durationMs) {
        told = height;
        JSObject event = new JSObject();
        event.put("height", css(height));
        event.put("settled", settled);
        if (!settled) {
            event.put("duration", durationMs / 1000.0);
            event.put("at", System.currentTimeMillis());
        }
        notifyListeners("keyboard", event);
    }

    /** the window already ends at the keyboard in "resize", which covers the navigation bar */
    private void inject() {
        WebView web = getBridge().getWebView();
        if (web == null) return;
        float bottom = !ride && padding > 0 ? 0 : css(bars.bottom);
        String script = String.format(
            Locale.US,
            "(function(s){s.setProperty('--safe-area-inset-top','%.2fpx');s.setProperty('--safe-area-inset-right','%.2fpx');s.setProperty('--safe-area-inset-bottom','%.2fpx');s.setProperty('--safe-area-inset-left','%.2fpx')})(document.documentElement.style)",
            css(bars.top),
            css(bars.right),
            bottom,
            css(bars.left)
        );
        if (script.equals(injected)) return;
        injected = script;
        web.evaluateJavascript(script, null);
    }

    private static Integer parse(String hex) {
        if (hex == null || !hex.matches("#[0-9a-fA-F]{6}")) return null;
        return Color.parseColor(hex);
    }

    private static double luminance(int color) {
        return (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color)) / 255.0;
    }
}
