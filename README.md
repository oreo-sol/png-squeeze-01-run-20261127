# PNG Squeeze — smallest lossless PNGs for screenshots

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/oreo-sol/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/oreo-sol/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG recompressor for 1280x720 screenshots. `main.ts` (Node 22, no
dependencies, no network, deterministic) reads each `/input/<id>/image.png`,
writes the same pixels as `/output/<id>/image.png` in as few bytes as it can.

## How it squeezes

- **Colour-type reduction**: palette (≤256 colours, transparent entries first),
  grey, grey+alpha, RGB, RGBA, or a tRNS key when one transparent value covers
  every non-opaque pixel.
- **Filter search**: every row unfiltered, one fixed filter, minimum-sum,
  fewest-distinct-pairs, and brute force (each row's five filters weighed by a
  real deflate of the row after its 32 KiB of context), screened by zlib.
- **A zopfli-style deflate written in pure JS**: distance-aware lazy matching
  (the longest match per distance-code bucket, chosen by bit saving over
  literals, with a lazy lookahead), row-repeat candidates at multiples of the
  row stride, dynamic Huffman with length-limited codes, two parses (flat
  costs, then real Huffman costs). The winner is kept only when it beats
  zlib level 9 on the same filtered bytes.

Everything runs in one 60 s wall budget for the 8-instance set, budgeted by
fixed work (chain length, iterations, block size) — never by the clock — so
two runs produce byte-identical output.

## Layout

- `main.ts` — the whole entry: PNG codec, colour-type/filter screen, deflate
- `LICENSE` — MIT (the kit starter's, byte for byte)

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Licence

MIT — see `LICENSE`.
