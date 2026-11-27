// PNG Squeeze: rewrite 1280x720 screenshots as the smallest lossless PNG.
// Node 22, no dependencies, no network, deterministic (fixed work, never the
// clock, so two runs are byte-identical). Reads /input/<id>/image.png, writes
// /output/<id>/image.png for i001..i008 in one run.
//
// Pipeline: decode the stored PNG, reduce the colour type (palette / grey /
// grey+alpha / RGB / RGBA / tRNS key), screen the filter choices by zlib,
// then compress the winner with a zopfli-style optimal-ish deflate written in
// pure JS (distance-aware lazy matching, row-stride candidates, dynamic
// Huffman), keeping whichever of it and zlib level 9 is smaller.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const WIDTH = 1280;
const HEIGHT = 720;

// ---------------------------------------------------------------- PNG codec

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CHUNKS = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const fail = (why) => ({ ok: false, why });

// The image a PNG holds, as RGBA, or why it is not one the contest reads:
// 8-bit, non-interlaced, colour type 0/2/3/4/6, only IHDR/PLTE/tRNS/IDAT/IEND.
function decodePng(bytes, expect = null) {
  if (!(bytes instanceof Uint8Array)) return fail('it is not bytes');
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail('it does not start with the PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) return fail('it holds bytes after IEND');
    if (at + 12 > bytes.length) return fail(`a chunk at byte ${at} is cut short`);
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail(`the chunk at byte ${at} claims ${len} bytes the file does not hold`);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail(`the chunk at byte ${at} has no chunk type (four letters)`);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail(`the ${type} chunk at byte ${at} fails its CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!CHUNKS.includes(type)) return fail(`it holds a ${type} chunk, and only ${CHUNKS.join(', ')} are read`);
    if (header === null && type !== 'IHDR') return fail(`its first chunk is ${type}, not IHDR`);
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null) return fail('it holds IHDR twice');
      if (len !== 13) return fail('its IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.width === 0 || header.height === 0) return fail('its width or height is 0');
      if (expect !== null && (header.width !== expect.width || header.height !== expect.height)) return fail(`it is ${header.width} x ${header.height}, not ${expect.width} x ${expect.height}`);
      if (header.depth !== 8) return fail(`its bit depth is ${header.depth}, not 8`);
      if (!Object.hasOwn(CHANNELS, header.colourType)) return fail(`its colour type is ${header.colourType}, not 0, 2, 3, 4 or 6`);
      if (header.compression !== 0 || header.filter !== 0) return fail('its compression or filter method is not 0');
      if (header.interlace !== 0) return fail('it is interlaced');
    } else if (type === 'PLTE') {
      if (palette !== null) return fail('it holds PLTE twice');
      if (header.colourType !== 3) return fail(`it holds PLTE with colour type ${header.colourType} (only type 3 takes one)`);
      if (idat.length > 0) return fail('its PLTE follows IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) return fail('its PLTE is not 1 to 256 entries of 3 bytes');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return fail('it holds tRNS twice');
      if (idat.length > 0) return fail('its tRNS follows IDAT');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) return fail('its tRNS comes before PLTE');
        if (len > palette.length / 3) return fail('its tRNS holds more entries than its palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail(`its tRNS is not ${ct === 0 ? 2 : 6} bytes for colour type ${ct}`);
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return fail('its tRNS names a sample over 255');
      } else return fail(`it holds tRNS with colour type ${ct}`);
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) return fail('its IDAT chunks are not in a row');
      if (header.colourType === 3 && palette === null) return fail('its IDAT comes before PLTE (colour type 3 needs one)');
      idat.push(data);
    } else {
      if (len !== 0) return fail('its IEND is not empty');
      ended = true;
    }
  }
  if (!ended) return fail('it has no IEND');
  if (idat.length === 0) return fail('it has no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (!Number.isSafeInteger(expected) || expected > 1 << 30) return fail('its image is too large to read');
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    return fail(`its IDAT data is not one whole zlib stream of ${expected} bytes (${String(err && err.message).split('\n')[0]})`);
  }
  if (raw.length !== expected) return fail(`its IDAT data inflates to ${raw.length} bytes, not ${expected}`);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail(`pixel (${i % width}, ${Math.floor(i / width)}) names palette entry ${e} of ${entries}`);
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, colourType, rgba };
}

// ------------------------------------------------- colour types and filters

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const FILTERS = Object.freeze({
  palette: Object.freeze([0]),
  paletteByLuminance: Object.freeze([0, 'minsum', 'brute']),
  channels: Object.freeze([0, 1, 2, 4, 'minsum', 'pairs', 'brute']),
});

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', FILTERS.palette],
      ['luminance', FILTERS.paletteByLuminance],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// The screen's winner: its form, filter choice and filtered data, zlib's stream
// of it at SCREEN and its weight (that stream's bytes plus its PLTE/tRNS
// chunks); the first on a tie.
function screen(rgba, width, height) {
  let best = null;
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, zlib: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length), bytes };
      } else spare = data;
    }
  }
  return best;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ------------------------------------------------------- zopfli-style deflate
// Pure-JS DEFLATE: distance-aware lazy matching (longest match kept per
// distance-code bucket, the match taken is the one with the greatest bit saving
// over literals, lazy lookahead at the next position), row-repeat candidates at
// multiples of the row stride, dynamic Huffman with length-limited codes, two
// parses (flat costs, then real Huffman costs). Deterministic: fixed chain,
// iterations and block size; no clock, no randomness.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const LEN_SYM = new Uint16Array(259), LEN_EB = new Uint8Array(259), LEN_EV = new Uint8Array(259);
for (let len = 3; len <= 258; len++) {
  let s = 0; while (s < 28 && LEN_BASE[s + 1] <= len) s++;
  LEN_SYM[len] = 257 + s; LEN_EB[len] = LEN_EXTRA[s]; LEN_EV[len] = len - LEN_BASE[s];
}
const DIST_SYM = new Uint8Array(32769), DIST_EB = new Uint8Array(32769), DIST_EV = new Uint16Array(32769);
for (let d = 1; d <= 32768; d++) {
  let s = 0; while (s < 29 && DIST_BASE[s + 1] <= d) s++;
  DIST_SYM[d] = s; DIST_EB[d] = DIST_EXTRA[s]; DIST_EV[d] = d - DIST_BASE[s];
}

function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) { lengths[used[0]] = 1; return lengths; }
  const left = [], right = [], wf = [];
  const heap = [];
  const hpush = (id) => { heap.push(id); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (wf[heap[p]] <= wf[heap[i]]) break; const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; } };
  const hpop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length > 0) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && wf[heap[l]] < wf[heap[m]]) m = l; if (r < heap.length && wf[heap[r]] < wf[heap[m]]) m = r; if (m === i) break; const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m; } } return top; };
  for (const s of used) { wf[s] = freq[s]; hpush(s); }
  let next = n;
  while (heap.length > 1) {
    const a = hpop(), b = hpop();
    wf[next] = wf[a] + wf[b]; left[next] = a; right[next] = b; hpush(next); next++;
  }
  const root = heap[0];
  const stack = [[root, 0]];
  let maxLen = 0;
  while (stack.length) {
    const [id, d] = stack.pop();
    if (id < n) { lengths[id] = d; if (d > maxLen) maxLen = d; }
    else { stack.push([left[id], d + 1]); stack.push([right[id], d + 1]); }
  }
  if (maxLen <= maxBits) return lengths;
  const bl = new Array(maxBits + 1).fill(0);
  let kraft0 = 0;
  for (const s of used) { const l = lengths[s]; if (l > maxBits) bl[maxBits]++; else bl[l]++; kraft0 += 1 << (maxBits - Math.min(l, maxBits)); }
  let excess = kraft0 - (1 << maxBits);
  while (excess > 0) {
    let bits = maxBits - 1;
    while (bits > 0 && bl[bits] === 0) bits--;
    if (bl[bits] === 0 || bl[maxBits] === 0) throw new Error('huffman length fix stuck');
    bl[bits]--; bl[bits + 1] += 2; bl[maxBits]--; excess--;
  }
  const order = used.slice().sort((a, b) => freq[b] - freq[a] || a - b);
  let k = 0;
  for (let b = 1; b <= maxBits; b++) for (let j = 0; j < bl[b]; j++) lengths[order[k++]] = b;
  let kraft = 0;
  for (const s of used) kraft += 1 << (maxBits - lengths[s]);
  if (kraft !== (1 << maxBits)) throw new Error('huffman lengths fail Kraft: ' + kraft);
  return lengths;
}

function canonicalCodes(lengths) {
  let maxBits = 0;
  for (const l of lengths) if (l > maxBits) maxBits = l;
  const blCount = new Array(maxBits + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) { const l = lengths[i]; if (l > 0) codes[i] = nextCode[l]++; }
  return codes;
}

function revBits(v, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | ((v >> i) & 1); }
  return r;
}

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.bitbuf = 0; this.bitcnt = 0; }
  grow() { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf.subarray(0, this.pos)); this.buf = nb; }
  bits(value, len) {
    this.bitbuf |= (value << this.bitcnt) >>> 0; this.bitcnt += len;
    while (this.bitcnt >= 8) { if (this.pos >= this.buf.length) this.grow(); this.buf[this.pos++] = this.bitbuf & 255; this.bitbuf >>>= 8; this.bitcnt -= 8; }
  }
  align() { if (this.bitcnt > 0) { if (this.pos >= this.buf.length) this.grow(); this.buf[this.pos++] = this.bitbuf & 255; this.bitbuf = 0; this.bitcnt = 0; } }
  finish() { this.align(); return this.buf.subarray(0, this.pos); }
}

class Matcher {
  constructor(data, stride = 0) {
    this.d = data;
    this.stride = stride;
    this.head = new Int32Array(32768).fill(-1);
    this.prev = new Int32Array(data.length).fill(-1);
    this.inserted = 0;
    this.candLen = new Int32Array(30);
    this.candDist = new Int32Array(30);
  }
  hashAt(i) { const d = this.d; return ((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & 32767; }
  insert(i) {
    const h = this.hashAt(i);
    this.prev[i] = this.head[h]; this.head[h] = i;
    if (i + 1 > this.inserted) this.inserted = i + 1;
  }
  insertUpTo(end) { for (let i = this.inserted; i < end; i++) this.insert(i); }
  bestAt(pos, maxLen, maxChain) {
    const d = this.d;
    if (pos + 3 > d.length) return null;
    const h = this.hashAt(pos);
    let cand = this.head[h];
    const minPos = pos - 32768;
    let chain = 0;
    const limit = Math.min(maxLen, d.length - pos);
    const cl = this.candLen, cd = this.candDist;
    cl.fill(0);
    let bestLen = 2, bestDist = 0;
    while (cand >= 0 && cand > minPos && chain++ < maxChain) {
      const dist = pos - cand;
      const s = DIST_SYM[dist];
      const bl = cl[s];
      if (bl < 258 && d[cand + bl] === d[pos + bl]) {
        let l = 0;
        while (l < limit && d[cand + l] === d[pos + l]) l++;
        if (l > bl) {
          cl[s] = l; cd[s] = dist;
          if (l > bestLen) { bestLen = l; bestDist = dist; }
        }
      }
      cand = this.prev[cand];
    }
    if (this.stride > 0) {
      const maxK = Math.min(Math.floor(32768 / this.stride), Math.floor((pos - 1) / this.stride));
      for (let k = 1; k <= maxK; k++) {
        const dist = k * this.stride;
        const candPos = pos - dist;
        const s = DIST_SYM[dist];
        const bl = cl[s];
        if (bl < 258 && d[candPos + bl] === d[pos + bl]) {
          let l = 0;
          while (l < limit && d[candPos + l] === d[pos + l]) l++;
          if (l > bl) {
            cl[s] = l; cd[s] = dist;
            if (l > bestLen) { bestLen = l; bestDist = dist; }
          }
        }
      }
    }
    return bestLen >= 3 ? { len: bestLen, dist: bestDist } : null;
  }
}

function parseBlock(m, start, end, costs, chain) {
  const d = m.d;
  const lit = costs ? costs.lit : null;
  const pref = new Float64Array(end - start + 1);
  for (let j = 0; j < end - start; j++) pref[j + 1] = pref[j] + (lit ? lit[d[start + j]] : 9);
  const litSum = (i, len) => pref[i - start + len] - pref[i - start];
  const lenCost = costs ? costs.lenCost : null;
  const distCost = costs ? costs.distCost : null;
  const lc = (len) => lenCost ? lenCost[len] : 9 + LEN_EB[len];
  const dc = (dist) => distCost ? distCost[dist] : 9 + DIST_EB[dist];
  const cap = (end - start) * 2 + 16;
  const t0 = new Int32Array(cap), t1 = new Int32Array(cap);
  let nt = 0;
  const emitLit = (b) => { t0[nt] = b; t1[nt] = 0; nt++; };
  const emitMatch = (len, dist) => { t0[nt] = len; t1[nt] = dist; nt++; };
  const bestMatchAt = (pos) => {
    const top = m.bestAt(pos, Math.min(258, end - pos), chain);
    if (!top) return null;
    let best = null;
    for (let s = 0; s < 30; s++) {
      const len = m.candLen[s];
      if (len < 3) continue;
      const dist = m.candDist[s];
      const sv = litSum(pos, len) - (lc(len) + dc(dist));
      if (best === null || sv > best.savings) best = { savings: sv, len, dist };
    }
    return best;
  };
  let i = start;
  m.insertUpTo(start);
  while (i < end) {
    if (i + 3 > end) { emitLit(d[i]); m.insert(i); i++; continue; }
    m.insertUpTo(i);
    const b1 = bestMatchAt(i);
    if (!b1 || b1.savings <= 0) { emitLit(d[i]); m.insert(i); i++; continue; }
    m.insert(i);
    let take = true;
    if (i + 1 + 3 <= end) {
      const b2 = bestMatchAt(i + 1);
      if (b2 && b2.savings > b1.savings) take = false;
    }
    if (!take) { emitLit(d[i]); i++; continue; }
    emitMatch(b1.len, b1.dist);
    const after = i + b1.len;
    m.insertUpTo(after);
    i = after;
  }
  return { t0: t0.subarray(0, nt), t1: t1.subarray(0, nt) };
}

function tokenFreqs(tokens) {
  const litFreq = new Float64Array(286);
  const distFreq = new Float64Array(30);
  const { t0, t1 } = tokens;
  for (let k = 0; k < t0.length; k++) {
    if (t1[k] === 0) litFreq[t0[k]]++;
    else { litFreq[LEN_SYM[t0[k]]]++; distFreq[DIST_SYM[t1[k]]]++; }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

function costsFromLengths(litLen, distLen) {
  const lit = new Float64Array(286);
  for (let s = 0; s < 286; s++) lit[s] = litLen[s] > 0 ? litLen[s] : 15;
  const lenCost = new Float64Array(259);
  for (let len = 3; len <= 258; len++) lenCost[len] = litLen[LEN_SYM[len]] + LEN_EB[len];
  const distCost = new Float64Array(32769);
  for (let dd = 1; dd <= 32768; dd++) distCost[dd] = distLen[DIST_SYM[dd]] + DIST_EB[dd];
  return { lit, lenCost, distCost };
}

function fixDistFreq(distFreq) {
  let usedDist = 0; for (let s = 0; s < 30; s++) if (distFreq[s] > 0) usedDist++;
  if (usedDist === 0) { distFreq[0] = 1; distFreq[1] = 1; }
  else if (usedDist === 1) { for (let s = 0; s < 30; s++) if (distFreq[s] === 0) { distFreq[s] = 1; break; } }
}

function emitBlock(w, tokens, isFinal) {
  const { litFreq, distFreq } = tokenFreqs(tokens);
  fixDistFreq(distFreq);
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);
  let hlit = 286; while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30; while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(litLen.subarray(0, hlit), 0); all.set(distLen.subarray(0, hdist), hlit);
  const clFreq = new Float64Array(19);
  const rle = [];
  {
    let k = 0;
    while (k < all.length) {
      const v = all[k];
      let run = 1; while (k + run < all.length && all[k + run] === v) run++;
      if (v === 0) {
        let r = run;
        while (r >= 11) { const n = Math.min(r, 138); rle.push([18, n]); clFreq[18]++; r -= n; }
        if (r >= 3) { rle.push([17, r]); clFreq[17]++; r = 0; }
        while (r-- > 0) { rle.push([0, 0]); clFreq[0]++; }
      } else {
        rle.push([v, 0]); clFreq[v]++;
        let r = run - 1;
        while (r >= 3) { const n = Math.min(r, 6); rle.push([16, n]); clFreq[16]++; r -= n; }
        while (r-- > 0) { rle.push([v, 0]); clFreq[v]++; }
      }
      k += run;
    }
  }
  const clLen = huffmanLengths(clFreq, 7);
  let usedCl = 0; for (let s = 0; s < 19; s++) if (clFreq[s] > 0) usedCl++;
  if (usedCl === 1) {
    for (let s = 0; s < 19; s++) if (clFreq[s] === 0) { clFreq[s] = 1; break; }
    const l2 = huffmanLengths(clFreq, 7);
    for (let s = 0; s < 19; s++) clLen[s] = l2[s];
  }
  let hclen = 19; while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  const clCode = canonicalCodes(clLen);
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  w.bits(isFinal ? 1 : 0, 1);
  w.bits(2, 2);
  w.bits(hlit - 257, 5);
  w.bits(hdist - 1, 5);
  w.bits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.bits(clLen[CL_ORDER[k]], 3);
  for (const [sym, n] of rle) {
    w.bits(revBits(clCode[sym], clLen[sym]), clLen[sym]);
    if (sym === 16) w.bits(n - 3, 2);
    else if (sym === 17) w.bits(n - 3, 3);
    else if (sym === 18) w.bits(n - 11, 7);
  }
  const { t0, t1 } = tokens;
  for (let k = 0; k < t0.length; k++) {
    if (t1[k] === 0) { w.bits(revBits(litCode[t0[k]], litLen[t0[k]]), litLen[t0[k]]); }
    else {
      const len = t0[k], dist = t1[k];
      const ls = LEN_SYM[len];
      w.bits(revBits(litCode[ls], litLen[ls]), litLen[ls]);
      if (LEN_EB[len]) w.bits(LEN_EV[len], LEN_EB[len]);
      const ds = DIST_SYM[dist];
      w.bits(revBits(distCode[ds], distLen[ds]), distLen[ds]);
      if (DIST_EB[dist]) w.bits(DIST_EV[dist], DIST_EB[dist]);
    }
  }
  w.bits(revBits(litCode[256], litLen[256]), litLen[256]);
}

// A zlib stream for `data`: the best of two parses (flat costs, then real
// Huffman costs from the first parse's token frequencies). Fixed work only:
// blockSize 131072, chain 512, two iterations.
function deflateZlib(data, stride = 0) {
  const blockSize = 131072;
  const chain = 512;
  let best = null;
  let costs = null;
  for (let it = 0; it < 2; it++) {
    const w = new BitWriter(data.length + 4096);
    const m = new Matcher(data, stride);
    const litFreq = new Float64Array(286), distFreq = new Float64Array(30);
    for (let start = 0; start < data.length; start += blockSize) {
      const end = Math.min(data.length, start + blockSize);
      const tokens = parseBlock(m, start, end, costs, chain);
      const f = tokenFreqs(tokens);
      for (let s = 0; s < 286; s++) litFreq[s] += f.litFreq[s];
      for (let s = 0; s < 30; s++) distFreq[s] += f.distFreq[s];
      emitBlock(w, tokens, end >= data.length);
    }
    const raw = w.finish();
    const out = new Uint8Array(raw.length + 6);
    out[0] = 0x78; out[1] = 0x9c;
    out.set(raw, 2);
    const ad = adler32(data);
    out[out.length - 4] = (ad >>> 24) & 255; out[out.length - 3] = (ad >>> 16) & 255; out[out.length - 2] = (ad >>> 8) & 255; out[out.length - 1] = ad & 255;
    if (best === null || out.length < best.length) best = out;
    if (it + 1 < 2) {
      fixDistFreq(distFreq);
      costs = costsFromLengths(huffmanLengths(litFreq, 15), huffmanLengths(distFreq, 15));
    }
  }
  return best;
}

// ------------------------------------------------------------------ main run

for (const id of readdirSync(I).sort()) {
  const input = new Uint8Array(readFileSync(join(I, id, 'image.png')));
  const image = decodePng(input, { width: WIDTH, height: HEIGHT });
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  const win = screen(image.rgba, WIDTH, HEIGHT);
  const stride = WIDTH * win.form.bpp + 1;
  // The custom deflate, and zlib level 9 on the same bytes as a safety net:
  // keep whichever stream is smaller.
  const mine = deflateZlib(win.data, stride);
  const z9 = deflateSync(win.data, { level: 9, memLevel: 9 });
  const idat = mine.length <= z9.length ? mine : new Uint8Array(z9.buffer, z9.byteOffset, z9.length);
  let png = pngOfForm(WIDTH, HEIGHT, win.form, idat);
  // Verify the bytes we are about to write decode to exactly these pixels
  // (every channel, including a fully transparent pixel's colour). If they
  // ever did not, fall back to the input copy: valid, 0 points, still passed.
  const check = decodePng(png, { width: WIDTH, height: HEIGHT });
  if (!check.ok || check.rgba.length !== image.rgba.length || !check.rgba.every((v, i) => v === image.rgba[i])) {
    png = input;
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
}
