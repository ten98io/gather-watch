/**
 * Generates the extension's toolbar/store icons from the product mark.
 *
 * Run by hand (no package.json entry on purpose — icons change when the mark
 * does, which is rare enough that a build step would be dead weight):
 *
 *     node scripts/gen-icons.mjs
 *
 * Emits public/icon-16.png, icon-32.png, icon-48.png, icon-128.png by
 * rasterizing apps/web/app/icon.svg AT EACH SIZE through headless Chrome —
 * one render per size rather than one downscale, so the triangle's edges are
 * hinted by the rasterizer at the size they will actually be seen.
 *
 * At 16 and 32 px the dashed ring is dropped: 4/18 dashes on a 6px stroke
 * alias into noise below ~48px, so the small sizes inline a simplified
 * variant of the same mark — rect + glow + triangle, identical colors.
 *
 * Requires Google Chrome at the standard macOS path (CHROME env var
 * overrides). Zero npm dependencies: the PNG checks below read the IHDR and
 * corner bytes directly.
 *
 * The manifest does not reference these yet — a later change wires
 * `manifest.json#icons` to them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const sourceSvg = readFileSync(join(repoRoot, 'apps', 'web', 'app', 'icon.svg'), 'utf8');
const outDir = resolve(here, '..', 'public');

/** The mark without the dashed ring, for the sizes where the ring is noise.
 *  Same rect, glow and triangle as icon.svg — colors must stay in step. */
const SMALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="aurora" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cfc"/>
      <stop offset="0.5" stop-color="#d64db8"/>
      <stop offset="1" stop-color="#e8b34d"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#7c5cfc" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#7c5cfc" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="#17141f"/>
  <circle cx="256" cy="256" r="220" fill="url(#glow)"/>
  <path d="M208 160 L368 256 L208 352 Z" fill="url(#aurora)"/>
</svg>`;

/** Sizes where the dashed ring survives rasterization. */
const RING_MIN_PX = 48;
const SIZES = [16, 32, 48, 128];

/**
 * An HTML wrapper with the SVG at an explicit pixel size in the top-left
 * corner, nothing else painting, and the page background left transparent for
 * Chrome's --default-background-color to decide.
 *
 * The size is written onto the <svg> as width/height ATTRIBUTES, not with
 * viewport units: `--headless=new --screenshot` clips the shot to
 * --window-size but lays the page out at the default viewport, so `100vw`
 * renders the mark at 800px and the shot catches its corner.
 */
function wrapperHtml(svg, size) {
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  return `<!doctype html><html><head><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    svg { display: block; }
  </style></head><body>${sized}</body></html>`;
}

function rasterize(htmlPath, outPath, size, backgroundHex) {
  execFileSync(
    CHROME,
    [
      '--headless=new',
      `--screenshot=${outPath}`,
      `--window-size=${size}x${size}`,
      `--default-background-color=${backgroundHex}`,
      '--hide-scrollbars',
      pathToFileURL(htmlPath).href,
    ],
    { stdio: 'pipe' },
  );
}

/* ── PNG verification, from the bytes ────────────────────────────────────── */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdrSize(png) {
  if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');
  // IHDR is always the first chunk: length at 8, type at 12, data at 16.
  if (png.toString('latin1', 12, 16) !== 'IHDR') throw new Error('IHDR not first');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Decodes the top-left pixel of a Chrome screenshot PNG. 8-bit RGBA (color
 *  type 6) or — what Chrome emits when every pixel is opaque, as in the
 *  magenta control render — 8-bit RGB (type 2). No interlace. One inflate,
 *  first scanline, first pixel. */
function topLeftPixel(png) {
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(`unexpected PNG format: depth=${bitDepth} color=${colorType}`);
  }
  const idat = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  // Scanline 0, pixel 0: the filter byte is followed by literal bytes here,
  // whichever filter Chrome chose — every PNG filter predicts from the left/up
  // neighbours, and the first pixel of the first row has neither (all zero).
  return { r: raw[1], g: raw[2], b: raw[3], a: colorType === 6 ? raw[4] : 255 };
}

/* ── generate + verify ───────────────────────────────────────────────────── */

const work = mkdtempSync(join(tmpdir(), 'gather-icons-'));
try {
  for (const size of SIZES) {
    const svg = size < RING_MIN_PX ? SMALL_SVG : sourceSvg;
    const htmlPath = join(work, `icon-${size}.html`);
    writeFileSync(htmlPath, wrapperHtml(svg, size));

    const outPath = join(outDir, `icon-${size}.png`);
    rasterize(htmlPath, outPath, size, '00000000');

    const png = readFileSync(outPath);
    if (png.length === 0) throw new Error(`icon-${size}.png is empty`);
    const { width, height } = ihdrSize(png);
    if (width !== size || height !== size) {
      throw new Error(`icon-${size}.png is ${width}x${height}, wanted ${size}x${size}`);
    }

    // The rounded rect leaves the corner outside the mark: in the transparent
    // build its alpha must be 0, and in a magenta control render the corner
    // must come out magenta — together they prove the corner pixel is the
    // background and the background is honored, not baked in.
    const corner = topLeftPixel(png);
    if (corner.a !== 0) {
      throw new Error(`icon-${size}.png corner is not transparent (alpha=${corner.a})`);
    }
    const controlPath = join(work, `control-${size}.png`);
    rasterize(htmlPath, controlPath, size, 'ff00ffff');
    const control = topLeftPixel(readFileSync(controlPath));
    if (control.r !== 255 || control.g !== 0 || control.b !== 255) {
      throw new Error(
        `icon-${size}.png control corner is rgb(${control.r},${control.g},${control.b}), not magenta — the mark is painting the corner`,
      );
    }

    console.log(
      `icon-${size}.png  ${width}x${height}  ${png.length} bytes  corner alpha 0  ` +
        `${size < RING_MIN_PX ? 'no ring' : 'ring'}`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
