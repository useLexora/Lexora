package app.uselexora.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public final class FileWorkflowProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "unknown".equals(uri.getLastPathSegment()) ? "application/octet-stream" : "text/plain"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        if ("denied-query".equals(uri.getLastPathSegment())) throw new SecurityException("Synthetic revoked metadata permission");
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{"fixture.txt", 12});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if ("denied".equals(name)) throw new SecurityException("Synthetic revoked content permission");
        if ("missing".equals(name)) throw new FileNotFoundException("Synthetic unavailable URI");
        if ("full".equals(name)) throw new FileNotFoundException("ENOSPC: synthetic document provider quota exhausted");
        if ("oversize".equals(name)) {
            File file = new File(getContext().getCacheDir(), "oversize.txt");
            try (java.io.RandomAccessFile output = new java.io.RandomAccessFile(file, "rw")) { output.setLength(1048577); }
            catch (IOException error) { throw new IllegalStateException(error); }
            return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
        }
        if (!"output".equals(name) && !"source".equals(name)) throw new FileNotFoundException("Unknown fixture");
        File file = new File(getContext().getCacheDir(), "file-workflow-" + name + ".txt");
        if ("source".equals(name)) write(file, "原附件😀");
        int flags = "r".equals(mode) ? ParcelFileDescriptor.MODE_READ_ONLY : ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_CREATE | (mode.contains("t") ? ParcelFileDescriptor.MODE_TRUNCATE : 0);
        return ParcelFileDescriptor.open(file, flags);
    }
    @Override public Bundle call(String method, String arg, Bundle extras) {
        if ("receiver-reset".equals(method)) {
            getContext().getSharedPreferences("receiver", 0).edit().clear().putString("otherUri", arg).commit();
            return new Bundle();
        }
        if ("receiver-report".equals(method)) {
            Bundle result = new Bundle();
            result.putString("report", getContext().getSharedPreferences("receiver", 0).getString("report", "{}"));
            return result;
        }
        if ("receiver-probe".equals(method)) {
            Bundle result = new Bundle();
            try (java.io.InputStream input = getContext().getContentResolver().openInputStream(Uri.parse(arg))) {
                result.putBoolean("readable", input != null);
            } catch (Exception error) { result.putBoolean("readable", false); }
            return result;
        }
        if (!"reset".equals(method)) throw new IllegalArgumentException("Unknown fixture command");
        StringBuilder value = new StringBuilder();
        for (int i = 0; i < 100; i++) value.append("old content must be truncated");
        write(new File(getContext().getCacheDir(), "file-workflow-output.txt"), value.toString());
        return new Bundle();
    }
    private void write(File file, String value) {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(value.getBytes(StandardCharsets.UTF_8)); }
        catch (IOException error) { throw new IllegalStateException(error); }
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
}
