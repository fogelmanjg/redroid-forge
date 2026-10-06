#!/usr/bin/env python3
"""Compara la salida de hwdec_mediacodec_test (CRC32 por frame I420, en orden de salida) contra la
decodificacion de referencia por software de ffmpeg. Uso: verify_mediacodec.py <clip> <salida.txt>"""
import subprocess, sys, zlib

clip, got_path = sys.argv[1], sys.argv[2]
probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
                        '-of', 'csv=p=0', clip], capture_output=True, text=True, check=True).stdout.strip().split(',')
w, h = int(probe[0]), int(probe[1])
size = w * h * 3 // 2
ref = []
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-threads', '1', '-i', clip, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
                     stdout=subprocess.PIPE)
while True:
    buf = p.stdout.read(size)
    if len(buf) < size:
        break
    ref.append('%08x' % (zlib.crc32(buf) & 0xFFFFFFFF))
got = [line.split()[3] for line in open(got_path) if line.strip()]
diff = sum(1 for a, b in zip(ref, got) if a != b)
print('referencia=%d frames, decoder=%d frames, distintos=%d' % (len(ref), len(got), diff))
sys.exit(0 if ref and len(ref) == len(got) and diff == 0 else 1)
