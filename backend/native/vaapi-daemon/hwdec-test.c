/*
 * Test client of step 1 (for development only, NOT part of the daemon):
 * it reads a file with libavformat, hands the hwdec session one access unit at a
 * time (in Annex-B for H.264/HEVC, as Android will), and writes the MD5 of every
 * frame in output order, in the same format as `ffmpeg -f framemd5`
 * (the md5 column is comparable with that of software decoding).
 *
 *   hwdec-test --probe [node]
 *   hwdec-test <file> [node] [output.md5]
 *   hwdec-test --socket <path> <file> [output.md5]   (through the daemon, protocol v2)
 *   hwdec-test --socket-probe <path>                  (asks the daemon for its capabilities)
 *   --twice (before the file): decodes it twice in the same session, with an end of stream in between
 */
#include "hwdec.h"
#include "hwdec_client.h"

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

/* Two ways of talking to the decoder: the in-process session (hwdec.c) or the daemon through a socket. */
static HwDecClient *g_client;   /* != NULL: modo socket */

static int be_send(HwDecSession *s, const uint8_t *d, size_t n, int64_t pts) {
    return g_client ? hwdec_client_send(g_client, d, n, pts) : hwdec_send(s, d, n, pts);
}
static int be_receive(HwDecSession *s, HwDecFrame *f) {
    return g_client ? hwdec_client_next_frame(g_client, f) : hwdec_receive(s, f);
}
static int be_eos(HwDecSession *s) {
    return g_client ? hwdec_client_eos(g_client) : hwdec_send_eos(s);
}

static int g_twice;
static long g_pass1_frames;
static FILE *g_out;
static long g_frames;
static int g_bad;

static int drain(HwDecSession *s) {
    HwDecFrame f;
    for (;;) {
        int r = be_receive(s, &f);
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

/* Delivers one access unit; if the decoder asks to drain the output, it drains it and retries. */
static int feed(HwDecSession *s, AVPacket *p) {
    int r;
    while ((r = be_send(s, p->data, p->size, p->pts)) == HWDEC_AGAIN) {
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
    if (argc >= 3 && !strcmp(argv[1], "--socket-probe")) {
        HwDecCaps c;
        if (hwdec_client_caps(argv[2], &c) != 0) { fprintf(stderr, "the daemon did not answer\n"); return 1; }
        printf("driver (according to the daemon): %s\n", c.driver);
        for (int i = 0; i < HWDEC_NCODECS; i++)
            printf("  %-6s %s%s\n", hwdec_codec_name(i), c.supported[i] ? "hardware" : "-", c.supported_10bit[i] ? " (+10 bits)" : "");
        return 0;
    }
    const char *sock = NULL;
    if (argc >= 3 && !strcmp(argv[1], "--twice")) { g_twice = 1; argv += 1; argc -= 1; }
    if (argc >= 4 && !strcmp(argv[1], "--socket")) { sock = argv[2]; argv += 2; argc -= 2; }
    if (argc >= 3 && !strcmp(argv[1], "--twice")) { g_twice = 1; argv += 1; argc -= 1; }
    if (argc < 2) { fprintf(stderr, "uso: %s --probe [nodo] | [--socket ruta] <archivo> [nodo] [salida.md5]\n", argv[0]); return 2; }
    const char *path = argv[1], *node = argc > 2 ? argv[2] : DEFAULT_NODE;
    g_out = argc > 3 ? fopen(argv[3], "w") : NULL;

    AVFormatContext *fmt = NULL;
    if (avformat_open_input(&fmt, path, NULL, NULL) < 0 || avformat_find_stream_info(fmt, NULL) < 0) {
        fprintf(stderr, "could not open %s\n", path);
        return 1;
    }
    int vi = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (vi < 0) { fprintf(stderr, "no video stream\n"); return 1; }
    AVStream *st = fmt->streams[vi];
    HwDecCodec codec;
    if (map_codec(st->codecpar->codec_id, &codec) != 0) {
        fprintf(stderr, "codec %s has no mapping\n", avcodec_get_name(st->codecpar->codec_id));
        return 1;
    }

    /* H.264/HEVC in mp4 travel in AVCC/HVCC format: Android delivers them in Annex-B. */
    AVBSFContext *bsf = NULL;
    const char *bsf_name = codec == HWDEC_H264 ? "h264_mp4toannexb" : codec == HWDEC_HEVC ? "hevc_mp4toannexb" : NULL;
    if (bsf_name) {
        const AVBitStreamFilter *f = av_bsf_get_by_name(bsf_name);
        if (!f || av_bsf_alloc(f, &bsf) < 0) return 1;
        avcodec_parameters_copy(bsf->par_in, st->codecpar);
        bsf->time_base_in = st->time_base;
        if (av_bsf_init(bsf) < 0) return 1;
    }

    HwDecSession *s = NULL;
    if (sock) g_client = hwdec_client_open(sock, codec);
    else s = hwdec_open(node, codec);
    if (!s && !g_client) { fprintf(stderr, "RESULT: the hardware cannot decode this stream (%s)\n", hwdec_codec_name(codec)); return 3; }

    AVPacket *pkt = av_packet_alloc(), *out = av_packet_alloc();
    long units = 0;
    /* --twice: the file is decoded twice in the SAME session, with an end of stream (drain) in
     * the middle. It is what Android does when it asks to drain halfway through a video: after the drain the
     * decoder has to be able to continue with a new stream. */
    for (int pass = 0; pass < (g_twice ? 2 : 1); pass++) {
        if (pass > 0) {
            av_seek_frame(fmt, vi, 0, AVSEEK_FLAG_BACKWARD);
            if (bsf) av_bsf_flush(bsf);
        }
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
        be_eos(s);
        /* In-process the decoder signals HWDEC_EOF when it finishes; through the socket that signal does not exist (the response
         * to the EOS already carries all the frames), so the queue is drained ONCE. */
        if (g_client) drain(s);
        else while (drain(s) == HWDEC_AGAIN) {}
        if (pass == 0 && g_twice) {
            if (g_client) { /* the daemon restarts the decoder by itself after the EOS */ }
            else hwdec_flush(s);
            if (g_out) fprintf(g_out, "# --- segunda pasada ---\n");
            g_pass1_frames = g_frames;
        }
    }
    if (g_client) hwdec_client_close(g_client); else hwdec_close(s);

    struct rusage ru;
    getrusage(RUSAGE_SELF, &ru);
    double cpu = ru.ru_utime.tv_sec + ru.ru_utime.tv_usec / 1e6 + ru.ru_stime.tv_sec + ru.ru_stime.tv_usec / 1e6;
    printf("RESULTADO: %s %dx%d -> %ld access units, %ld frames decodificados por hardware, cpu=%.2fs%s%s\n",
           hwdec_codec_name(codec), st->codecpar->width, st->codecpar->height, units, g_frames, cpu,
           g_bad ? " (CON ERRORES)" : "",
           (g_twice && g_frames != 2 * g_pass1_frames) ? " (LA SEGUNDA PASADA NO DIO LOS MISMOS FRAMES)" : "");
    if (g_out) fclose(g_out);
    return g_bad ? 1 : 0;
}
