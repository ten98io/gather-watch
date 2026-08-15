/**
 * Processing-pipeline port. The ffmpeg/ffprobe invocation lives behind
 * PipelineRunner so tests substitute a fake — no ffmpeg in CI. The real
 * implementation (pipeline/ffmpeg.ts) spawns config.ffmpegPath/ffprobePath.
 */
export interface ProbeResult {
  durationMs: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
}

export interface TranscodeJob {
  assetId: string;
  /** Local path of the downloaded source file. */
  inputPath: string;
  /**
   * Local dir the runner writes the ENTIRE artifact tree into:
   *  - master.m3u8 + rendition dirs (vs0/, vs1/, audio/) — always
   *  - thumb.jpg — when the source has video
   *  - waveform.json — when the source is audio-only
   * The pipeline uploads the tree verbatim under the asset's `hls/` prefix.
   */
  outputDir: string;
}

export interface PipelineRunner {
  probe(inputPath: string): Promise<ProbeResult>;
  /** Throws on any transcode failure; the pipeline marks the asset failed. */
  transcode(job: TranscodeJob, probe: ProbeResult): Promise<void>;
}
