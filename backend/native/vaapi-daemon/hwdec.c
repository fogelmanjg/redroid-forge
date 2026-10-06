/* Ver hwdec.h. */
#include "hwdec.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>

#include <va/va.h>
#include <va/va_drm.h>

static const char *CODEC_NAMES[HWDEC_NCODECS] = {"h264", "hevc", "vp9", "vp8", "mpeg2", "vc1", "av1"};

const char *hwdec_codec_name(HwDecCodec c) {
    return (c >= 0 && c < HWDEC_NCODECS) ? CODEC_NAMES[c] : "?";
}

static enum AVCodecID codec_id(HwDecCodec c) {
    switch (c) {
    case HWDEC_H264: return AV_CODEC_ID_H264;
    case HWDEC_HEVC: return AV_CODEC_ID_HEVC;
    case HWDEC_VP9: return AV_CODEC_ID_VP9;
    case HWDEC_VP8: return AV_CODEC_ID_VP8;
    case HWDEC_MPEG2: return AV_CODEC_ID_MPEG2VIDEO;
    case HWDEC_VC1: return AV_CODEC_ID_VC1;
    case HWDEC_AV1: return AV_CODEC_ID_AV1;
    default: return AV_CODEC_ID_NONE;
    }
}

/* ---------------------------- probe (solo libva) ---------------------------- */

int hwdec_probe(const char *drm_node, HwDecCaps *caps) {
    memset(caps, 0, sizeof(*caps));
    int fd = open(drm_node, O_RDWR);
    if (fd < 0) { perror("hwdec_probe: open"); return -1; }
    VADisplay dpy = vaGetDisplayDRM(fd);
    int major, minor;
    if (!dpy || vaInitialize(dpy, &major, &minor) != VA_STATUS_SUCCESS) {
        fprintf(stderr, "hwdec_probe: vaInitialize fallo en %s\n", drm_node);
        close(fd);
        return -1;
    }
    const char *vendor = vaQueryVendorString(dpy);
    snprintf(caps->driver, sizeof(caps->driver), "%s", vendor ? vendor : "?");

    int np = vaMaxNumProfiles(dpy);
    VAProfile *profiles = calloc(np, sizeof(*profiles));
    int n = 0;
    if (profiles && vaQueryConfigProfiles(dpy, profiles, &n) == VA_STATUS_SUCCESS) {
        int ne_max = vaMaxNumEntrypoints(dpy);
        VAEntrypoint *eps = calloc(ne_max, sizeof(*eps));
        for (int i = 0; eps && i < n; i++) {
            int ne = 0;
            if (vaQueryConfigEntrypoints(dpy, profiles[i], eps, &ne) != VA_STATUS_SUCCESS) continue;
            int vld = 0;
            for (int j = 0; j < ne; j++) if (eps[j] == VAEntrypointVLD) vld = 1;
            if (!vld) continue;
            switch (profiles[i]) {
            case VAProfileH264ConstrainedBaseline: case VAProfileH264Main: case VAProfileH264High:
                caps->supported[HWDEC_H264] = 1; break;
            case VAProfileHEVCMain: caps->supported[HWDEC_HEVC] = 1; break;
            case VAProfileHEVCMain10: caps->supported[HWDEC_HEVC] = caps->supported_10bit[HWDEC_HEVC] = 1; break;
            case VAProfileVP9Profile0: caps->supported[HWDEC_VP9] = 1; break;
            case VAProfileVP9Profile2: caps->supported[HWDEC_VP9] = caps->supported_10bit[HWDEC_VP9] = 1; break;
            case VAProfileVP8Version0_3: caps->supported[HWDEC_VP8] = 1; break;
            case VAProfileMPEG2Simple: case VAProfileMPEG2Main: caps->supported[HWDEC_MPEG2] = 1; break;
            case VAProfileVC1Simple: case VAProfileVC1Main: case VAProfileVC1Advanced:
                caps->supported[HWDEC_VC1] = 1; break;
            case VAProfileAV1Profile0: caps->supported[HWDEC_AV1] = 1; caps->supported_10bit[HWDEC_AV1] = 1; break;
            default: break;
            }
        }
        free(eps);
    }
    free(profiles);
    vaTerminate(dpy);
    close(fd);
    return 0;
}

/* ------------------------------- sesion ------------------------------------ */

struct HwDecSession {
    HwDecCodec codec;
    AVBufferRef *hw_dev;
    AVCodecContext *ctx;
    AVPacket *pkt;
    AVFrame *frame;
    AVFrame *sw;
    uint8_t *buf;
    size_t cap;
};

static enum AVPixelFormat pick_vaapi(AVCodecContext *ctx, const enum AVPixelFormat *fmts) {
    (void)ctx;
    for (const enum AVPixelFormat *p = fmts; *p != AV_PIX_FMT_NONE; p++)
        if (*p == AV_PIX_FMT_VAAPI) return *p;
    /* Sin VAAPI no hay decode: NO se cae a software en silencio. */
    return AV_PIX_FMT_NONE;
}

static void averr(const char *what, int err) {
    char b[128];
    av_strerror(err, b, sizeof(b));
    fprintf(stderr, "hwdec: %s: %s\n", what, b);
}

