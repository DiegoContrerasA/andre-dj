// Tipos mínimos de signalsmith-stretch (el paquete no trae .d.ts)
declare module 'signalsmith-stretch' {
  export type StretchSchedule = {
    output?: number; active?: boolean; input?: number; rate?: number; semitones?: number;
    tonalityHz?: number; loopStart?: number; loopEnd?: number;
  };
  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    schedule(s: StretchSchedule): void;
    start(when?: number): void;
    stop(when?: number): void;
    addBuffers(channels: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    latency(): number;
    configure(c: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): void;
    setUpdateInterval(seconds: number, cb?: (t: number) => void): void;
  }
  export default function SignalsmithStretch(ctx: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
}
