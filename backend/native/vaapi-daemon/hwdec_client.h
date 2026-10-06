/*
 * Cliente de referencia del protocolo hwdec v2 (protocol.h): el mismo contrato que
 * implementara el componente Codec2 de Android (paso 3), pero en C y sin ninguna
 * dependencia de FFmpeg. Sirve para probar el daemon de punta a punta, y como
 * implementacion de referencia para el lado Android.
 *
 * Reusa HwDecCodec/HwDecFrame/HWDEC_* de hwdec.h (solo tipos; no enlaza libavcodec).
 */
#ifndef REDROID_FORGE_HWDEC_CLIENT_H
#define REDROID_FORGE_HWDEC_CLIENT_H

#include "hwdec.h"
#include "protocol.h"

typedef struct HwDecClient HwDecClient;

/* NULL si no se pudo conectar o el daemon rechazo el codec (motivo a stderr). */
HwDecClient *hwdec_client_open(const char *socket_path, HwDecCodec codec);

/* Un access unit. Los frames que libere el decoder quedan en cola: sacarlos con
 * hwdec_client_next_frame(). 0 = ok, <0 = error (los frames ya decodificados igual quedan en cola). */
int hwdec_client_send(HwDecClient *c, const uint8_t *data, size_t size, int64_t pts);
int hwdec_client_flush(HwDecClient *c);
int hwdec_client_eos(HwDecClient *c);

/* HWDEC_OK (frame en *out, valido hasta la proxima llamada) o HWDEC_AGAIN (cola vacia). */
int hwdec_client_next_frame(HwDecClient *c, HwDecFrame *out);

void hwdec_client_close(HwDecClient *c);

/* Pregunta al daemon que decodifica por hardware. 0 = ok. */
int hwdec_client_caps(const char *socket_path, HwDecCaps *caps);

#endif
