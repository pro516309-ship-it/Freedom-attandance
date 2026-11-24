package com.mbbs.attendance;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Log;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.tasks.Task;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends AppCompatActivity {

    private WebView mWebView;
    private ValueCallback<Uri[]> mFilePathCallback;
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final int RC_SIGN_IN = 9001;
    private GoogleSignInClient mGoogleSignInClient;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Dark theme status bar and navigation bar matching app background (#0A0E17)
        Window window = getWindow();
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(0xFF0A0E17);
        window.setNavigationBarColor(0xFF0A0E17);

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(false); // White icons on dark bar
            controller.setAppearanceLightNavigationBars(false);
        }

        mWebView = new WebView(this);
        setContentView(mWebView);

        WebSettings settings = mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // REQUIRED for localStorage (attendance data)
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        // Enable Chrome remote debugging on devices
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        // Hardware acceleration & dark background
        mWebView.setBackgroundColor(0xFF0A0E17);

        // Configure Google Sign-In options
        GoogleSignInOptions gso = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken("275609899846-cjg5maqj2b8418aobanigr09ebr8or2g.apps.googleusercontent.com")
                .requestEmail()
                .build();
        mGoogleSignInClient = GoogleSignIn.getClient(this, gso);

        // Native JavaScript Bridge for file export, backup, and sharing
        mWebView.addJavascriptInterface(new WebAppInterface(), "AndroidApp");

        // Handle internal navigation & errors
        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.e("MBBS_WEBVIEW", "WebView error: " + description + " (" + failingUrl + ")");
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri.getScheme() != null && uri.getScheme().equals("file")) {
                    return false;
                }
                // Open external links (if any) in browser
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(intent);
                } catch (Exception ignored) {}
                return true;
            }
        });

        // Handle File Chooser for Import JSON backup & log console messages
        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d("MBBS_WEBVIEW", consoleMessage.message() + " -- Line "
                        + consoleMessage.lineNumber() + " of "
                        + consoleMessage.sourceId());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (mFilePathCallback != null) {
                    mFilePathCallback.onReceiveValue(null);
                }
                mFilePathCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain", "*/*"});

                try {
                    startActivityForResult(Intent.createChooser(intent, "Select MBBS Backup JSON File"), FILE_CHOOSER_REQUEST_CODE);
                } catch (Exception e) {
                    mFilePathCallback = null;
                    Toast.makeText(MainActivity.this, "Cannot open file chooser", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        // Load the local HTML from assets
        mWebView.loadUrl("file:///android_asset/index.html");

        // Native back button handling: close modals or panels in webview if open, or minimize
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Check if any open panel or modal is present in webview
                mWebView.evaluateJavascript(
                    "(function() { " +
                    "  var openPanel = document.querySelector('.feature-panel.open'); " +
                    "  if (openPanel) { openPanel.classList.remove('open'); return 'panel'; } " +
                    "  var menu = document.getElementById('menu-overlay'); " +
                    "  if (menu && menu.classList.contains('open')) { menu.classList.remove('open'); return 'menu'; } " +
                    "  var openModal = document.querySelector('.modal-overlay:not(.hidden)'); " +
                    "  if (openModal) { openModal.classList.add('hidden'); return 'modal'; } " +
                    "  return 'none'; " +
                    "})()",
                    value -> {
                        if ("\"none\"".equals(value) || value == null) {
                            if (mWebView.canGoBack()) {
                                mWebView.goBack();
                            } else {
                                setEnabled(false);
                                getOnBackPressedDispatcher().onBackPressed();
                            }
                        }
                    }
                );
            }
        });
    }

    public class WebAppInterface {

        @JavascriptInterface
        public boolean saveBackupFile(String jsonContent, String fileName) {
            try {
                boolean saved = false;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                    values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                    ContentResolver resolver = getContentResolver();
                    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri != null) {
                        try (OutputStream os = resolver.openOutputStream(uri)) {
                            if (os != null) {
                                os.write(jsonContent.getBytes(StandardCharsets.UTF_8));
                                os.flush();
                                saved = true;
                            }
                        }
                    }
                } else {
                    File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!downloadsDir.exists()) downloadsDir.mkdirs();
                    File outFile = new File(downloadsDir, fileName);
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(jsonContent.getBytes(StandardCharsets.UTF_8));
                        fos.flush();
                        saved = true;
                    }
                }

                final boolean finalSaved = saved;
                runOnUiThread(() -> {
                    if (finalSaved) {
                        Toast.makeText(MainActivity.this, "✅ Backup saved to Downloads: " + fileName, Toast.LENGTH_LONG).show();
                    } else {
                        Toast.makeText(MainActivity.this, "❌ Could not save backup to Downloads", Toast.LENGTH_SHORT).show();
                    }
                });
                return saved;
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Save error: " + e.getMessage(), Toast.LENGTH_SHORT).show());
                return false;
            }
        }

        @JavascriptInterface
        public void shareBackupFile(String jsonContent, String fileName) {
            try {
                File cacheDir = new File(getCacheDir(), "backups");
                if (!cacheDir.exists()) cacheDir.mkdirs();
                File file = new File(cacheDir, fileName);
                try (FileOutputStream fos = new FileOutputStream(file)) {
                    fos.write(jsonContent.getBytes(StandardCharsets.UTF_8));
                    fos.flush();
                }

                Uri contentUri = FileProvider.getUriForFile(
                    MainActivity.this,
                    getPackageName() + ".fileprovider",
                    file
                );

                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType("application/json");
                shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(shareIntent, "Save or Share MBBS Backup");
                startActivity(chooser);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Share error: " + e.getMessage(), Toast.LENGTH_SHORT).show());
            }
        }

        @JavascriptInterface
        public void shareText(String title, String text) {
            try {
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType("text/plain");
                intent.putExtra(Intent.EXTRA_SUBJECT, title);
                intent.putExtra(Intent.EXTRA_TEXT, text);
                Intent chooser = Intent.createChooser(intent, title);
                startActivity(chooser);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Share error: " + e.getMessage(), Toast.LENGTH_SHORT).show());
            }
        }

        @JavascriptInterface
        public void copyToClipboard(String label, String text) {
            try {
                runOnUiThread(() -> {
                    android.content.ClipboardManager clipboard = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    android.content.ClipData clip = android.content.ClipData.newPlainText(label, text);
                    if (clipboard != null) {
                        clipboard.setPrimaryClip(clip);
                        Toast.makeText(MainActivity.this, "📋 Timetable code copied to clipboard!", Toast.LENGTH_SHORT).show();
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Copy error: " + e.getMessage(), Toast.LENGTH_SHORT).show());
            }
        }

        @JavascriptInterface
        public void signInWithGoogle() {
            runOnUiThread(() -> {
                try {
                    Intent signInIntent = mGoogleSignInClient.getSignInIntent();
                    startActivityForResult(signInIntent, RC_SIGN_IN);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Google Sign-In failed: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void signOutGoogle() {
            runOnUiThread(() -> {
                if (mGoogleSignInClient != null) {
                    mGoogleSignInClient.signOut().addOnCompleteListener(task -> {
                        Toast.makeText(MainActivity.this, "Signed out of Google account", Toast.LENGTH_SHORT).show();
                    });
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (mFilePathCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    String dataString = data.getDataString();
                    if (dataString != null) {
                        results = new Uri[]{Uri.parse(dataString)};
                    } else if (data.getClipData() != null) {
                        int numSelectedFiles = data.getClipData().getItemCount();
                        results = new Uri[numSelectedFiles];
                        for (int i = 0; i < numSelectedFiles; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    }
                }
                mFilePathCallback.onReceiveValue(results);
                mFilePathCallback = null;
            }
            return;
        }

        if (requestCode == RC_SIGN_IN) {
            Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(data);
            try {
                GoogleSignInAccount account = task.getResult(ApiException.class);
                if (account != null) {
                    String email = account.getEmail() != null ? account.getEmail() : "";
                    String displayName = account.getDisplayName() != null ? account.getDisplayName() : "";
                    String id = account.getId() != null ? account.getId() : "";

                    runOnUiThread(() -> {
                        String js = String.format("if (window.onGoogleSignInSuccess) { window.onGoogleSignInSuccess('%s', '%s', '%s'); }",
                                escapeJs(id), escapeJs(email), escapeJs(displayName));
                        mWebView.evaluateJavascript(js, null);
                    });
                }
            } catch (ApiException e) {
                Log.w("GOOGLE_SIGNIN", "signInResult:failed code=" + e.getStatusCode());
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, "Sign in cancelled or failed (code " + e.getStatusCode() + ")", Toast.LENGTH_SHORT).show();
                    String js = String.format("if (window.onGoogleSignInFailed) { window.onGoogleSignInFailed('%s'); }", escapeJs("Error code " + e.getStatusCode()));
                    mWebView.evaluateJavascript(js, null);
                });
            }
            return;
        }

        super.onActivityResult(requestCode, resultCode, data);
    }

    private String escapeJs(String text) {
        if (text == null) return "";
        return text.replace("\\", "\\\\").replace("'", "\\'").replace("\"", "\\\"").replace("\n", "").replace("\r", "");
    }
}
