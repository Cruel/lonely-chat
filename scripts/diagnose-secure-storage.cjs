// Inspect Electron's Linux secret-store selection without reading or writing credentials.
// Usage: pnpm exec electron scripts/diagnose-secure-storage.cjs [--password-store=gnome-libsecret]
const { app, safeStorage } = require('electron');

app
  .whenReady()
  .then(() => {
    const backend =
      process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'system';
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    console.log(
      JSON.stringify({
        platform: process.platform,
        backend,
        encryptionAvailable,
        protectedStorage: encryptionAvailable && backend !== 'basic_text',
      }),
    );
    app.quit();
  })
  .catch((error) => {
    console.error('Secure storage diagnostic failed:', error.message);
    app.exit(1);
  });
