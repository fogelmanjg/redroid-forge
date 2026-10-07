/*
 * Reference client of the hwdec v2 protocol (protocol.h): the same contract the Android
 * Codec2 component implements, but in C and with no FFmpeg dependency whatsoever. It is
 * used to test the daemon end to end, and as a reference implementation for the Android
 * side.
 *
 * It reuses HwDecCodec/HwDecFrame/HWDEC_* from hwdec.h (types only; it does not link libavcodec).
 */
#ifndef REDROID_FORGE_HWDEC_CLIENT_H
#define REDROID_FORGE_HWDEC_CLIENT_H

#include "hwdec.h"
#include "protocol.h"

typedef struct HwDecClient HwDecClient;

/* NULL if it could not connect or the daemon rejected the codec (the reason goes to stderr). */
HwDecClient *hwdec_client_open(const char *socket_path, HwDecCodec codec);

/* One access unit. The frames the decoder releases are queued: take them out with
 * hwdec_client_next_frame(). 0 = ok, <0 = error (the frames already decoded are still queued). */
int hwdec_client_send(HwDecClient *c, const uint8_t *data, size_t size, int64_t pts);
int hwdec_client_flush(HwDecClient *c);
int hwdec_client_eos(HwDecClient *c);

/* HWDEC_OK (frame in *out, valid until the next call) or HWDEC_AGAIN (empty queue). */
int hwdec_client_next_frame(HwDecClient *c, HwDecFrame *out);

void hwdec_client_close(HwDecClient *c);

/* Asks the daemon what it decodes in hardware. 0 = ok. */
int hwdec_client_caps(const char *socket_path, HwDecCaps *caps);

#endif
