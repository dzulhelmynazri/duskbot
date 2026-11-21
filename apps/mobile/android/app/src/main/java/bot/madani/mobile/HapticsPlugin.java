package bot.dusk.mobile;

import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The system's own short haptics, played on the web view, in place of @capacitor/haptics' Vibrator pulses (43-50 ms
 * buzzes on Android 14-16). They follow the person's touch-feedback setting.
 */
@CapacitorPlugin(name = "DuskHaptics")
public class HapticsPlugin extends Plugin {

    @PluginMethod
    public void play(PluginCall call) {
        String kind = call.getString("kind", "light");
        View view = getBridge().getWebView();
        if (view == null) { call.resolve(); return; }
        int constant;
        switch (kind) {
            case "medium": constant = HapticFeedbackConstants.LONG_PRESS; break;
            case "success": constant = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.KEYBOARD_TAP; break;
            case "error": constant = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS; break;
            case "selection": constant = Build.VERSION.SDK_INT >= 27 ? HapticFeedbackConstants.TEXT_HANDLE_MOVE : HapticFeedbackConstants.CLOCK_TICK; break;
            default: constant = HapticFeedbackConstants.KEYBOARD_TAP;
        }
        view.post(() -> view.performHapticFeedback(constant));
        call.resolve();
    }
}
