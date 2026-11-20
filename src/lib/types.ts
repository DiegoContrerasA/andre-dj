export type DeckId = 'a' | 'b';
export type Song = { id: DeckId; title: string; artist: string; bpm: number | null; blob: Blob; name?: string };
