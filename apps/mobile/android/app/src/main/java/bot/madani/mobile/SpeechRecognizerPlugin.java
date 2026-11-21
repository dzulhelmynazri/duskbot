package bot.madani.mobile;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.util.ArrayList;

/**
 * Dictation through the phone's own recognizer (android.speech.SpeechRecognizer), offline where the phone can. The
 * recognizer stops after each pause, so it is started again while the person is still talking and the words are kept
 * across restarts. Every event carries the session number the page started it with.
 */
@CapacitorPlugin(
    name = "MadaniSpeech",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class SpeechRecognizerPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    // all state below is touched on the main thread only
    private SpeechRecognizer recognizer;
    private int session;
    private int generation;
    private boolean active;
    private boolean finishing;
    private String language;
    private String committed = "";
    private String current = "";
    private int failures;
    private long listenStarted;
    private long lastLevel;
    private Runnable finishTimeout;

    private static String join(String left, String right) {
        if (!left.isEmpty() && !right.isEmpty()) return left + " " + right;
        return left.isEmpty() ? right : left;
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        String locale = call.getString("locale");
        int number = call.getInt("session", 0);
        main.post(() -> {
            teardown();
            session = number;
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                call.reject("the microphone is not allowed", "microphone-blocked");
                return;
            }
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("this phone has no speech recognizer", "recognizer-unavailable");
                return;
            }
            language = locale == null || locale.isEmpty() ? null : locale;
            committed = "";
            current = "";
            failures = 0;
            active = true;
            try {
                listen();
            } catch (RuntimeException error) {
                teardown();
                call.reject("the speech recognizer could not start", "recognizer-unavailable");
                return;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        main.post(() -> {
            beginFinish();
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            teardown();
            call.resolve();
        });
    }

    @Override
    protected void handleOnPause() {
        // the app left the screen: keep the words heard so far
        main.post(this::beginFinish);
    }

    @Override
    protected void handleOnDestroy() {
        main.post(this::teardown);
    }

    private void listen() {
        destroyRecognizer();
        generation += 1;
        int gen = generation;
        recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        recognizer.setRecognitionListener(new Listener(gen));
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        if (language != null) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        listenStarted = SystemClock.elapsedRealtime();
        recognizer.startListening(intent);
    }

    private void restart() {
        committed = join(committed, current);
        current = "";
        // a recognizer that fails the moment it starts would otherwise loop
        boolean quick = SystemClock.elapsedRealtime() - listenStarted < 1000;
        failures = quick ? failures + 1 : 0;
        if (failures >= 5) {
            end(1, "recognition-error");
            return;
        }
        try {
            listen();
        } catch (RuntimeException error) {
            end(1, "recognition-error");
        }
    }

    private void beginFinish() {
        if (!active || finishing) return;
        finishing = true;
        if (recognizer != null) recognizer.stopListening();
        finishTimeout = this::complete;
        main.postDelayed(finishTimeout, 3000);
    }

    private void complete() {
        if (!active) return;
        String text = join(committed, current);
        if (!text.isEmpty()) emitTranscript(text, false);
        end(0, "completed");
    }

    private void end(int code, String reason) {
        int number = session;
        boolean wasActive = active;
        teardown();
        if (!wasActive) return;
        JSObject data = new JSObject();
        data.put("code", code);
        data.put("reason", reason);
        data.put("session", number);
        notifyListeners("end", data);
    }

    private void emitTranscript(String text, boolean partial) {
        JSObject data = new JSObject();
        data.put("text", text);
        data.put("partial", partial);
        data.put("session", session);
        notifyListeners("transcript", data);
    }

    private void destroyRecognizer() {
        if (recognizer == null) return;
        recognizer.setRecognitionListener(null);
        recognizer.cancel();
        recognizer.destroy();
        recognizer = null;
    }

    private void teardown() {
        if (finishTimeout != null) main.removeCallbacks(finishTimeout);
        finishTimeout = null;
        active = false;
        finishing = false;
        generation += 1;
        destroyRecognizer();
    }

    private static String firstResult(Bundle bundle) {
        if (bundle == null) return null;
        ArrayList<String> results = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (results == null || results.isEmpty() || results.get(0) == null) return null;
        return results.get(0).trim();
    }

    private class Listener implements RecognitionListener {

        private final int gen;

        Listener(int gen) {
            this.gen = gen;
        }

        private boolean stale() {
            return !active || gen != generation;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {}

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {
            if (stale() || finishing) return;
            long now = SystemClock.elapsedRealtime();
            if (now - lastLevel < 50) return;
            lastLevel = now;
            // the recognizer reports roughly -2 dB in silence to 10 dB for loud speech
            double level = Math.max(0, Math.min(1, (rmsdB + 2) / 12.0));
            JSObject data = new JSObject();
            data.put("level", level);
            data.put("session", session);
            notifyListeners("level", data);
        }

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (stale()) return;
            String text = firstResult(partialResults);
            if (text == null || text.isEmpty()) return;
            current = text;
            emitTranscript(join(committed, current), true);
        }

        @Override
        public void onResults(Bundle results) {
            if (stale()) return;
            String text = firstResult(results);
            if (text != null && !text.isEmpty()) current = text;
            if (!current.isEmpty()) emitTranscript(join(committed, current), true);
            failures = 0;
            if (finishing) complete();
            else restart();
        }

        @Override
        public void onError(int error) {
            if (stale()) return;
            if (finishing) {
                complete();
                return;
            }
            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                end(1, "microphone-blocked");
            } else if (error == SpeechRecognizer.ERROR_AUDIO) {
                end(1, "microphone-failed");
            } else if (Build.VERSION.SDK_INT >= 31 && (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)) {
                end(2, "unsupported-locale");
            } else {
                // no match and speech timeout are the quiet spells between sentences; anything else gets a few retries
                restart();
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }
}
