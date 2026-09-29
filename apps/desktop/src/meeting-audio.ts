const TARGET_SAMPLE_RATE = 16_000;
const CHUNK_DURATION_MS = 40;

export class Pcm16Chunker {
  private readonly samplesPerChunk = TARGET_SAMPLE_RATE * CHUNK_DURATION_MS / 1_000;
  private pending: number[] = [];
  private previousSample: number | null = null;
  private sourcePosition = 0;

  push(input: Float32Array, sourceSampleRate: number): Uint8Array<ArrayBuffer>[] {
    if (input.length === 0 || sourceSampleRate < TARGET_SAMPLE_RATE) return [];
    const source = this.previousSample === null
      ? input
      : Float32Array.from([this.previousSample, ...input]);
    const sourceSpan = source.length - 1;
    const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
    while (this.sourcePosition < sourceSpan) {
      const index = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - index;
      const sample = source[index]! + (source[index + 1]! - source[index]!) * fraction;
      this.pending.push(Math.max(-1, Math.min(1, sample)));
      this.sourcePosition += ratio;
    }
    this.sourcePosition -= sourceSpan;
    this.previousSample = source[source.length - 1]!;
    return this.takeCompleteChunks();
  }

  flush(): Uint8Array<ArrayBuffer> | null {
    if (this.pending.length === 0) return null;
    const chunk = this.encode(this.pending);
    this.pending = [];
    return chunk;
  }

  private takeCompleteChunks(): Uint8Array<ArrayBuffer>[] {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    while (this.pending.length >= this.samplesPerChunk) {
      chunks.push(this.encode(this.pending.splice(0, this.samplesPerChunk)));
    }
    return chunks;
  }

  private encode(samples: number[]): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((sample, index) => {
      const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(index * 2, Math.round(value), true);
    });
    return bytes;
  }
}

export function formatMeetingDuration(totalSeconds = 0): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const seconds = safeSeconds % 60;
  return hours > 0
    ? [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
    : [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}