HwDecSession *hwdec_open(const char *drm_node, HwDecCodec codec) {
    HwDecCaps caps;
    if (hwdec_probe(drm_node, &caps) != 0) return NULL;
    if (codec < 0 || codec >= HWDEC_NCODECS || !caps.supported[codec]) {
        fprintf(stderr, "hwdec: este hardware no decodifica %s (%s)\n", hwdec_codec_name(codec), caps.driver);
        return NULL;
    }
    const AVCodec *dec = avcodec_find_decoder(codec_id(codec));
    if (!dec) { fprintf(stderr, "hwdec: libavcodec sin decoder para %s\n", hwdec_codec_name(codec)); return NULL; }

    HwDecSession *s = calloc(1, sizeof(*s));
    if (!s) return NULL;
    s->codec = codec;
    int r = av_hwdevice_ctx_create(&s->hw_dev, AV_HWDEVICE_TYPE_VAAPI, drm_node, NULL, 0);
    if (r < 0) { averr("av_hwdevice_ctx_create(VAAPI)", r); goto fail; }
    s->ctx = avcodec_alloc_context3(dec);
    if (!s->ctx) goto fail;
    s->ctx->hw_device_ctx = av_buffer_ref(s->hw_dev);
    s->ctx->get_format = pick_vaapi;
    s->ctx->thread_count = 1; /* el trabajo pesado lo hace la GPU */
    r = avcodec_open2(s->ctx, dec, NULL);
    if (r < 0) { averr("avcodec_open2", r); goto fail; }
    s->pkt = av_packet_alloc();
    s->frame = av_frame_alloc();
    s->sw = av_frame_alloc();
    if (!s->pkt || !s->frame || !s->sw) goto fail;
    return s;
fail:
    hwdec_close(s);
    return NULL;
}

int hwdec_send(HwDecSession *s, const uint8_t *data, size_t size, int64_t pts) {
    av_packet_unref(s->pkt);
    int r = av_new_packet(s->pkt, (int)size);  /* agrega el padding que exige libavcodec */
    if (r < 0) return r;
    memcpy(s->pkt->data, data, size);
    s->pkt->pts = pts;
    s->pkt->dts = pts;
    r = avcodec_send_packet(s->ctx, s->pkt);
    if (r == AVERROR(EAGAIN)) return HWDEC_AGAIN;
    if (r < 0) { averr("avcodec_send_packet", r); return r; }
    return HWDEC_OK;
}

int hwdec_send_eos(HwDecSession *s) {
    int r = avcodec_send_packet(s->ctx, NULL);
    if (r < 0 && r != AVERROR_EOF) { averr("send_eos", r); return r; }
    return HWDEC_OK;
}

int hwdec_receive(HwDecSession *s, HwDecFrame *out) {
    av_frame_unref(s->frame);
    av_frame_unref(s->sw);
    int r = avcodec_receive_frame(s->ctx, s->frame);
    if (r == AVERROR(EAGAIN)) return HWDEC_AGAIN;
    if (r == AVERROR_EOF) return HWDEC_EOF;
    if (r < 0) { averr("avcodec_receive_frame", r); return r; }

    if (s->frame->format != AV_PIX_FMT_VAAPI || !s->frame->hw_frames_ctx) {
        fprintf(stderr, "hwdec: el frame NO vino de VA-API (formato %d): se rechaza, no hay fallback a software\n",
                s->frame->format);
        return -1;
    }
    AVHWFramesContext *fc = (AVHWFramesContext *)s->frame->hw_frames_ctx->data;
    enum AVPixelFormat swfmt = fc->sw_format;  /* NV12 u P010 */
    if (swfmt != AV_PIX_FMT_NV12 && swfmt != AV_PIX_FMT_P010LE) {
        fprintf(stderr, "hwdec: formato de superficie no soportado todavia: %s\n", av_get_pix_fmt_name(swfmt));
        return -1;
    }
    s->sw->format = swfmt;
    r = av_hwframe_transfer_data(s->sw, s->frame, 0);
    if (r < 0) { averr("av_hwframe_transfer_data", r); return r; }

    int w = s->frame->width, h = s->frame->height;
    int need = av_image_get_buffer_size(swfmt, w, h, 1);
    if (need < 0) return need;
    if ((size_t)need > s->cap) {
        uint8_t *nb = realloc(s->buf, need);
        if (!nb) return -1;
        s->buf = nb;
        s->cap = need;
    }
    r = av_image_copy_to_buffer(s->buf, need, (const uint8_t *const *)s->sw->data, s->sw->linesize, swfmt, w, h, 1);
    if (r < 0) return r;
    out->width = w;
    out->height = h;
    out->is_10bit = (swfmt == AV_PIX_FMT_P010LE);
    out->pts = s->frame->pts;
    out->data = s->buf;
    out->size = need;
    return HWDEC_OK;
}

void hwdec_flush(HwDecSession *s) {
    if (s && s->ctx) avcodec_flush_buffers(s->ctx);
}

void hwdec_close(HwDecSession *s) {
    if (!s) return;
    av_packet_free(&s->pkt);
    av_frame_free(&s->frame);
    av_frame_free(&s->sw);
    avcodec_free_context(&s->ctx);
    av_buffer_unref(&s->hw_dev);
    free(s->buf);
    free(s);
}
