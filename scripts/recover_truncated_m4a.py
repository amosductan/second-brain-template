#!/usr/bin/env python3
"""Rebuild a playable .m4a from an upload that died mid-transfer.

An iOS Safari recording is a FRAGMENTED MP4 written in streaming order:

    ftyp | mdat (size = a placeholder for the final total) | moof | mdat | moof | ...

Each `moof` carries its own sample table, so the audio is fully self-describing
*except* for the `moov` init segment. iOS writes `moov` differently than a
finished file expects, and a transfer that dies mid-upload leaves a file whose
`mdat` claims a size far past EOF and whose init segment can't be used. ffmpeg
reports "moov atom not found" and every normal repair path gives up.

But the fragments are intact, so the recording is recoverable:

  1. Borrow `ftyp` + `moov` from a healthy recording made by the SAME encoder
     (same codec/sample rate/channels) — that supplies the missing track config.
  2. Keep every complete `moof`+`mdat` fragment, dropping only the final partial
     one.
  3. Fix up the offsets. This is the part that silently produces a 0-byte decode
     if you skip it: `tfhd.base_data_offset` is an ABSOLUTE file offset, so
     prepending an init segment of a different size invalidates every fragment.
     Each one is shifted by the delta.
  4. Repair the leading `mdat` size so it ends where the first `moof` begins —
     otherwise a parser treats the placeholder size as gospel and swallows every
     fragment inside one enormous `mdat`, seeing no audio at all.

Usage:
    python scripts/recover_truncated_m4a.py BROKEN.m4a --reference HEALTHY.m4a \
        [--out RECOVERED.m4a]

The input is never modified. Verify the result with ffprobe/ffmpeg before
trusting it; a recovered file may be missing a second or two at the head, since
data written before the first `moof` has no sample table describing it.
"""
import argparse
import struct
import sys
from pathlib import Path


def read_box_header(buf, off):
    """Return (size, type, header_len) for the box at off, or None if malformed."""
    if off + 8 > len(buf):
        return None
    size = struct.unpack('>I', buf[off:off + 4])[0]
    btype = buf[off + 4:off + 8]
    hdr = 8
    if size == 1:
        if off + 16 > len(buf):
            return None
        size = struct.unpack('>Q', buf[off + 8:off + 16])[0]
        hdr = 16
    return size, btype, hdr


def find_init_segment(ref: bytes):
    """Extract ftyp+moov from a healthy fragmented recording."""
    off = 0
    end_of_moov = None
    saw_ftyp = False
    while off < len(ref) - 8:
        parsed = read_box_header(ref, off)
        if not parsed:
            break
        size, btype, _ = parsed
        if size <= 0:
            break
        if btype == b'ftyp':
            saw_ftyp = True
        if btype == b'moov':
            end_of_moov = off + size
            break
        off += size
    if not saw_ftyp or end_of_moov is None:
        raise SystemExit('reference file has no ftyp+moov init segment — pick a healthy recording')
    return ref[:end_of_moov]


def patch_trex_duration(init: bytearray, frame_samples=1024):
    """Give samples a duration so decode timestamps actually advance.

    These fragments carry sample sizes but not durations, so duration falls back
    to `trex.default_sample_duration` — which iOS writes as 0. In a normal file
    that is harmless, but here it makes every sample share one timestamp: ffmpeg
    reports "Non-monotonic DTS" and emits about two seconds of audio from a
    ten-minute recording. One AAC frame is 1024 samples at the track timescale.
    """
    i = init.find(b'trex')
    if i < 0:
        return None
    pos = i + 4 + 12  # version/flags + track_ID + default_sample_description_index
    current = struct.unpack('>I', init[pos:pos + 4])[0]
    if current == 0:
        struct.pack_into('>I', init, pos, frame_samples)
        return f'{current} -> {frame_samples}'
    return f'{current} (left alone)'


def first_fragment_offset(buf: bytes):
    """Offset of the first real moof box (validated by a plausible size field)."""
    i = 0
    while True:
        i = buf.find(b'moof', i + 1)
        if i < 0:
            return None
        start = i - 4
        if start < 0:
            continue
        size = struct.unpack('>I', buf[start:start + 4])[0]
        # A moof is a small index box; anything huge is a coincidental byte match.
        # +8 is the first child's size field; its type sits at +12.
        if 0 < size < 1_000_000 and buf[start + 12:start + 16] == b'mfhd':
            return start


