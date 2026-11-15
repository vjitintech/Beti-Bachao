package app.betibachao.safety;

/**
 * Turns raw button presses into an SOS decision: two presses within 1.5 s = SOS.
 * A single press (bumped in a bag) does nothing. After an SOS, presses are ignored
 * for 10 s so one panicked burst of presses starts only one SOS countdown.
 * Pure Java (no Android classes) so it can be unit-tested on any machine.
 */
public final class PressDetector {
    public static final long DOUBLE_WINDOW_MS = 1500;
    public static final long COOLDOWN_MS = 10_000;
    public static final long DEBOUNCE_MS = 120; // one physical press can arrive as two notifications

    private long lastPress = -1;
    private long lastFire = -COOLDOWN_MS - 1;

    /** @return true when this press completes a double-press (fire SOS). */
    public synchronized boolean press(long now) {
        if (now - lastFire < COOLDOWN_MS) return false;
        if (lastPress >= 0 && now - lastPress < DEBOUNCE_MS) return false;
        if (lastPress >= 0 && now - lastPress <= DOUBLE_WINDOW_MS) {
            lastPress = -1;
            lastFire = now;
            return true;
        }
        lastPress = now;
        return false;
    }

    public synchronized void reset() { lastPress = -1; lastFire = -COOLDOWN_MS - 1; }
}
