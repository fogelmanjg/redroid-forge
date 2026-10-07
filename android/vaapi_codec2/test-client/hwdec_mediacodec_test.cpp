// Test tool (development only): decodes a video file with MediaCodec (NDK API, the
// same path any player uses) and writes a CRC32 per frame, in output order, of the
// compact, cropped I420 image. It is compared with `ffmpeg -pix_fmt yuv420p` (see
// android/test/verify_mediacodec.py), which is how the Codec2 component is tested through the real path.
//
//   hwdec_mediacodec_test <file> [component|-] [output.txt]
//     component: Codec2 name (e.g. c2.hardware.decoder.h264, c2.android.avc.decoder) or "-" to
//     let Android pick the decoder by MIME type.
//
// It runs from /data/local/tmp as shell inside the instance.
#include <dlfcn.h>
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
        fprintf(stderr, "usage: %s <file> [component|-] [output.txt]\n", argv[0]);
        return 2;
    }
    const char *path = argv[1];
    const bool noHash = getenv("NO_HASH") != nullptr;  // pure performance, without verifying pixels
    const bool p010 = getenv("OUT_P010") != nullptr;  // ask for P010 (10-bit) and hash the 16-bit samples
    const char *name = (argc > 2 && strcmp(argv[2], "-") != 0) ? argv[2] : nullptr;
    FILE *out = argc > 3 ? fopen(argv[3], "w") : stdout;
    crc_init();

    // Codec2 components notify the client (job done, input buffer released) with
    // INCOMING Binder calls. A real app already has a Binder thread pool (zygote starts it); a
    // native binary like this one does not, and without it no notification ever arrives: the decoder looks "stuck" after
    // filling its first input slots. It is loaded through dlopen so as not to add libbinder_ndk to the Android.bp.
    if (void *bn = dlopen("libbinder_ndk.so", RTLD_NOW)) {
        auto setMax = reinterpret_cast<bool (*)(uint32_t)>(dlsym(bn, "ABinderProcess_setThreadPoolMaxThreadCount"));
        auto start = reinterpret_cast<void (*)()>(dlsym(bn, "ABinderProcess_startThreadPool"));
        if (setMax) setMax(4);
        if (start) start();
    } else {
        fprintf(stderr, "WARNING: could not load libbinder_ndk.so: without Binder threads the decoder notifications do not arrive\n");
    }

    int fd = open(path, O_RDONLY);
    if (fd < 0) { perror("open"); return 1; }
    off_t size = lseek(fd, 0, SEEK_END);
    AMediaExtractor *ex = AMediaExtractor_new();
    if (AMediaExtractor_setDataSourceFd(ex, fd, 0, size) != AMEDIA_OK) {
        fprintf(stderr, "could not open %s\n", path);
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
    if (!trackFmt) { fprintf(stderr, "no video track\n"); return 1; }

    AMediaCodec *codec = name ? AMediaCodec_createCodecByName(name) : AMediaCodec_createDecoderByType(mime);
    if (!codec) { fprintf(stderr, "RESULT: could not create the decoder %s\n", name ? name : mime); return 3; }
    // Asks for planar I420 (COLOR_FormatYUV420Planar = 19): CCodec converts if the component delivers another layout.
    AMediaFormat_setInt32(trackFmt, AMEDIAFORMAT_KEY_COLOR_FORMAT, p010 ? 54 : 19);  // 54 = YUVP010, 19 = I420
    if (AMediaCodec_configure(codec, trackFmt, nullptr, nullptr, 0) != AMEDIA_OK) {
        fprintf(stderr, "RESULTADO: configure fallo (%s)\n", name ? name : mime);
        return 3;
    }
    if (AMediaCodec_start(codec) != AMEDIA_OK) {
        fprintf(stderr, "RESULT: start failed: the decoder could not start (%s)\n", name ? name : mime);
        return 3;
    }

    {   // diagnostics: negotiated formats (number of input slots, buffer size, etc.)
        AMediaFormat *fi = AMediaCodec_getInputFormat(codec);
        AMediaFormat *fo = AMediaCodec_getOutputFormat(codec);
        fprintf(stderr, "FORMATO ENTRADA: %s\nFORMATO SALIDA: %s\n", AMediaFormat_toString(fi), AMediaFormat_toString(fo));
        AMediaFormat_delete(fi);
        AMediaFormat_delete(fo);
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

    long inOk = 0, inBusy = 0, outTry = 0;
    double lastReport = now();
    while (!outputEos) {
        if (now() - lastReport > 3.0) {  // diagnostics: if it gets stuck, show where
            fprintf(stderr, "... inputs queued=%ld no-input-buffer=%ld outputs=%ld no-output=%ld\n", inOk,
                    inBusy, frames, outTry);
            lastReport = now();
            if (now() - t0 > 20.0 && frames == 0) {
                fprintf(stderr, "RESULTADO: SIN FRAMES tras 20 s (decoder trabado?)\n");
                return 4;
            }
        }
        if (!inputEos) {
            ssize_t in = AMediaCodec_dequeueInputBuffer(codec, 2000);
            if (in < 0) inBusy++;
            if (in >= 0) {
                inOk++;
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
                if (noHash) {  // only measure performance: do not pack or hash (the CRC of a 4K frame costs ~10 ms)
                    fprintf(out, "%ld %lld\n", frames, (long long)info.presentationTimeUs);
                    frames++;
                    AMediaCodec_releaseOutputBuffer(codec, oi, false);
                    if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) outputEos = true;
                    continue;
                }
                const int32_t w = cropR - cropL + 1, h = cropB - cropT + 1;
                packed.clear();
                if (p010) {
                    // P010: 16-bit samples; `stride` comes in bytes. Y plane and then interleaved UV.
                    packed.reserve((size_t)w * h * 3);
                    for (int32_t r = 0; r < h; r++) {
                        const uint8_t *row = p + (size_t)(cropT + r) * stride + (size_t)cropL * 2;
                        packed.insert(packed.end(), row, row + (size_t)w * 2);
                    }
                    const uint8_t *uv = p + (size_t)stride * sliceH;
                    for (int32_t r = 0; r < h / 2; r++) {
                        const uint8_t *row = uv + (size_t)(cropT / 2 + r) * stride + (size_t)cropL * 2;
                        packed.insert(packed.end(), row, row + (size_t)w * 2);
                    }
                } else {
                const int32_t cs = stride / 2;
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
                }
                if (frames == 0 && getenv("DUMP_FIRST")) {  // diagnostico: primer frame I420 crudo + parametros
                    if (FILE *d = fopen("raw.yuv", "wb")) { fwrite(p, 1, osz, d); fclose(d); }
                    if (FILE *d = fopen("first.yuv", "wb")) { fwrite(packed.data(), 1, packed.size(), d); fclose(d); }
                    fprintf(stderr, "DUMP: w=%d h=%d stride=%d sliceH=%d crop=[%d,%d,%d,%d] osz=%zu info.size=%d offset=%d\n",
                            w, h, stride, sliceH, cropL, cropT, cropR, cropB, osz, info.size, info.offset);
                }
                uint32_t crc = crc_update(0xFFFFFFFFu, packed.data(), packed.size()) ^ 0xFFFFFFFFu;
                fprintf(out, "%ld %lld %dx%d %08x\n", frames, (long long)info.presentationTimeUs, w, h, crc);
                frames++;
            }
            AMediaCodec_releaseOutputBuffer(codec, oi, false);
            if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) outputEos = true;
        } else if (oi == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
            refresh();
        } else if (oi == AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
            outTry++;
        } else if (oi == AMEDIACODEC_INFO_TRY_AGAIN_LATER && inputEos && ++stalls > 2000) {
            fprintf(stderr, "RESULT: the decoder stopped delivering frames without signaling end of stream\n");
            break;
        }
    }
    const double dt = now() - t0;
    AMediaCodec_stop(codec);
    AMediaCodec_delete(codec);
    AMediaExtractor_delete(ex);
    fprintf(stderr, "RESULT: %s %s -> %ld frames in %.2f s (%.1f fps)%s\n", name ? name : "(default)", mime,
            frames, dt, frames / dt, outputEos ? "" : " (NO END OF STREAM)");
    if (out != stdout) fclose(out);
    return outputEos ? 0 : 1;
}
