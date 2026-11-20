// Índice de frames de un MP3: byte exacto de cada instante (CBR o VBR) sin decodificar nada.
// Permite decodificar cualquier tramo de un mix largo sin cargar el archivo entero.
import { MP3_SR, findMp3Sync, mp3FrameLen } from './bpm-detect';

export type Mp3Index = { offsets: Uint32Array; count: number; sr: number; spf: number; end: number };

const id3Size = (u: Uint8Array) =>
  u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33 ? 10 + ((u[6] << 21) | (u[7] << 14) | (u[8] << 7) | u[9]) + (u[5] & 0x10 ? 10 : 0) : 0;

/** null si no es MP3 */
export async function indexMp3(blob: Blob): Promise<Mp3Index | null> {
  const start = id3Size(new Uint8Array(await blob.slice(0, 10).arrayBuffer()));
  const probe = new Uint8Array(await blob.slice(start, start + 256 * 1024).arrayBuffer());
  const sync = findMp3Sync(probe);
  if (sync < 0) return null;
  const h = start + sync;
  const ver = (probe[sync + 1] >> 3) & 3, sri = (probe[sync + 2] >> 2) & 3;
  const sr = MP3_SR[ver][sri], spf = ver === 3 ? 1152 : 576;

  let offsets = new Uint32Array(Math.ceil(blob.size / 300) + 16); // ~300 bytes/frame a 128 kbps: casi nunca crece
  let count = 0, pos = h, end = blob.size;
  const SLICE = 4 << 20;
  let bufStart = -1, buf = new Uint8Array(0);
  while (pos + 4 <= blob.size) {
    if (pos + 4 > bufStart + buf.length || pos < bufStart) {
      bufStart = pos;
      buf = new Uint8Array(await blob.slice(pos, pos + SLICE).arrayBuffer());
    }
    const len = mp3FrameLen(buf, pos - bufStart);
    if (len) {
      if (count === offsets.length) { const o = new Uint32Array(count * 2); o.set(offsets); offsets = o; }
      offsets[count++] = pos;
      pos += len;
      continue;
    }
    // Basura o etiqueta al final (ID3v1 "TAG", APE…): buscar el siguiente frame válido
    const next = findMp3Sync(buf, pos - bufStart + 1);
    if (next < 0) {
      if (bufStart + buf.length >= blob.size) { end = pos; break; }
      pos = bufStart + Math.max(1, buf.length - 8); // seguir buscando en el siguiente pedazo
      bufStart = -1;
      continue;
    }
    pos = bufStart + next;
  }
  if (count < 2) return null;
  return { offsets: offsets.subarray(0, count), count, sr, spf, end: Math.min(end, blob.size) };
}
