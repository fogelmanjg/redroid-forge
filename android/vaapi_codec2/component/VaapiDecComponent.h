/*
 * Decoders Codec2 por hardware (H.264, HEVC, VP9) respaldados por el daemon VA-API del host,
 * a traves del protocolo hwdec v2 (protocol.h): una sesion persistente por componente.
 *
 * Sigue el modelo de los decoders por software de AOSP (C2SoftAvcDec, C2SoftHevcDec, C2SoftVpxDec):
 *  - la interfaz declara lo que MediaCodec espera de un decoder (demora de salida, tamano maximo,
 *    tamano maximo del buffer de entrada, aspectos de color, formato de pixel, perfiles y niveles);
 *  - el decoder puede devolver un frame mucho despues de recibir su access unit (B-frames): cada
 *    trabajo (C2Work) se deja PENDIENTE hasta que su frame sale, y se completa con finish(indice);
 *  - al fin de stream se vacia el decoder y se completan los trabajos que no tuvieron frame.
 *
 * Partes adaptadas de external codec2 de AOSP (Apache-2.0): ver los comentarios en el .cpp.
 */
#ifndef VAAPI_DEC_CODEC2_COMPONENT_H
#define VAAPI_DEC_CODEC2_COMPONENT_H

#include <SimpleC2Component.h>
#include <SimpleC2Interface.h>
#include <C2Config.h>

#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace android {

struct VaapiDecCodec {
    const char *name;       // nombre del componente Codec2
    const char *mediaType;  // tipo MIME que decodifica
    uint32_t wireCodec;     // VAAPI_HWDEC_CODEC_* de protocol.h
    uint32_t defaultDelay;  // demora de salida inicial (frames); H.264/HEVC reordenan, VP9 no
};

const std::vector<VaapiDecCodec> &vaapiDecCodecs();
const VaapiDecCodec *findVaapiDecCodec(const std::string &name);  // nullptr si no existe

class VaapiDecInterface : public SimpleInterface<void>::BaseParams {
public:
    VaapiDecInterface(const std::shared_ptr<C2ReflectorHelper> &helper, const VaapiDecCodec *codec);

    uint32_t width() const { return mSize->width; }
    uint32_t height() const { return mSize->height; }
    std::shared_ptr<C2StreamColorAspectsInfo::output> getColorAspects_l() { return mColorAspects; }

private:
    static C2R SizeSetter(bool mayBlock, const C2P<C2StreamPictureSizeInfo::output> &oldMe,
                          C2P<C2StreamPictureSizeInfo::output> &me);
    static C2R MaxPictureSizeSetter(bool mayBlock, C2P<C2StreamMaxPictureSizeTuning::output> &me,
                                    const C2P<C2StreamPictureSizeInfo::output> &size);
    static C2R MaxInputSizeSetter(bool mayBlock, C2P<C2StreamMaxBufferSizeInfo::input> &me,
                                  const C2P<C2StreamMaxPictureSizeTuning::output> &maxSize);
    static C2R ProfileLevelSetter(bool mayBlock, C2P<C2StreamProfileLevelInfo::input> &me,
                                  const C2P<C2StreamPictureSizeInfo::output> &size);
    static C2R DefaultColorAspectsSetter(bool mayBlock, C2P<C2StreamColorAspectsTuning::output> &me);
    static C2R CodedColorAspectsSetter(bool mayBlock, C2P<C2StreamColorAspectsInfo::input> &me);
    static C2R ColorAspectsSetter(bool mayBlock, C2P<C2StreamColorAspectsInfo::output> &me,
                                  const C2P<C2StreamColorAspectsTuning::output> &def,
                                  const C2P<C2StreamColorAspectsInfo::input> &coded);

    std::shared_ptr<C2StreamProfileLevelInfo::input> mProfileLevel;
    std::shared_ptr<C2StreamPictureSizeInfo::output> mSize;
    std::shared_ptr<C2StreamMaxPictureSizeTuning::output> mMaxSize;
    std::shared_ptr<C2StreamMaxBufferSizeInfo::input> mMaxInputSize;
    std::shared_ptr<C2StreamColorInfo::output> mColorInfo;
    std::shared_ptr<C2StreamColorAspectsInfo::input> mCodedColorAspects;
    std::shared_ptr<C2StreamColorAspectsTuning::output> mDefaultColorAspects;
    std::shared_ptr<C2StreamColorAspectsInfo::output> mColorAspects;
    std::shared_ptr<C2StreamPixelFormatInfo::output> mPixelFormat;
};

class VaapiDecComponent : public SimpleC2Component {
public:
    VaapiDecComponent(const char *name, c2_node_id_t id,
                      const std::shared_ptr<VaapiDecInterface> &intf, const VaapiDecCodec *codec);
    ~VaapiDecComponent() override;

    // SimpleC2Component
    c2_status_t onInit() override;
    c2_status_t onStop() override;
    void onReset() override;
    void onRelease() override;
    c2_status_t onFlush_sm() override;
    void process(const std::unique_ptr<C2Work> &work,
                 const std::shared_ptr<C2BlockPool> &pool) override;
    c2_status_t drain(uint32_t drainMode, const std::shared_ptr<C2BlockPool> &pool) override;

private:
    struct Frame {
        uint32_t width = 0, height = 0;
        bool tenBit = false;
        int64_t pts = 0;  // el frameIndex del trabajo cuyo access unit origino este frame
        // El contenido (NV12/P010 compacto): en la memoria compartida con el daemon (valido hasta el proximo
        // pedido al daemon) o, si no hay, en `owned`.
        const uint8_t *data = nullptr;
        size_t size = 0;
        std::vector<uint8_t> owned;
    };

    // Conexion con el daemon. Todas se llaman con mLock tomado.
    bool openSessionLocked();
    void unmapShmLocked();
    void closeSessionLocked();
    // Un mensaje de ida y vuelta: devuelve el status del daemon (<0 = error o conexion caida).
    int exchangeLocked(uint32_t msg, const uint8_t *data, uint32_t size, int64_t pts,
                       std::vector<Frame> *frames);

    void finishFrame(Frame &frame, const std::unique_ptr<C2Work> &current,
                     const std::shared_ptr<C2BlockPool> &pool);
    void completeEmpty(uint64_t index, const std::unique_ptr<C2Work> &current);
    c2_status_t drainInternal(uint32_t drainMode, const std::shared_ptr<C2BlockPool> &pool,
                              const std::unique_ptr<C2Work> &current);

    std::shared_ptr<VaapiDecInterface> mIntf;
    const VaapiDecCodec *mCodec;

    std::mutex mLock;          // protege la sesion (socket) con el daemon
    int mSock = -1;
    uint8_t *mShm = nullptr;   // memoria compartida con el daemon (solo lectura), o nullptr
    size_t mShmSize = 0;

    bool mSignalledError = false;
    bool mSignalledOutputEos = false;
    uint32_t mWidth = 0, mHeight = 0;  // ultimo tamano de salida informado al framework
    std::set<uint64_t> mPending;       // trabajos entregados al decoder cuyo frame aun no salio
};

}  // namespace android

#endif  // VAAPI_DEC_CODEC2_COMPONENT_H
