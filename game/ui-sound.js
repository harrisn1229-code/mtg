/* Tiny WebAudio synth: every effect is generated, there are no audio files.
   The context is only created after a user gesture (unlock), and stays silent when muted. */

export function createSound(getSettings) {
  let ctx = null, master = null;
  const S = () => getSettings() || {};

  function ensure() {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }
  function unlock() {
    const c = ensure();
    if (c && c.state === "suspended") c.resume().catch(() => {});
  }
  function tone(freq, dur, o) {
    o = o || {};
    const t0 = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + dur);
    const v = o.vol == null ? 0.25 : o.vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + Math.min(0.015, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }
  function noise(dur, o) {
    o = o || {};
    const t0 = ctx.currentTime + (o.delay || 0);
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = o.filter || "lowpass";
    f.frequency.setValueAtTime(o.freq || 1200, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.to), t0 + dur);
    const g = ctx.createGain();
    const v = o.vol == null ? 0.3 : o.vol;
    g.gain.setValueAtTime(v, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  const FX = {
    play() { noise(0.09, { freq: 900, to: 300, vol: 0.35 }); tone(180, 0.12, { type: "triangle", to: 90, vol: 0.28 }); },
    land() { noise(0.07, { freq: 500, to: 200, vol: 0.3 }); tone(120, 0.1, { type: "sine", to: 70, vol: 0.3 }); },
    draw() { noise(0.12, { filter: "bandpass", freq: 1800, to: 3600, vol: 0.18 }); },
    cast() { tone(440, 0.18, { type: "sine", to: 880, vol: 0.14 }); tone(660, 0.22, { type: "triangle", to: 1320, vol: 0.08, delay: 0.04 }); },
    resolve() { tone(520, 0.1, { type: "triangle", vol: 0.14 }); tone(780, 0.14, { type: "triangle", vol: 0.1, delay: 0.07 }); },
    attack() { tone(110, 0.28, { type: "sawtooth", to: 55, vol: 0.2 }); noise(0.2, { freq: 400, to: 120, vol: 0.2 }); },
    damage() { noise(0.16, { freq: 1500, to: 200, vol: 0.4 }); tone(90, 0.16, { type: "square", to: 45, vol: 0.2 }); },
    lifeloss() { tone(330, 0.22, { type: "triangle", to: 160, vol: 0.2 }); },
    lifegain() { tone(523, 0.12, { type: "sine", vol: 0.14 }); tone(784, 0.2, { type: "sine", vol: 0.12, delay: 0.09 }); },
    die() { noise(0.35, { freq: 2200, to: 150, vol: 0.28 }); tone(160, 0.3, { type: "sawtooth", to: 40, vol: 0.12 }); },
    turn() { tone(392, 0.18, { type: "sine", vol: 0.18 }); tone(587, 0.35, { type: "sine", vol: 0.16, delay: 0.14 }); },
    tap() { tone(900, 0.04, { type: "square", vol: 0.05 }); },
    click() { tone(640, 0.05, { type: "triangle", vol: 0.1 }); },
    error() { tone(150, 0.16, { type: "square", vol: 0.12 }); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.4, { type: "triangle", vol: 0.2, delay: i * 0.13 })); },
    lose() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.5, { type: "sine", vol: 0.2, delay: i * 0.18 })); },
    emote() { tone(700, 0.08, { type: "sine", vol: 0.1 }); tone(900, 0.1, { type: "sine", vol: 0.08, delay: 0.08 }); },
  };

  function play(name) {
    const s = S();
    if (s.sound === false) return;
    if (!ctx || ctx.state === "suspended") return;
    if (master) master.gain.value = Math.max(0, Math.min(1, s.volume == null ? 0.6 : s.volume));
    const fx = FX[name];
    if (fx) { try { fx(); } catch (e) { /* audio is best-effort */ } }
  }
  function buzz(ms) {
    const s = S();
    if (s.haptics === false) return;
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ }
  }
  return { unlock, play, buzz };
}
