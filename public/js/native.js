// Bridge to the native Android / iPhone layer (Capacitor "BetiNative" plugin).
// In a normal browser every call is a safe no-op, so the same screens run as
// the website, the Android app and the iPhone/iPad app.
const C = window.Capacitor;
export const isNative = !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
export const platform = isNative ? C.getPlatform() : 'web'; // 'android' | 'ios' | 'web'
const plugin = () => C?.Plugins?.BetiNative;

async function call(method, args = {}) {
  try { const p = plugin(); return p && p[method] ? await p[method](args) : null; } catch (e) { console.warn('[native]', method, e?.message || e); return null; }
}

export const native = {
  available: () => isNative && !!plugin(),
  // Secure storage (Android Keystore-backed / iOS Keychain) for the login token.
  async getToken() { return (await call('secureGet', { key: 'token' }))?.value || null; },
  async setToken(v) { return call('secureSet', { key: 'token', value: v || '' }); },
  // Gives the background service what it needs to work while the app is closed.
  configure(cfg) { return call('configure', cfg); },
  // Android: sends SOS SMS directly (no tap). iOS: opens the SMS composer.
  sendSos({ numbers, message, sms112 = false }) { return call('sendSos', { numbers, message, sms112 }); },
  // Background location + shake/power-button triggers: mode = armed | duty | assigned | sos
  startSafety(mode) { return call('startSafety', { mode }); },
  stopSafety() { return call('stopSafety'); },
  requestPermissions(which) { return call('requestPermissions', { which }); },
  permissionStatus() { return call('permissionStatus'); },
  getPushToken() { return platform === 'ios' ? iosPushToken() : call('getPushToken'); },
  // What opened the app: { action: 'sos', trigger: 'tile' | 'widget' | 'siri' | 'notification' | 'power' } or null
  takeLaunchAction() { return call('takeLaunchAction'); },
  openSystemSettings(which) { return call('openSystemSettings', { which }); },
  canUseFullScreenAlerts() { return call('canUseFullScreenAlerts'); },
};

// iPhone/iPad: the APNs device token comes from @capacitor/push-notifications.
async function iosPushToken() {
  const P = C?.Plugins?.PushNotifications;
  if (!P) return null;
  try {
    const perm = await P.requestPermissions();
    if (perm?.receive !== 'granted') return null;
    return await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 15000);
      P.addListener('registration', (r) => { clearTimeout(t); resolve({ token: r.value }); });
      P.addListener('registrationError', () => { clearTimeout(t); resolve(null); });
      P.addListener('pushNotificationActionPerformed', (a) => {
        const url = a?.notification?.data?.url;
        if (url && url.startsWith('#/')) location.hash = url;
      });
      P.register();
    });
  } catch { return null; }
}

// The server address is baked into the app at build time (www/config.js) and can
// be changed on the "Connect" screen (useful while testing on GitHub Codespaces).
export function serverUrl() {
  let v = null;
  try { v = localStorage.getItem('bb.server'); } catch {}
  return (v || window.BB_SERVER_URL || '').replace(/\/$/, '');
}
export function setServerUrl(u) { try { localStorage.setItem('bb.server', String(u || '').trim().replace(/\/$/, '')); } catch {} }
