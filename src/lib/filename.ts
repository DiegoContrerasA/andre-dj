// Saca título, artista y BPM del nombre del archivo ("Artista - Título [128].mp3")
const JUNK = /\b(forhub|klickaud|soundcloud|to\s*mp3|mp3\s*download|y2mate|savefrom|ytmp3|official\s*(video|audio)|lyrics?|hq|320\s*kbps)\b|\((official[^)]*|audio|video|lyric[^)]*)\)/gi;

export const tidy = (t: string) =>
  (t || '').replace(/_/g, ' ').replace(JUNK, ' ').replace(/\s*-\s*$/, '').replace(/\s+/g, ' ').trim();

export const parseName = (file: string) => {
  const base = tidy(file.replace(/(\.[a-z0-9]{2,4})+$/i, ''));
  const m = base.match(/\[(\d{2,3}(?:\.\d+)?)\]|(\d{2,3}(?:\.\d+)?)\s*bpm/i);
  const clean = base.replace(/\[\d+(?:\.\d+)?\]|\d+(?:\.\d+)?\s*bpm/gi, '').replace(/\s+/g, ' ').trim();
  const sep = clean.indexOf(' - ');
  const [artist, title] = sep > 0 ? [clean.slice(0, sep), clean.slice(sep + 3)] : ['', clean];
  return { title, artist, bpm: m ? Number(m[1] ?? m[2]) : null };
};
