package bot.dusk.mobile;

import android.content.pm.PackageManager;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String PERMISSION_ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK";
    private static final int REQUEST_LOCAL_NETWORK = 9001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SpeechRecognizerPlugin.class);
        registerPlugin(PushSetupPlugin.class);
        registerPlugin(HapticsPlugin.class);
        registerPlugin(InsetsPlugin.class);
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        requestLocalNetworkPermissionIfSupported();
    }

    // Android 16/17 Local Network Protection gates LAN traffic behind ACCESS_LOCAL_NETWORK;
    // check PackageManager first so older OS releases skip the prompt cleanly.
    private void requestLocalNetworkPermissionIfSupported() {
        try {
            getPackageManager().getPermissionInfo(PERMISSION_ACCESS_LOCAL_NETWORK, 0);
        } catch (PackageManager.NameNotFoundException ignored) {
            return;
        }
        if (ContextCompat.checkSelfPermission(this, PERMISSION_ACCESS_LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { PERMISSION_ACCESS_LOCAL_NETWORK }, REQUEST_LOCAL_NETWORK);
        }
    }
}
