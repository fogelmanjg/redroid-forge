/*
 * Hardware Codec2 decoders (H.264, HEVC, VP9) backed by the host's VA-API daemon,
 * through the hwdec v2 protocol (protocol.h): one persistent session per component.
 *
 * It follows the model of AOSP's software decoders (C2SoftAvcDec, C2SoftHevcDec, C2SoftVpxDec):
 *  - the interface declares what MediaCodec expects from a decoder (output delay, maximum size,
 *    maximum input buffer size, color aspects, pixel format, profiles and levels);
 *  - the decoder may return a frame long after receiving its access unit (B-frames): every
 *    job (C2Work) is left PENDING until its frame comes out, and is completed with finish(index);
 *  - at end of stream the decoder is drained and the jobs that had no frame are completed.
 *
 * Parts adapted from AOSP's external codec2 (Apache-2.0): see the comments in the .cpp.
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
    const char *name;       // name of the Codec2 component
    const char *mediaType;  // MIME type it decodes
    uint32_t wireCodec;     // VAAPI_HWDEC_CODEC_* from protocol.h
    uint32_t defaultDelay;  // initial output delay (frames); H.264/HEVC reorder, VP9 does not
};

const std::vector<VaapiDecCodec> &vaapiDecCodecs();
const VaapiDecCodec *findVaapiDecCodec(const std::string &name);  // nullptr if it does not exist

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
        int64_t pts = 0;  // the frameIndex of the job whose access unit originated this frame
        // The content (compact NV12/P010): in the memory shared with the daemon (valid until the next
        // request to the daemon) or, if there is none, in `owned`.
        const uint8_t *data = nullptr;
        size_t size = 0;
        std::vector<uint8_t> owned;
    };

    // Connection with the daemon. All of them are called with mLock held.
    bool openSessionLocked();
    void unmapShmLocked();
    void closeSessionLocked();
    // A round-trip message: returns the daemon's status (<0 = error or dropped connection).
    int exchangeLocked(uint32_t msg, const uint8_t *data, uint32_t size, int64_t pts,
                       std::vector<Frame> *frames);

    void finishFrame(Frame &frame, const std::unique_ptr<C2Work> &current,
                     const std::shared_ptr<C2BlockPool> &pool);
    void completeEmpty(uint64_t index, const std::unique_ptr<C2Work> &current);
    c2_status_t drainInternal(uint32_t drainMode, const std::shared_ptr<C2BlockPool> &pool,
                              const std::unique_ptr<C2Work> &current);

    std::shared_ptr<VaapiDecInterface> mIntf;
    const VaapiDecCodec *mCodec;

    std::mutex mLock;          // protects the session (socket) with the daemon
    int mSock = -1;
    uint8_t *mShm = nullptr;   // memory shared with the daemon (read-only), or nullptr
    size_t mShmSize = 0;

    bool mSignalledError = false;
    bool mSignalledOutputEos = false;
    uint32_t mWidth = 0, mHeight = 0;  // last output size reported to the framework
    std::set<uint64_t> mPending;       // jobs handed to the decoder whose frame has not come out yet
};

}  // namespace android

#endif  // VAAPI_DEC_CODEC2_COMPONENT_H
