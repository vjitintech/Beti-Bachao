// Blink SOS: three slow, deliberate blinks at the front camera start the SOS countdown.
// Runs fully on the phone with Google's MediaPipe Face Mesh (vendored, Apache-2.0);
// no image ever leaves the device.
//
// Eye openness = "eye aspect ratio" (EAR) from the eyelid landmarks. A blink only
// counts when the eyes stay closed long enough to be deliberate (natural blinks
// last ~100–150 ms), so normal blinking does not trigger it.
const LEFT = [33, 160, 158, 133, 153, 144];
const RIGHT = [362, 385, 387, 263, 373, 380];
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function eyeAspectRatio(lm, idx) {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
  return (d(p2, p6) + d(p3, p5)) / (2 * d(p1, p4) || 1);
}

// Pure detector — fed (EAR, time ms); returns 'blink' | 'trigger' | null. Unit-tested.
export function createBlinkDetector({ needed = 3, windowMs = 6000, minClosedMs = 200, maxClosedMs = 2000, closeRatio = 0.62, openRatio = 0.8, cooldownMs = 8000 } = {}) {
  let baseline = null, closedAt = null, blinks = [], lastTrigger = -Infinity;
  return {
    get baseline() { return baseline; },
    feed(ear, t) {
      if (!Number.isFinite(ear)) { closedAt = null; return null; }
      // Track the open-eye level slowly (only while not closed).
      if (closedAt == null) baseline = baseline == null ? ear : baseline * 0.97 + Math.max(ear, baseline * 0.9) * 0.03;
      if (baseline == null || baseline < 0.12) return null;
      if (closedAt == null && ear < baseline * closeRatio) { closedAt = t; return null; }
      if (closedAt != null && ear > baseline * openRatio) {
        const dur = t - closedAt; closedAt = null;
        if (dur < minClosedMs || dur > maxClosedMs || t - lastTrigger < cooldownMs) return null;
        blinks = [...blinks.filter((x) => t - x <= windowMs), t];
        if (blinks.length >= needed) { blinks = []; lastTrigger = t; return 'trigger'; }
        return 'blink';
      }
      return null;
    },
    get count() { return blinks.length; },
  };
}

let loading = null;
function loadFaceMesh() {
  if (window.FaceMesh) return Promise.resolve();
  loading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/mediapipe-face-mesh/face_mesh.js';
    s.onload = res; s.onerror = () => rej(new Error('Could not load the face model'));
    document.head.appendChild(s);
  });
  return loading;
}

export async function blinkGuard(video, { onStatus = () => {}, onBlink = () => {}, onTrigger = () => {} } = {}) {
  let stopped = false, stream = null, raf = 0, busy = false;
  const det = createBlinkDetector();
  const stop = () => { stopped = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); try { mesh?.close(); } catch {} };
  let mesh = null;
  try {
    if (typeof WebAssembly !== 'object' || !WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]))) throw new Error('This phone browser is too old for Blink SOS. Use shake, voice or the SOS button.');
    onStatus('Loading the face model (first time only)…');
    await loadFaceMesh();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } }, audio: false });
    if (stopped) { stop(); return { stop }; }
    video.srcObject = stream; await video.play();
    mesh = new window.FaceMesh({ locateFile: (f) => `vendor/mediapipe-face-mesh/${f}` });
    mesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    let lastFace = 0;
    mesh.onResults((r) => {
      const lm = r.multiFaceLandmarks?.[0];
      const now = performance.now();
      if (!lm) { if (now - lastFace > 1500) onStatus('Looking for your face… hold the phone in front of you'); det.feed(NaN, now); return; }
      lastFace = now;
      const ear = (eyeAspectRatio(lm, LEFT) + eyeAspectRatio(lm, RIGHT)) / 2;
      const ev = det.feed(ear, now);
      if (ev === 'blink') { onBlink(det.count); onStatus(`Blink ${det.count} of 3 seen`); }
      else if (ev === 'trigger') { onStatus('3 blinks — starting SOS'); onTrigger(); }
      else if (det.count === 0) onStatus('Ready ✓ Blink slowly 3 times to send SOS');
    });
    await mesh.initialize();
    const loop = async () => {
      if (stopped) return;
      if (!busy && video.readyState >= 2) { busy = true; try { await mesh.send({ image: video }); } catch {} busy = false; }
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    onStatus(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow the camera for Beti Bachao to use Blink SOS.' : (e.message || 'Blink SOS is not available on this phone.'));
    stop();
  }
  return { stop };
}
