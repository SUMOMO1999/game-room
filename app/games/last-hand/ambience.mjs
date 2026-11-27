// Quiet, locally synthesized arena sounds. A gesture unlocks the graph on mobile Safari.
const voices = {
  canyon: { cut: 520, noise: 0.27, tone: 98 },
  ruins: { cut: 1390, noise: 0.12, tone: 196 },
  forge: { cut: 320, noise: 0.32, tone: 55 },
};
export function arenaAmbience(preferences) {
  let context,
    gain,
    filter,
    wind,
    drone,
    chimes,
    theme = 'canyon',
    active = false;
  function sync(next = theme, playing = active) {
    theme = next;
    active = playing;
    if (!context) return;
    const sound = voices[theme] || voices.canyon,
      now = context.currentTime,
      p = preferences();
    gain.gain.setTargetAtTime(active && !document.hidden && !p.muted ? p.volume * 0.13 : 0, now, 0.18);
    filter.frequency.setTargetAtTime(sound.cut, now, 0.45);
    drone.frequency.setTargetAtTime(sound.tone, now, 0.45);
    wind.gain.setTargetAtTime(sound.noise, now, 0.45);
  }
  function wake() {
    const Ac = window.AudioContext || window.webkitAudioContext;
    if (!Ac) return;
    if (context) {
      if (context.state === 'suspended') context.resume().catch(() => {});
      return;
    }
    context = new Ac();
    gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);
    const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate),
      data = buffer.getChannelData(0);
    let sample = 0;
    for (let i = 0; i < data.length; i++) {
      sample = (sample + Math.random() * 0.06 - 0.03) / 1.012;
      data[i] = sample;
    }
    const noise = context.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    wind = context.createGain();
    noise.connect(filter).connect(wind).connect(gain);
    noise.start();
    drone = context.createOscillator();
    drone.type = 'sine';
    const warmth = context.createGain();
    warmth.gain.value = 0.1;
    drone.connect(warmth).connect(gain);
    drone.start();
    let note = 0;
    chimes = setInterval(() => {
      if (!active || document.hidden || preferences().muted || context.state !== 'running') return;
      const sequence =
        theme === 'ruins'
          ? [523.25, 783.99, 659.25, 392]
          : theme === 'forge'
            ? [146.83, 110, 164.81]
            : [293.66, 196, 220];
      const t = context.currentTime,
        ch = context.createOscillator(),
        envelope = context.createGain();
      ch.type = theme === 'forge' ? 'triangle' : 'sine';
      ch.frequency.value = sequence[note++ % sequence.length];
      envelope.gain.setValueAtTime(0.001, t);
      envelope.gain.exponentialRampToValueAtTime(theme === 'ruins' ? 0.14 : 0.075, t + 0.04);
      envelope.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      ch.connect(envelope).connect(gain);
      ch.onended = () => {
        ch.disconnect();
        envelope.disconnect();
      };
      ch.start(t);
      ch.stop(t + 1.12);
    }, 4500);
    sync();
  }
  return {
    wake,
    sync,
    close() {
      clearInterval(chimes);
      context?.close().catch(() => {});
      context = null;
    },
  };
}