def last_complete_fragment_end(buf: bytes, start: int):
    """Walk the moof/mdat chain and return the end of the last COMPLETE fragment."""
    off = start
    last_good = start
    moofs = 0
    while off < len(buf) - 8:
        parsed = read_box_header(buf, off)
        if not parsed:
            break
        size, btype, _ = parsed
        if size <= 0 or btype not in (b'moof', b'mdat'):
            break
        if off + size > len(buf):
            break  # the partial fragment the upload died inside
        if btype == b'moof':
            moofs += 1
        else:
            last_good = off + size  # a moof+mdat pair completed here
        off += size
    return last_good, moofs


def shift_base_data_offsets(buf: bytearray, start: int, delta: int):
    """Add delta to every tfhd.base_data_offset in the fragment chain."""
    off = start
    patched = 0
    while off < len(buf) - 8:
        parsed = read_box_header(buf, off)
        if not parsed:
            break
        size, btype, hdr = parsed
        if size <= 0 or btype not in (b'moof', b'mdat'):
            break
        if btype == b'moof':
            # descend: moof -> traf -> tfhd
            inner = off + hdr
            moof_end = off + size
            while inner < moof_end - 8:
                p = read_box_header(buf, inner)
                if not p:
                    break
                isize, itype, ihdr = p
                if isize <= 0:
                    break
                if itype == b'traf':
                    t = inner + ihdr
                    traf_end = inner + isize
                    while t < traf_end - 8:
                        tp = read_box_header(buf, t)
                        if not tp:
                            break
                        tsize, ttype, thdr = tp
                        if tsize <= 0:
                            break
                        if ttype == b'tfhd':
                            flags = struct.unpack('>I', buf[t + thdr:t + thdr + 4])[0] & 0xFFFFFF
                            if flags & 0x000001:  # base-data-offset-present
                                pos = t + thdr + 8  # after version/flags + track_ID
                                val = struct.unpack('>Q', buf[pos:pos + 8])[0]
                                struct.pack_into('>Q', buf, pos, val + delta)
                                patched += 1
                        t += tsize
                inner += isize
        off += size
    return patched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('broken', type=Path)
    ap.add_argument('--reference', type=Path, required=True,
                    help='a healthy .m4a from the same encoder (same codec/rate/channels)')
    ap.add_argument('--out', type=Path, default=None)
    args = ap.parse_args()

    broken = args.broken.read_bytes()
    ref = args.reference.read_bytes()
    out_path = args.out or args.broken.with_name(args.broken.stem + '.recovered.m4a')

    init = bytearray(find_init_segment(ref))
    trex = patch_trex_duration(init)
    frag_start = first_fragment_offset(broken)
    if frag_start is None:
        raise SystemExit('no moof fragments found — this file is not a fragmented recording, '
                         'so there is nothing to rebuild from')

    frag_end, moofs = last_complete_fragment_end(broken, frag_start)
    if moofs == 0:
        raise SystemExit('no complete fragments survived — unrecoverable')

    # The leading mdat header is kept so the byte layout stays predictable; it
    # starts right after the original ftyp.
    hdr = read_box_header(broken, 0)
    if not hdr or hdr[1] != b'ftyp':
        raise SystemExit('broken file does not start with ftyp')
    orig_body_start = hdr[0]

    body = bytearray(broken[orig_body_start:frag_end])
    delta = len(init) - orig_body_start

    # Repair the leading mdat: it must end exactly where the first moof begins,
    # or a parser swallows every fragment inside it.
    lead = read_box_header(body, 0)
    if lead and lead[1] == b'mdat':
        lead_size, _, lead_hdr = lead
        true_size = (frag_start - orig_body_start)
        if lead_hdr == 16:
            struct.pack_into('>Q', body, 8, true_size)   # keep the 64-bit form
        else:
            struct.pack_into('>I', body, 0, true_size)
        print(f'  leading mdat size {lead_size} -> {true_size}')

    patched = shift_base_data_offsets(body, frag_start - orig_body_start, delta)

    out_path.write_bytes(bytes(init) + bytes(body))
    print(f'  init segment      : {len(init)} bytes (from {args.reference.name})')
    print(f'  trex sample dur   : {trex}')
    print(f'  fragments kept    : {moofs} (dropped {len(broken) - frag_end} trailing partial bytes)')
    print(f'  base offsets fixed: {patched} (delta {delta:+d})')
    print(f'  wrote {out_path} ({out_path.stat().st_size} bytes)')
    print('Verify before trusting: ffmpeg -v error -i <out> -f null -')


if __name__ == '__main__':
    sys.exit(main())
