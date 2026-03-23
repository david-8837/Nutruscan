let audioCtx = null;
let lastPlay = 0;

const PRESETS = {
  success: { freq: 880, type: "sine", duration: 0.12, gain: 0.035 },
  water: { freq: 640, type: "sine", duration: 0.08, gain: 0.03 },
  scan: { freq: 980, type: "triangle", duration: 0.07, gain: 0.035 },
  achievement: { freq: 1040, type: "triangle", duration: 0.16, gain: 0.04 },
};

const MIN_GAP_MS = 250;

function getCtx() {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

export async function playSfx(name = "success", enabled = true) {
  if (!enabled) return;
  const nowMs = Date.now();
  if (nowMs - lastPlay < MIN_GAP_MS) return;

  const cfg = PRESETS[name] || PRESETS.success;
  const ctx = getCtx();
  if (!ctx) return;

  try {
    if (ctx.state === "suspended") await ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = cfg.type;
    osc.frequency.setValueAtTime(cfg.freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(cfg.gain, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + cfg.duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + cfg.duration + 0.02);
    lastPlay = nowMs;
  } catch {
    // no-op on unsupported/blocked audio contexts
  }
}
