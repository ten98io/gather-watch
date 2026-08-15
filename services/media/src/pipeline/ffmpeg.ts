/**
 * Real ffmpeg/ffprobe runner (child_process spawn). NOT exercised in CI — the
 * test suite substitutes a fake PipelineRunner. The HLS ladder:
 *  - video sources: 1080p + 720p renditions (heights beyond the source are
 *    skipped; sub-720p sources get a single pass-through-height rendition),
 *    each with muxed AAC audio, PLUS an audio-only rendition; vod playlist;
 *    thumbnail at 10% duration.
 *  - audio sources: single audio-only HLS rendition + waveform JSON.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';
import type { PipelineRunner, ProbeResult, TranscodeJob } from './ports';

/** Exec seam: tests inject a recorder to assert argument construction. */
export type ExecFn = (bin: string, args: readonly string[]) => Promise<string>;

/** Run a binary to completion; reject with the tail of stderr on failure. */
function run(bin: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new AppError('INTERNAL', `${bin} exited ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

const WAVEFORM_SAMPLE_RATE = 8_000;
const WAVEFORM_PEAKS = 1_000;
/** Video rendition ladder, tallest first. */
const LADDER_HEIGHTS = [1080, 720] as const;

export class FfmpegRunner implements PipelineRunner {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly exec: ExecFn;

  constructor(config: Pick<AppConfig, 'ffmpegPath' | 'ffprobePath'>, exec: ExecFn = run) {
    this.ffmpeg = config.ffmpegPath;
    this.ffprobe = config.ffprobePath;
    this.exec = exec;
  }

  async probe(inputPath: string): Promise<ProbeResult> {
    const stdout = await this.exec(this.ffprobe, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ]);
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const durationSec = Number(parsed.format?.duration);
    return {
      durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
      hasVideo: video !== undefined,
      hasAudio: audio !== undefined,
      width: typeof video?.width === 'number' ? video.width : null,
      height: typeof video?.height === 'number' ? video.height : null,
    };
  }

  async transcode(job: TranscodeJob, probe: ProbeResult): Promise<void> {
    await mkdir(job.outputDir, { recursive: true });
    if (probe.hasVideo) {
      await this.transcodeVideo(job, probe);
      // Thumbnail/waveform are OPTIONAL artifacts: a seek/decode hiccup on
      // them must not fail an asset whose HLS ladder already succeeded (the
      // pipeline publishes null URLs for whatever is absent).
      await this.thumbnail(job, probe).catch(() => undefined);
      if (probe.hasAudio) {
        // Listen-mode's waveform seek bar applies to video files too.
        await this.waveform(job).catch(() => undefined);
      }
    } else if (probe.hasAudio) {
      await this.transcodeAudioOnly(job);
      await this.waveform(job);
    } else {
      throw new AppError('VALIDATION', 'probe found neither video nor audio streams');
    }
  }

  /** 1080p/720p (+ audio-only rendition when the source HAS audio) HLS
   *  ladder with a master playlist. Silent sources (muted screen recordings,
   *  GoPro clips) get video-only variants — mapping 0:a:0 unconditionally
   *  would make ffmpeg exit non-zero on them. */
  private async transcodeVideo(job: TranscodeJob, probe: ProbeResult): Promise<void> {
    const sourceHeight = probe.height ?? 720;
    let heights: number[] = LADDER_HEIGHTS.filter((h) => sourceHeight >= h);
    if (heights.length === 0) heights = [sourceHeight];

    const args: string[] = ['-y', '-i', job.inputPath];
    // One split=N feeding a scale branch per rendition.
    const filterParts: string[] = [
      `[0:v]split=${heights.length}${heights.map((_h, i) => `[v${i}]`).join('')}`,
      ...heights.map((h, i) => `[v${i}]scale=w=-2:h=${h}[vs${i}]`),
    ];
    args.push('-filter_complex', filterParts.join(';'));

    heights.forEach((h, i) => {
      const bitrateK = h >= 1080 ? 5000 : h >= 720 ? 2800 : 1400;
      args.push(
        '-map',
        `[vs${i}]`,
        `-c:v:${i}`,
        'libx264',
        '-preset',
        'veryfast',
        `-b:v:${i}`,
        `${bitrateK}k`,
        `-maxrate:v:${i}`,
        `${Math.round(bitrateK * 1.07)}k`,
        `-bufsize:v:${i}`,
        `${bitrateK * 2}k`,
      );
    });
    // One audio output stream PER VARIANT (video variants + audio-only) —
    // only when the source actually has an audio stream.
    const variantCount = probe.hasAudio ? heights.length + 1 : heights.length;
    if (probe.hasAudio) {
      for (let i = 0; i < variantCount; i += 1) {
        args.push('-map', '0:a:0', `-c:a:${i}`, 'aac', `-b:a:${i}`, '128k');
      }
    }
    const varStreamMap = probe.hasAudio
      ? [
          ...heights.map((_h, i) => `v:${i},a:${i}`),
          `a:${heights.length}`, // audio-only rendition
        ].join(' ')
      : heights.map((_h, i) => `v:${i}`).join(' ');
    args.push(
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_playlist_type',
      'vod',
      '-var_stream_map',
      varStreamMap,
      '-master_pl_name',
      'master.m3u8',
      '-hls_segment_filename',
      join(job.outputDir, 'vs%v', 'seg%05d.ts'),
      join(job.outputDir, 'vs%v', 'index.m3u8'),
    );
    // ffmpeg does not reliably create per-variant segment dirs; make them all.
    for (let i = 0; i < variantCount; i += 1) {
      await mkdir(join(job.outputDir, `vs${i}`), { recursive: true });
    }
    await this.exec(this.ffmpeg, args);
  }

  /** Audio-only source: one AAC HLS rendition + a hand-written master. */
  private async transcodeAudioOnly(job: TranscodeJob): Promise<void> {
    const audioDir = join(job.outputDir, 'audio');
    await mkdir(audioDir, { recursive: true });
    await this.exec(this.ffmpeg, [
      '-y',
      '-i',
      job.inputPath,
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_filename',
      join(audioDir, 'seg%05d.ts'),
      join(audioDir, 'index.m3u8'),
    ]);
    await writeFile(
      join(job.outputDir, 'master.m3u8'),
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=131072,CODECS="mp4a.40.2"\naudio/index.m3u8\n',
      'utf8',
    );
  }

  /** JPEG thumbnail at 10% of duration, max width 640. The seek clamps to
   *  [0, duration) — a >=1s floor would seek past EOF on sub-second clips. */
  private async thumbnail(job: TranscodeJob, probe: ProbeResult): Promise<void> {
    const durationSec = probe.durationMs === null ? null : probe.durationMs / 1000;
    const atSec =
      durationSec === null
        ? 0
        : Math.min(durationSec * 0.1, Math.max(durationSec - 0.1, 0));
    await this.exec(this.ffmpeg, [
      '-y',
      '-ss',
      atSec.toFixed(3),
      '-i',
      job.inputPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      join(job.outputDir, 'thumb.jpg'),
    ]);
  }

  /** Mono 8 kHz PCM bucketed into ~1000 normalized peaks → waveform.json. */
  private async waveform(job: TranscodeJob): Promise<void> {
    const pcmPath = join(job.outputDir, '.waveform.pcm');
    await this.exec(this.ffmpeg, [
      '-y',
      '-i',
      job.inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(WAVEFORM_SAMPLE_RATE),
      '-f',
      's16le',
      pcmPath,
    ]);
    const pcm = await readFile(pcmPath);
    // Scratch file — must not be uploaded with the artifact tree.
    await rm(pcmPath, { force: true });
    const sampleCount = Math.floor(pcm.length / 2);
    const peaks: number[] = [];
    if (sampleCount > 0) {
      const perPeak = Math.max(1, Math.floor(sampleCount / WAVEFORM_PEAKS));
      for (let i = 0; i < sampleCount && peaks.length < WAVEFORM_PEAKS; i += perPeak) {
        let max = 0;
        for (let j = i; j < Math.min(i + perPeak, sampleCount); j += 1) {
          const sample = Math.abs(pcm.readInt16LE(j * 2));
          if (sample > max) max = sample;
        }
        peaks.push(Math.round((max / 32768) * 1000) / 1000);
      }
    }
    await writeFile(
      join(job.outputDir, 'waveform.json'),
      JSON.stringify({
        version: 1,
        sampleRate: WAVEFORM_SAMPLE_RATE,
        samplesPerPeak: Math.max(1, Math.floor(sampleCount / WAVEFORM_PEAKS)),
        peaks,
      }),
      'utf8',
    );
  }
}
