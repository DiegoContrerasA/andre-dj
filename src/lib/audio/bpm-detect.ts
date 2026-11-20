// Detección automática de BPM.
// Decodifica ~2.5 MB del medio del archivo (≈2.5 min de MP3; no se carga el mix completo en memoria),
// saca la envolvente de golpes de graves (bombo) y busca la periodicidad con autocorrelación.

const MP3_BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const MP3_SR: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
// Largo en bytes del frame MPEG Layer III que empieza en i, o 0 si no es una cabecera válida
const mp3FrameLen = (u: Uint8Array, i: number) => {
  if (i + 4 > u.length || u[i] !== 0xff || (u[i + 1] & 0xe0) !== 0xe0) return 0;
  const ver = (u[i + 1] >> 3) & 3, layer = (u[i + 1] >> 1) & 3;
  const bri = (u[i + 2] >> 4) & 15, sri = (u[i + 2] >> 2) & 3, pad = (u[i + 2] >> 1) & 1;
  if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return 0;
  const br = MP3_BR[ver === 3 ? 1 : 2][bri] * 1000, sr = MP3_SR[ver][sri];
  return Math.floor(((ver === 3 ? 144 : 72) * br) / sr) + pad;
};
// Primer offset con 3 frames seguidos válidos (evita falsos positivos dentro de los datos)
const findMp3Sync = (u: Uint8Array, from = 0) => {
  for (let i = from; i < u.length - 4; i++) {
    const l1 = mp3FrameLen(u, i); if (!l1) continue;
    const l2 = mp3FrameLen(u, i + l1); if (!l2) continue;
    if (mp3FrameLen(u, i + l1 + l2)) return i;
  }
  return -1;
};
// ¿Es MP3? Se mira el contenido, no el nombre/tipo (en móvil a veces llegan vacíos o como video/mpeg)
async function sniffMp3(blob: Blob) {
  const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true; // etiqueta ID3
  return findMp3Sync(head) >= 0;
}
const decode = (bytes: ArrayBuffer) => new Promise<AudioBuffer>((res, rej) => {
  const Ctx = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  if (!Ctx) return rej(new Error('Web Audio no disponible'));
  // 22050 Hz: la mitad de memoria que 44.1 kHz y de sobra para detectar el bombo
  const p = new Ctx(1, 1, 22050).decodeAudioData(bytes, res, rej);
  (p as any)?.catch?.(rej);
});

export async function detectBpm(blob: Blob): Promise<number | null> {
  // Se decodifican como mucho ~2.5 MB (≈2.5 min de MP3): cabe en la memoria de cualquier celular
  const CHUNK = 2_500_000;
  let audioBuf: AudioBuffer | null = null;
  let lastErr: unknown = null;
  if (await sniffMp3(blob)) {
    // Intentos: un pedazo del medio (el ritmo suele estar asentado) y, si falla, el inicio del archivo
    const starts = blob.size > CHUNK * 1.5 ? [Math.floor(blob.size * 0.4), 0] : [0];
    for (const start of starts) {
      try {
        const raw = new Uint8Array(await blob.slice(start, start + CHUNK).arrayBuffer());
        const sync = start === 0 ? 0 : findMp3Sync(raw);
        if (sync < 0) throw new Error('No se encontró audio MP3 en el pedazo');
        audioBuf = await decode(raw.slice(sync).buffer);
        break;
      } catch (e) { lastErr = e; }
    }
  } else if (blob.size <= 40_000_000) {
    // M4A/WAV/FLAC/OGG necesitan el archivo completo (cabeceras); hasta 40 MB para no agotar la memoria del celular
    try { audioBuf = await decode(await blob.arrayBuffer()); } catch (e) { lastErr = e; }
  } else {
    throw new Error('Archivo muy grande para analizar en este formato');
  }
  if (!audioBuf) throw lastErr ?? new Error('No se pudo leer el audio');
  const sr = audioBuf.sampleRate;
  // Analizar como máximo 120 s (desde el 40% si el audio es más largo)
  const maxLen = Math.floor(sr * 120);
  const off = audioBuf.length > maxLen ? Math.floor(audioBuf.length * 0.4) : 0;
  const len = Math.min(maxLen, audioBuf.length - off);
  const ch0 = audioBuf.getChannelData(0).subarray(off, off + len);
  const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1).subarray(off, off + len) : ch0;
  const hop = sr >= 44100 ? 512 : 256, fps = sr / hop; // ~86 cuadros/s sea cual sea la frecuencia
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sr); // pasa-bajos ~150 Hz
  let lp = 0;
  const nFrames = Math.floor(ch0.length / hop);
  const low = new Float32Array(nFrames), full = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let el = 0, ef = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) {
      const x = (ch0[i] + ch1[i]) * 0.5;
      lp += a * (x - lp);
      el += lp * lp; ef += x * x;
    }
    low[f] = Math.log1p(el * 1000); full[f] = Math.log1p(ef * 100);
  }
  // Flujo de energía (solo subidas) = probabilidad de golpe
  const onset = new Float32Array(nFrames);
  let mean = 0;
  for (let f = 1; f < nFrames; f++) { onset[f] = Math.max(0, low[f] - low[f - 1]) + 0.5 * Math.max(0, full[f] - full[f - 1]); mean += onset[f]; }
  mean /= nFrames;
  for (let f = 0; f < nFrames; f++) onset[f] = Math.max(0, onset[f] - mean);
  // Autocorrelación entre 60 y 200 BPM con preferencia suave alrededor de 120
  const ac = (lag: number) => { let sum = 0; for (let i = lag; i < nFrames; i++) sum += onset[i] * onset[i - lag]; return sum / (nFrames - lag); };
  const minLag = Math.floor((60 * fps) / 200), maxLag = Math.ceil((60 * fps) / 60);
  const acs: number[] = [];
  if (2 * maxLag + 1 >= nFrames) return null; // muy poco audio
  for (let l = 0; l <= 2 * maxLag + 1; l++) acs[l] = l >= minLag - 1 ? ac(l) : 0; // incluye 2·lag para el armónico
  let best = -1, bestScore = -Infinity;
  for (let l = minLag; l <= maxLag; l++) {
    const bpm = (60 * fps) / l;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = (acs[l] + 0.5 * acs[2 * l]) * w;
    if (score > bestScore) { bestScore = score; best = l; }
  }
  if (best < 0 || bestScore <= 0) return null;
  // Interpolación parabólica para precisión decimal
  const y0 = acs[best - 1], y1 = acs[best], y2 = acs[best + 1];
  const den = y0 - 2 * y1 + y2;
  const lag = best + (den ? (0.5 * (y0 - y2)) / den : 0);
  return Math.round(((60 * fps) / lag) * 10) / 10;
}
