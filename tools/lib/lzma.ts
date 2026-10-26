/**
 * Minimal LZMA ("LZMA-alone", .lzma) decoder.
 *
 * DE serves the Public Export index as an .lzma file and Node has no LZMA in zlib, so this keeps
 * `npm run public-export` free of runtime dependencies and system tools. It is a straight
 * transcription of the reference decoder (LzmaSpec.cpp from the LZMA SDK, public domain):
 * range coder, literal coder, length coders, distance slots and the 12-state machine.
 */

const PROB_INIT = 1024;
const TOP = 1 << 24;

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private readonly input: Uint8Array;
  private pos: number;
  constructor(input: Uint8Array, pos: number) {
    this.input = input;
    this.pos = pos;
    if (input[this.pos++] !== 0) throw new Error('lzma: corrupted range coder header');
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | input[this.pos++]) >>> 0;
    if (this.code === this.range) throw new Error('lzma: corrupted range coder header');
  }

  private normalize(): void {
    if (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.input[this.pos++]) >>> 0;
    }
  }

  directBits(count: number): number {
    let result = 0;
    while (count--) {
      this.range >>>= 1;
      this.code = (this.code - this.range) >>> 0;
      const t = 0 - (this.code >>> 31);
      this.code = (this.code + (this.range & t)) >>> 0;
      this.normalize();
      result = ((result << 1) + (t + 1)) >>> 0;
    }
    return result;
  }

  bit(probs: Uint16Array, index: number): number {
    const p = probs[index];
    const bound = (this.range >>> 11) * p;
    let symbol: number;
    if (this.code < bound) {
      probs[index] = p + ((2048 - p) >>> 5);
      this.range = bound;
      symbol = 0;
    } else {
      probs[index] = p - (p >>> 5);
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      symbol = 1;
    }
    this.normalize();
    return symbol;
  }
}

function bitTree(rc: RangeDecoder, probs: Uint16Array, offset: number, bits: number): number {
  let m = 1;
  for (let i = 0; i < bits; i++) m = (m << 1) + rc.bit(probs, offset + m);
  return m - (1 << bits);
}

function reverseBitTree(rc: RangeDecoder, probs: Uint16Array, offset: number, bits: number): number {
  let m = 1;
  let symbol = 0;
  for (let i = 0; i < bits; i++) {
    const bit = rc.bit(probs, offset + m);
    m = (m << 1) + bit;
    symbol |= bit << i;
  }
  return symbol;
}

class LengthDecoder {
  private readonly choice = new Uint16Array(2).fill(PROB_INIT);
  private readonly low = new Uint16Array(16 << 3).fill(PROB_INIT);
  private readonly mid = new Uint16Array(16 << 3).fill(PROB_INIT);
  private readonly high = new Uint16Array(256).fill(PROB_INIT);

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return bitTree(rc, this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + bitTree(rc, this.mid, posState << 3, 3);
    return 16 + bitTree(rc, this.high, 0, 8);
  }
}

export function decompressLzma(input: Uint8Array): Uint8Array {
  let properties = input[0];
  if (properties >= 9 * 5 * 5) throw new Error('lzma: bad properties byte');
  const lc = properties % 9;
  properties = Math.floor(properties / 9);
  const lp = properties % 5;
  const pb = Math.floor(properties / 5);
  // Bytes 1-4: dictionary size (the whole output is kept, so it only bounds back-references).
  let unpackSize = 0;
  let sizeKnown = false;
  for (let i = 0; i < 8; i++) {
    if (input[5 + i] !== 0xff) sizeKnown = true;
  }
  if (sizeKnown) {
    for (let i = 7; i >= 0; i--) unpackSize = unpackSize * 256 + input[5 + i];
  }

  const rc = new RangeDecoder(input, 13);
  const literalProbs = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);
  const isMatch = new Uint16Array(12 << 4).fill(PROB_INIT);
  const isRep = new Uint16Array(12).fill(PROB_INIT);
  const isRepG0 = new Uint16Array(12).fill(PROB_INIT);
  const isRepG1 = new Uint16Array(12).fill(PROB_INIT);
  const isRepG2 = new Uint16Array(12).fill(PROB_INIT);
  const isRep0Long = new Uint16Array(12 << 4).fill(PROB_INIT);
  const posSlot = new Uint16Array(4 << 6).fill(PROB_INIT);
  const posDecoders = new Uint16Array(1 + 114).fill(PROB_INIT);
  const align = new Uint16Array(16).fill(PROB_INIT);
  const lenDecoder = new LengthDecoder();
  const repLenDecoder = new LengthDecoder();

  let out = new Uint8Array(sizeKnown ? unpackSize : 1 << 16);
  let size = 0;
  const put = (byte: number): void => {
    if (size === out.length) {
      const grown = new Uint8Array(out.length * 2);
      grown.set(out);
      out = grown;
    }
    out[size++] = byte;
  };

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;

  while (!sizeKnown || size < unpackSize) {
    const posState = size & pbMask;
    if (rc.bit(isMatch, (state << 4) + posState) === 0) {
      const prev = size > 0 ? out[size - 1] : 0;
      const base = 0x300 * (((size & lpMask) << lc) + (prev >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[size - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const bit = rc.bit(literalProbs, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literalProbs, base + symbol);
      put(symbol - 0x100);
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let length: number;
    if (rc.bit(isRep, state) !== 0) {
      if (size === 0) throw new Error('lzma: repeat match at the start of the stream');
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          put(out[size - rep0 - 1]);
          continue;
        }
      } else {
        let distance: number;
        if (rc.bit(isRepG1, state) === 0) {
          distance = rep1;
        } else {
          if (rc.bit(isRepG2, state) === 0) {
            distance = rep2;
          } else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      length = repLenDecoder.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      length = lenDecoder.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      const lenState = Math.min(length, 3);
      const slot = bitTree(rc, posSlot, lenState << 6, 6);
      if (slot < 4) {
        rep0 = slot;
      } else {
        const directBits = (slot >>> 1) - 1;
        let distance = ((2 | (slot & 1)) << directBits) >>> 0;
        if (slot < 14) {
          distance += reverseBitTree(rc, posDecoders, distance - slot, directBits);
        } else {
          distance += rc.directBits(directBits - 4) << 4;
          distance += reverseBitTree(rc, align, 0, 4);
        }
        rep0 = distance >>> 0;
      }
      // The end-of-stream marker: distance 0xFFFFFFFF.
      if (rep0 === 0xffffffff) break;
    }
    length += 2;
    if (rep0 >= size) throw new Error('lzma: match distance beyond the start of the output');
    for (let i = 0; i < length && (!sizeKnown || size < unpackSize); i++) put(out[size - rep0 - 1]);
  }
  return out.subarray(0, size);
}
