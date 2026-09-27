import { describe, expect, it } from 'vitest';
import { formatMeetingDuration, Pcm16Chunker } from './meeting-audio';

describe('meeting audio helpers', () => {
  it('resamples microphone data into 40 ms 16kHz PCM chunks', () => {
    const chunker = new Pcm16Chunker();
    const input = new Float32Array(1_921).fill(0.5);
    const chunks = chunker.push(input, 48_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1_280);
    expect(new DataView(chunks[0]!.buffer).getInt16(0, true)).toBeCloseTo(16_384, -1);
  });

  it('retains partial audio until flush', () => {
    const chunker = new Pcm16Chunker();
    expect(chunker.push(new Float32Array(321), 16_000)).toEqual([]);
    expect(chunker.flush()).toHaveLength(640);
    expect(chunker.flush()).toBeNull();
  });

  it('formats short and long meeting durations', () => {
    expect(formatMeetingDuration(65)).toBe('01:05');
    expect(formatMeetingDuration(3_661)).toBe('01:01:01');
  });
});
