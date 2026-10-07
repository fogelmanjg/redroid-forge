#!/usr/bin/env python3
"""Compares the output of hwdec_mediacodec_test (CRC32 per I420 frame, in output order) against the
software reference decode of ffmpeg. Usage: verify_mediacodec.py <clip> <output.txt> [p010]
(p010: the output is 10-bit P010, it is compared against ffmpeg -pix_fmt p010le;
trunc8: a 10-bit clip requested as 8-bit I420, the decoder keeps the high 8 bits of each
16-bit sample = 10-bit sample >> 2, and the reference does the same with an ffmpeg lut)"""
import subprocess, sys, zlib

clip, got_path = sys.argv[1], sys.argv[2]
p010 = len(sys.argv) > 3 and sys.argv[3] == 'p010'
trunc8 = len(sys.argv) > 3 and sys.argv[3] == 'trunc8'
probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
                        '-of', 'csv=p=0', clip], capture_output=True, text=True, check=True).stdout.strip().split(',')
w, h = int(probe[0]), int(probe[1])
size = w * h * 3 if p010 else w * h * 3 // 2
ref = []
if trunc8:
    # 10 bits -> lut val/4 -> 16-bit words whose low byte is the 8-bit value
    cmd = ['ffmpeg', '-v', 'error', '-threads', '1', '-i', clip, '-vf',
           "format=yuv420p10le,lutyuv=y='floor(val/4)':u='floor(val/4)':v='floor(val/4)'",
           '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-']
    read_size = size * 2
else:
    cmd = ['ffmpeg', '-v', 'error', '-threads', '1', '-i', clip, '-f', 'rawvideo',
           '-pix_fmt', 'p010le' if p010 else 'yuv420p', '-']
    read_size = size
p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
while True:
    buf = p.stdout.read(read_size)
    if len(buf) < read_size:
        break
    if trunc8:
        buf = buf[0::2]
    ref.append('%08x' % (zlib.crc32(buf) & 0xFFFFFFFF))
got = [line.split()[3] for line in open(got_path) if line.strip()]
diff = sum(1 for a, b in zip(ref, got) if a != b)
print('referencia=%d frames, decoder=%d frames, distintos=%d' % (len(ref), len(got), diff))
sys.exit(0 if ref and len(ref) == len(got) and diff == 0 else 1)
