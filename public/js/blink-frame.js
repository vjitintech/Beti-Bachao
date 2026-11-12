// Runs inside blink-frame.html (same origin, isolated). Reports to the app with postMessage.
import { blinkGuard } from './blink.js?v=mwdsq0ev';
const post = (msg) => parent.postMessage({ src: 'bb-blink', ...msg }, location.origin === 'null' ? '*' : location.origin);
let guard = null;
blinkGuard(document.getElementById('v'), {
  onStatus: (text) => post({ type: 'status', text }),
  onBlink: (n) => post({ type: 'blink', n }),
  onTrigger: () => post({ type: 'trigger' }),
}).then((g) => { guard = g; });
addEventListener('pagehide', () => guard?.stop());
addEventListener('message', (e) => { if (e.origin === location.origin && e.data === 'stop') guard?.stop(); });
