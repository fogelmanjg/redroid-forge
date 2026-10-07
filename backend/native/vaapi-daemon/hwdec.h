/*
 * Decode por hardware vendor-agnostico (AMD/Intel via VA-API) con libavcodec.
 * Paso 1 del objetivo hwdecode (docs/ROADMAP.md, Fase 2, paso 5).
 *
 * Principios (decididos el 06/10/2026):
 *  - Se usa por hardware TODO lo que el hardware del host ofrezca: hwdec_probe()
 *    pregunta a VA-API que codecs decodifica esta GPU, y hwdec_open() solo
 *    abre sesiones para esos.
 *  - NUNCA hay fallback silencioso a software: si el hardware no puede con el
 *    stream, hwdec_open()/hwdec_receive() fallan, y quien llama (el componente
 *    Codec2 de Android) decide caer a su decoder por software.
 *  - Una sesion = un stream, con estado (referencias, reordenamiento de B-frames).
 *    Cada hwdec_send() entrega UN access unit; hwdec_receive() devuelve los
 *    frames ya reordenados, de a uno, cuando el decoder los libera.
 *
 * En este paso los frames se descargan a memoria de CPU (NV12 / P010 sin padding).
 * El paso 2 sumara la exportacion sin copia (dma-buf) que hace falta para 1080p/4K.
 */
#ifndef REDROID_FORGE_HWDEC_H
#define REDROID_FORGE_HWDEC_H

#include <stddef.h>
#include <stdint.h>

typedef enum {
    HWDEC_H264 = 0,
    HWDEC_HEVC,
    HWDEC_VP9,
    HWDEC_VP8,
    HWDEC_MPEG2,
    HWDEC_VC1,
    HWDEC_AV1,
    HWDEC_NCODECS
} HwDecCodec;

enum { HWDEC_OK = 0, HWDEC_AGAIN = 1, HWDEC_EOF = 2 };  /* negativo = error */
enum { HWDEC_NOSPACE = -1000 };  /* hwdec_receive_to: el frame no entra en el destino dado (se pierde) */

typedef struct {
    int supported[HWDEC_NCODECS];  /* el hardware decodifica este codec (8 bits como minimo) */
    int supported_10bit[HWDEC_NCODECS]; /* ademas decodifica la variante de 10 bits */
    char driver[160];              /* cadena del driver VA-API, solo informativa */
} HwDecCaps;

const char *hwdec_codec_name(HwDecCodec c);

/* Pregunta a VA-API (sin libavcodec) que decodifica el nodo DRM dado. 0 = ok. */
int hwdec_probe(const char *drm_node, HwDecCaps *caps);

typedef struct HwDecSession HwDecSession;

typedef struct {
    uint32_t width, height;
    int is_10bit;       /* 0: NV12 (8 bits), 1: P010 (10 bits en 16) */
    int64_t pts;        /* el pts del access unit de entrada que origino este frame */
    const uint8_t *data; /* NV12/P010 compacto; valido hasta la proxima llamada a hwdec_receive/close */
    size_t size;
} HwDecFrame;

/* NULL si el hardware no soporta el codec o falla algo (el motivo va a stderr). */
HwDecSession *hwdec_open(const char *drm_node, HwDecCodec codec);

/* Un access unit. HWDEC_OK; HWDEC_AGAIN = hay que vaciar con hwdec_receive() y reintentar; <0 error. */
int hwdec_send(HwDecSession *s, const uint8_t *data, size_t size, int64_t pts);

/* Fin de stream: despues hay que seguir llamando hwdec_receive() hasta HWDEC_EOF. */
int hwdec_send_eos(HwDecSession *s);

/* HWDEC_OK (frame en *out), HWDEC_AGAIN (hace falta mas entrada), HWDEC_EOF, o <0. */
int hwdec_receive(HwDecSession *s, HwDecFrame *out);

/* Igual, pero el frame (NV12/P010 compacto) se escribe directamente en `dst` (de `dstcap` bytes) en vez de en el
 * buffer interno de la sesion: out->data == dst. Si no entra devuelve HWDEC_NOSPACE (el frame se pierde). Es lo
 * que permite entregar frames por memoria compartida sin una copia intermedia. */
int hwdec_receive_to(HwDecSession *s, HwDecFrame *out, uint8_t *dst, size_t dstcap);

/* Descarta referencias y salida pendiente (seek / reinicio del stream). */
void hwdec_flush(HwDecSession *s);

void hwdec_close(HwDecSession *s);

#endif
