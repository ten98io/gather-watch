/**
 * FfmpegRunner argument construction via the exec seam — no ffmpeg binary
 * runs. Covers the silent-video branch (no 0:a:0 mapping), the normal
 * audio+video ladder, sub-720p single-rendition sources, and thumbnail seek
 * clamping for sub-second clips.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FfmpegRunner } from '../src/pipeline/ffmpeg';
import type { ProbeResult } from '../src/pipeline/ports';

interface Call {
  bin: string;
  args: string[];
}

function makeRunner(): { runner: FfmpegRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner = new FfmpegRunner(
    { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
    async (bin, args) => {
      calls.push({ bin, args: [...args] });
      return '';
    },
  );
  return { runner, calls };
}

function probeOf(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    durationMs: 60_000,
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

describe('FfmpegRunner arg construction', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'ffmpeg-args-'));
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  const job = (dir: string) => ({ assetId: 'a1', inputPath: '/in/source', outputDir: dir });

  it('1080p source with audio: two video variants + audio-only rendition', async () => {
    const { runner, calls } = makeRunner();
    await runner.transcode(job(outputDir), probeOf({}));
    const ladder = calls[0];
    expect(ladder?.bin).toBe('ffmpeg');
    const args = ladder?.args ?? [];
    // Both ladder heights present, audio mapped once per variant (2 video + 1 audio-only).
    expect(args.join(' ')).toContain('scale=w=-2:h=1080');
    expect(args.join(' ')).toContain('scale=w=-2:h=720');
    expect(args.filter((a) => a === '0:a:0')).toHaveLength(3);
    const mapIdx = args.indexOf('-var_stream_map');
    expect(args[mapIdx + 1]).toBe('v:0,a:0 v:1,a:1 a:2');
  });

  it('SILENT video source: no 0:a:0 mapping, video-only var_stream_map', async () => {
    const { runner, calls } = makeRunner();
    await runner.transcode(job(outputDir), probeOf({ hasAudio: false }));
    const args = calls[0]?.args ?? [];
    expect(args).not.toContain('0:a:0');
    expect(args.join(' ')).not.toContain('-c:a');
    const mapIdx = args.indexOf('-var_stream_map');
    expect(args[mapIdx + 1]).toBe('v:0 v:1');
    // No waveform pass for a silent source: ladder + thumbnail only.
    expect(calls).toHaveLength(2);
  });

  it('sub-720p source: single pass-through-height rendition', async () => {
    const { runner, calls } = makeRunner();
    await runner.transcode(job(outputDir), probeOf({ height: 480, width: 854 }));
    const args = calls[0]?.args ?? [];
    expect(args.join(' ')).toContain('scale=w=-2:h=480');
    expect(args.join(' ')).not.toContain('h=720');
    const mapIdx = args.indexOf('-var_stream_map');
    expect(args[mapIdx + 1]).toBe('v:0,a:0 a:1');
  });

  it('video with audio also emits a waveform pass', async () => {
    const { runner, calls } = makeRunner();
    await runner.transcode(job(outputDir), probeOf({}));
    // ladder, thumbnail, waveform (waveform write fails silently on empty
    // stdout — the exec fake wrote no pcm file, and that must NOT throw).
    expect(calls.length).toBe(3);
    const waveformCall = calls[2];
    expect(waveformCall?.args).toContain('s16le');
  });

  it('thumbnail seek clamps below duration for sub-second clips', async () => {
    const { runner, calls } = makeRunner();
    await runner.transcode(job(outputDir), probeOf({ durationMs: 500, hasAudio: false }));
    const thumb = calls[1];
    const ssIdx = thumb?.args.indexOf('-ss') ?? -1;
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    const atSec = Number(thumb?.args[ssIdx + 1]);
    expect(atSec).toBeLessThan(0.5);
    expect(atSec).toBeGreaterThanOrEqual(0);
  });
});
