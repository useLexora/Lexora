package app.uselexora.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.provider.MediaStore;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.UUID;

public final class FileReceiverActivity extends Activity {
    private final JSONObject report = new JSONObject();
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = getIntent();
        boolean camera = MediaStore.ACTION_IMAGE_CAPTURE.equals(intent.getAction());
        Uri uri = intent.getParcelableExtra(camera ? MediaStore.EXTRA_OUTPUT : Intent.EXTRA_STREAM);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(40, 100, 40, 40);
        TextView label = new TextView(this);
        label.setText(camera ? "Capture receiver ready" : "Share receiver ready");
        content.addView(label);
        try {
            report.put("instanceId", UUID.randomUUID().toString()).put("action", intent.getAction()).put("uid", Process.myUid()).put("uri", uri).put("flags", intent.getFlags());
            report.put("clipMatches", intent.getClipData() != null && uri.equals(intent.getClipData().getItemAt(0).getUri()));
            String other = getSharedPreferences("receiver", 0).getString("otherUri", null);
            if (other != null) {
                try (InputStream input = getContentResolver().openInputStream(Uri.parse(other))) { report.put("otherReadable", input != null); }
                catch (SecurityException error) { report.put("otherReadable", false); }
            }
            if (!camera) {
                try (InputStream input = getContentResolver().openInputStream(uri)) { report.put("sha256", digest(input)); }
                try (OutputStream output = getContentResolver().openOutputStream(uri, "w")) { report.put("writable", output != null); }
                catch (SecurityException error) { report.put("writable", false); }
            }
        } catch (Exception error) { try { report.put("error", error.toString()); } catch (Exception ignored) { } }
        saveReport();
        if (camera) {
            Button capture = new Button(this);
            capture.setAllCaps(false);
            capture.setText("Return captured photo");
            capture.setOnClickListener(view -> {
                try {
                    Bitmap bitmap = Bitmap.createBitmap(24, 16, Bitmap.Config.ARGB_8888);
                    bitmap.eraseColor(0xff28705a);
                    try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 95, output)) throw new IllegalStateException("JPEG encode failed");
                    } finally { bitmap.recycle(); }
                    try (InputStream input = getContentResolver().openInputStream(uri)) { report.put("sha256", digest(input)); }
                    saveReport();
                    setResult(RESULT_OK);
                } catch (Exception error) { try { report.put("error", error.toString()); saveReport(); } catch (Exception ignored) { } }
                finish();
            });
            content.addView(capture);
        }
        Button close = new Button(this);
        close.setAllCaps(false);
        close.setText(camera ? "Cancel capture" : "Close receiver");
        close.setOnClickListener(view -> finish());
        content.addView(close);
        setContentView(content);
    }
    private void saveReport() { getSharedPreferences("receiver", 0).edit().putString("report", report.toString()).commit(); }
    private String digest(InputStream input) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[4096];
        for (int count; (count = input.read(buffer)) != -1;) digest.update(buffer, 0, count);
        StringBuilder value = new StringBuilder();
        for (byte b : digest.digest()) value.append(String.format("%02x", b & 0xff));
        return value.toString();
    }
}
