package bot.madani.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Whether this build carries a Firebase config. The google-services Gradle plugin writes the google_app_id string from
 * google-services.json; without it @capacitor/push-notifications' register() throws inside the bridge, which crashes the
 * app (Capacitor 8.6 rethrows plugin exceptions as RuntimeException).
 */
@CapacitorPlugin(name = "MadaniPushSetup")
public class PushSetupPlugin extends Plugin {

    @PluginMethod
    public void configured(PluginCall call) {
        int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("configured", id != 0);
        call.resolve(result);
    }
}
