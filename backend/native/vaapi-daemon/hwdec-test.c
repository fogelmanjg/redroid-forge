/*
 * Cliente de prueba del paso 1 (solo para desarrollo, NO forma parte del daemon):
 * lee un archivo con libavformat, le entrega a la sesion hwdec un access unit por
 * vez (en Annex-B para H.264/HEVC, como lo hara Android), y escribe el MD5 de cada
 * frame en el orden de salida, en el mismo formato que `ffmpeg -f framemd5`
 * (la columna de md5 es comparable con la de la decodificacion por software).
 *
 *   hwdec-test --probe [nodo]
 *   hwdec-test <archivo> [nodo] [salida.md5]
 */
#include "hwdec.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>

#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavformat/avformat.h>
#include <libavutil/md5.h>

#define DEFAULT_NODE "/dev/dri/renderD128"

static int map_codec(enum AVCodecID id, HwDecCodec *out) {
    switch (id) {
    case AV_CODEC_ID_H264: *out = HWDEC_H264; return 0;
    case AV_CODEC_ID_HEVC: *out = HWDEC_HEVC; return 0;
    case AV_CODEC_ID_VP9: *out = HWDEC_VP9; return 0;
    case AV_CODEC_ID_VP8: *out = HWDEC_VP8; return 0;
    case AV_CODEC_ID_MPEG2VIDEO: *out = HWDEC_MPEG2; return 0;
    case AV_CODEC_ID_VC1: *out = HWDEC_VC1; return 0;
    case AV_CODEC_ID_AV1: *out = HWDEC_AV1; return 0;
    default: return -1;
    }
}

static int probe(const char *node) {
    HwDecCaps c;
    if (hwdec_probe(node, &c) != 0) return 1;
    printf("driver: %s\n", c.driver);
    for (int i = 0; i < HWDEC_NCODECS; i++)
        printf("  %-6s %s%s\n", hwdec_codec_name(i), c.supported[i] ? "hardware" : "-",
               c.supported_10bit[i] ? " (+10 bits)" : "");
    return 0;
}

static FILE *g_out;
static long g_frames;
static int g_bad;

static int drain(HwDecSession *s) {
    HwDecFrame f;
    for (;;) {
        int r = hwdec_receive(s, &f);
        if (r == HWDEC_AGAIN || r == HWDEC_EOF) return r;
        if (r < 0) { g_bad = 1; return r; }
        uint8_t md5[16];
        av_md5_sum(md5, f.data, f.size);
        if (g_out) {
            fprintf(g_out, "0,%10lld,%10lld,%8d,%8zu,", (long long)f.pts, (long long)f.pts, 1, f.size);
            for (int i = 0; i < 16; i++) fprintf(g_out, "%02x", md5[i]);
            fputc('\n', g_out);
        }
        g_frames++;
    }
}

/* Entrega un access unit; si el decoder pide vaciar la salida, la vacia y reintenta. */
static int feed(HwDecSession *s, AVPacket *p) {
    int r;
    while ((r = hwdec_send(s, p->data, p->size, p->pts)) == HWDEC_AGAIN) {
        if (drain(s) < 0 && g_bad) return -1;
    }
    if (r < 0) { g_bad = 1; return -1; }
    int d = drain(s);
    if (d < 0 && g_bad) return -1;
    av_packet_unref(p);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "--probe")) return probe(argc > 2 ? argv[2] : DEFAULT_NODE);
    if (argc < 2) { fprintf(stderr, "uso: %s --probe [nodo] | <archivo> [nodo] [salida.md5]\n", argv[0]); return 2; }
    const char *path = argv[1], *node = argc > 2 ? argv[2] : DEFAULT_NODE;
    g_out = argc > 3 ? fopen(argv[3], "w") : NULL;

    AVFormatContext *fmt = NULL;
    if (avformat_open_input(&fmt, path, NULL, NULL) < 0 || avformat_find_stream_info(fmt, NULL) < 0) {
        fprintf(stderr, "no se pudo abrir %s\n", path);
        return 1;
    }
    int vi = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (vi < 0) { fprintf(stderr, "sin stream de video\n"); return 1; }
    AVStream *st = fmt->streams[vi];
    HwDecCodec codec;
    if (map_codec(st->codecpar->codec_id, &codec) != 0) {
        fprintf(stderr, "codec %s sin mapeo\n", avcodec_get_name(st->codecpar->codec_id));
        return 1;
    }

    /* H.264/HEVC en mp4 viajan en formato AVCC/HVCC: Android los entrega en Annex-B. */
    AVBSFContext *bsf = NULL;
    const char *bsf_name = codec == HWDEC_H264 ? "h264_mp4toannexb" : codec == HWDEC_HEVC ? "hevc_mp4toannexb" : NULL;
    if (bsf_name) {
        const AVBitStreamFilter *f = av_bsf_get_by_name(bsf_name);
        if (!f || av_bsf_alloc(f, &bsf) < 0) return 1;
        avcodec_parameters_copy(bsf->par_in, st->codecpar);
        bsf->time_base_in = st->time_base;
        if (av_bsf_init(bsf) < 0) return 1;
    }

    HwDecSession *s = hwdec_open(node, codec);
    if (!s) { fprintf(stderr, "RESULTADO: el hardware no puede decodificar este stream (%s)\n", hwdec_codec_name(codec)); return 3; }

    AVPacket *pkt = av_packet_alloc(), *out = av_packet_alloc();
    long units = 0;
    while (av_read_frame(fmt, pkt) >= 0) {
        if (pkt->stream_index == vi) {
            if (bsf) {
                if (av_bsf_send_packet(bsf, pkt) < 0) return 1;
                while (av_bsf_receive_packet(bsf, out) == 0) {
                    if (feed(s, out) < 0) return 1;
                    units++;
                }
            } else {
                if (feed(s, pkt) < 0) return 1;
                units++;
            }
        }
        av_packet_unref(pkt);
    }
    if (bsf) {
        av_bsf_send_packet(bsf, NULL);
        while (av_bsf_receive_packet(bsf, out) == 0) {
            if (feed(s, out) < 0) return 1;
            units++;
        }
    }
    hwdec_send_eos(s);
    while (drain(s) == HWDEC_AGAIN) {}
    hwdec_close(s);

    struct rusage ru;
    getrusage(RUSAGE_SELF, &ru);
    double cpu = ru.ru_utime.tv_sec + ru.ru_utime.tv_usec / 1e6 + ru.ru_stime.tv_sec + ru.ru_stime.tv_usec / 1e6;
    printf("RESULTADO: %s %dx%d -> %ld access units, %ld frames decodificados por hardware, cpu=%.2fs%s\n",
           hwdec_codec_name(codec), st->codecpar->width, st->codecpar->height, units, g_frames, cpu,
           g_bad ? " (CON ERRORES)" : "");
    if (g_out) fclose(g_out);
    return g_bad ? 1 : 0;
}
