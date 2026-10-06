// Herramienta de prueba (solo desarrollo): decodifica un archivo de video con MediaCodec (API NDK, la
// misma ruta que usa cualquier reproductor) y escribe un CRC32 por frame, en orden de salida, de la
// imagen I420 compacta y recortada. Se compara con `ffmpeg -pix_fmt yuv420p` (ver
// android/test/verify_mediacodec.py), asi se prueba el componente Codec2 por el camino real.
//
//   hwdec_mediacodec_test <archivo> [componente|-] [salida.txt]
//     componente: nombre Codec2 (ej. c2.hardware.decoder.h264, c2.android.avc.decoder) o "-" para
//     que Android elija el decoder por tipo MIME.
//
// Se corre desde /data/local/tmp como shell dentro de la instancia.
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <vector>

#include <media/NdkMediaCodec.h>
#include <media/NdkMediaExtractor.h>
#include <media/NdkMediaFormat.h>

static uint32_t crc_table[256];
static void crc_init() {
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        crc_table[i] = c;
    }
}
static uint32_t crc_update(uint32_t crc, const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) crc = crc_table[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
    return crc;
}

static double now() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "uso: %s <archivo> [componente|-] [salida.txt]\n", argv[0]);
        return 2;
    }
    const char *path = argv[1];
    const char *name = (argc > 2 && strcmp(argv[2], "-") != 0) ? argv[2] : nullptr;
    FILE *out = argc > 3 ? fopen(argv[3], "w") : stdout;
    crc_init();

    int fd = open(path, O_RDONLY);
    if (fd < 0) { perror("open"); return 1; }
    off_t size = lseek(fd, 0, SEEK_END);
    AMediaExtractor *ex = AMediaExtractor_new();
    if (AMediaExtractor_setDataSourceFd(ex, fd, 0, size) != AMEDIA_OK) {
        fprintf(stderr, "no se pudo abrir %s\n", path);
        return 1;
    }
    AMediaFormat *trackFmt = nullptr;
    const char *mime = nullptr;
    for (size_t i = 0; i < AMediaExtractor_getTrackCount(ex); i++) {
        AMediaFormat *f = AMediaExtractor_getTrackFormat(ex, i);
        const char *m = nullptr;
        if (AMediaFormat_getString(f, AMEDIAFORMAT_KEY_MIME, &m) && m && strncmp(m, "video/", 6) == 0) {
            AMediaExtractor_selectTrack(ex, i);
            trackFmt = f;
            mime = m;
            break;
        }
        AMediaFormat_delete(f);
    }
    if (!trackFmt) { fprintf(stderr, "sin pista de video\n"); return 1; }

    AMediaCodec *codec = name ? AMediaCodec_createCodecByName(name) : AMediaCodec_createDecoderByType(mime);
    if (!codec) { fprintf(stderr, "RESULTADO: no se pudo crear el decoder %s\n", name ? name : mime); return 3; }
    // Pide I420 planar (COLOR_FormatYUV420Planar = 19): CCodec convierte si el componente entrega otro layout.
    AMediaFormat_setInt32(trackFmt, AMEDIAFORMAT_KEY_COLOR_FORMAT, 19);
    if (AMediaCodec_configure(codec, trackFmt, nullptr, nullptr, 0) != AMEDIA_OK) {
        fprintf(stderr, "RESULTADO: configure fallo (%s)\n", name ? name : mime);
        return 3;
    }
    if (AMediaCodec_start(codec) != AMEDIA_OK) {
        fprintf(stderr, "RESULTADO: start fallo: el decoder no pudo iniciar (%s)\n", name ? name : mime);
        return 3;
    }

    const double t0 = now();
    bool inputEos = false, outputEos = false;
    long frames = 0, stalls = 0;
    std::vector<uint8_t> packed;
    int32_t stride = 0, sliceH = 0, width = 0, height = 0, cropL = 0, cropT = 0, cropR = 0, cropB = 0;
    auto refresh = [&]() {
        AMediaFormat *f = AMediaCodec_getOutputFormat(codec);
        AMediaFormat_getInt32(f, AMEDIAFORMAT_KEY_WIDTH, &width);
        AMediaFormat_getInt32(f, AMEDIAFORMAT_KEY_HEIGHT, &height);
        if (!AMediaFormat_getInt32(f, AMEDIAFORMAT_KEY_STRIDE, &stride)) stride = width;
        if (!AMediaFormat_getInt32(f, AMEDIAFORMAT_KEY_SLICE_HEIGHT, &sliceH)) sliceH = height;
        cropL = cropT = 0;
        cropR = width - 1;
        cropB = height - 1;
        AMediaFormat_getInt32(f, "crop-left", &cropL);
        AMediaFormat_getInt32(f, "crop-top", &cropT);
        AMediaFormat_getInt32(f, "crop-right", &cropR);
        AMediaFormat_getInt32(f, "crop-bottom", &cropB);
        AMediaFormat_delete(f);
    };

    while (!outputEos) {
        if (!inputEos) {
            ssize_t in = AMediaCodec_dequeueInputBuffer(codec, 2000);
            if (in >= 0) {
                size_t cap = 0;
                uint8_t *buf = AMediaCodec_getInputBuffer(codec, in, &cap);
                ssize_t n = AMediaExtractor_readSampleData(ex, buf, cap);
                if (n < 0) {
                    AMediaCodec_queueInputBuffer(codec, in, 0, 0, 0, AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
                    inputEos = true;
                } else {
                    AMediaCodec_queueInputBuffer(codec, in, 0, n, AMediaExtractor_getSampleTime(ex), 0);
                    AMediaExtractor_advance(ex);
                }
            }
        }
        AMediaCodecBufferInfo info;
        ssize_t oi = AMediaCodec_dequeueOutputBuffer(codec, &info, 2000);
        if (oi >= 0) {
            if (info.size > 0) {
                size_t osz = 0;
                uint8_t *p = AMediaCodec_getOutputBuffer(codec, oi, &osz);
                if (width == 0) refresh();
                const int32_t w = cropR - cropL + 1, h = cropB - cropT + 1;
                const int32_t cs = stride / 2;
                packed.clear();
                packed.reserve((size_t)w * h * 3 / 2);
                for (int32_t r = 0; r < h; r++) {
                    const uint8_t *row = p + (size_t)(cropT + r) * stride + cropL;
                    packed.insert(packed.end(), row, row + w);
                }
                const uint8_t *u = p + (size_t)stride * sliceH;
                const uint8_t *v = u + (size_t)cs * (sliceH / 2);
                for (const uint8_t *pl : {u, v}) {
                    for (int32_t r = 0; r < h / 2; r++) {
                        const uint8_t *row = pl + (size_t)(cropT / 2 + r) * cs + cropL / 2;
                        packed.insert(packed.end(), row, row + w / 2);
                    }
                }
                uint32_t crc = crc_update(0xFFFFFFFFu, packed.data(), packed.size()) ^ 0xFFFFFFFFu;
                fprintf(out, "%ld %lld %dx%d %08x\n", frames, (long long)info.presentationTimeUs, w, h, crc);
                frames++;
            }
            AMediaCodec_releaseOutputBuffer(codec, oi, false);
            if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) outputEos = true;
        } else if (oi == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
            refresh();
        } else if (oi == AMEDIACODEC_INFO_TRY_AGAIN_LATER && inputEos && ++stalls > 2000) {
            fprintf(stderr, "RESULTADO: el decoder dejo de entregar frames sin avisar fin de stream\n");
            break;
        }
    }
    const double dt = now() - t0;
    AMediaCodec_stop(codec);
    AMediaCodec_delete(codec);
    AMediaExtractor_delete(ex);
    fprintf(stderr, "RESULTADO: %s %s -> %ld frames en %.2f s (%.1f fps)%s\n", name ? name : "(por defecto)", mime,
            frames, dt, frames / dt, outputEos ? "" : " (SIN FIN DE STREAM)");
    if (out != stdout) fclose(out);
    return outputEos ? 0 : 1;
}
