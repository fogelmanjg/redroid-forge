//#define LOG_NDEBUG 0
#define LOG_TAG "VaapiDecComponent"

#include "VaapiDecComponent.h"

#include <errno.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#include <stdio.h>

#include <algorithm>

#include <system/graphics.h>

#include <C2Buffer.h>
#include <C2Config.h>
#include <log/log.h>
#include <media/stagefright/MediaDefs.h>
#include <util/C2InterfaceHelper.h>

#include "protocol.h"

namespace android {

namespace {

constexpr size_t kMinInputBufferSize = 2 * 1024 * 1024;
// Cap on the output delay: AVC allows up to 16 reordering frames (AOSP's decoder
// goes up to 34 because it supports interlacing); HEVC up to 16.
constexpr uint32_t kMaxOutputDelay = 34;
// If more jobs than this are pending, the oldest one is considered dropped by the decoder.
constexpr size_t kMaxPending = 24;
constexpr uint32_t kMaxAccessUnit = 32u * 1024 * 1024;  // same cap as the daemon
constexpr int kSocketTimeoutSec = 10;

// redroid's gralloc allocator aligns the pitch to 256 bytes, but the layout C2 deduces from a
// YV12 block assumes 16: with 1920 (real pitch 2048) the framework read the rows with another step and
// 128 bytes of zeros per row came out. Asking for the width already aligned to 256 makes both match.
uint32_t alignPitch(uint32_t v) { return (v + 255) & ~255u; }

const std::vector<VaapiDecCodec> kCodecs = {
    {"c2.hardware.decoder.h264", MEDIA_MIMETYPE_VIDEO_AVC, VAAPI_HWDEC_CODEC_H264, 8},
    {"c2.hardware.decoder.hevc", MEDIA_MIMETYPE_VIDEO_HEVC, VAAPI_HWDEC_CODEC_HEVC, 8},
    {"c2.hardware.decoder.vp9", MEDIA_MIMETYPE_VIDEO_VP9, VAAPI_HWDEC_CODEC_VP9, 0},
};

bool readAll(int fd, void *buf, size_t len) {
    size_t got = 0;
    while (got < len) {
        ssize_t n = read(fd, static_cast<char *>(buf) + got, len - got);
        if (n == 0) return false;
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        got += static_cast<size_t>(n);
    }
    return true;
}

bool writeAll(int fd, const void *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = write(fd, static_cast<const char *>(buf) + sent, len - sent);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        sent += static_cast<size_t>(n);
    }
    return true;
}


// Reads the HwDecOpenResponse; if it carries an attached fd (SCM_RIGHTS) it leaves it in *fd, otherwise -1.
bool recvOpenResponse(int sock, HwDecOpenResponse *resp, int *fd) {
    *fd = -1;
    struct iovec iov = {.iov_base = resp, .iov_len = sizeof(*resp)};
    union {
        struct cmsghdr align;
        char buf[CMSG_SPACE(sizeof(int))];
    } u;
    memset(&u, 0, sizeof(u));
    struct msghdr msg = {};
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    msg.msg_control = u.buf;
    msg.msg_controllen = sizeof(u.buf);
    ssize_t n;
    do { n = recvmsg(sock, &msg, MSG_CMSG_CLOEXEC); } while (n < 0 && errno == EINTR);
    if (n <= 0) return false;
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len >= CMSG_LEN(sizeof(int))) {
            memcpy(fd, CMSG_DATA(c), sizeof(int));
        }
    }
    // A split response (it does not happen with an 8-byte datagram) is completed by reading the rest.
    size_t got = static_cast<size_t>(n);
    return got == sizeof(*resp) || readAll(sock, reinterpret_cast<char *>(resp) + got, sizeof(*resp) - got);
}

// Marks a job as finished without an image (SPS/PPS parameters, dropped jobs, EOS).
void fillEmptyWork(const std::unique_ptr<C2Work> &work) {
    uint32_t flags = 0;
    if (work->input.flags & C2FrameData::FLAG_END_OF_STREAM) {
        flags |= C2FrameData::FLAG_END_OF_STREAM;
    }
    work->worklets.front()->output.flags = static_cast<C2FrameData::flags_t>(flags);
    work->worklets.front()->output.buffers.clear();
    work->worklets.front()->output.ordinal = work->input.ordinal;
    work->workletsProcessed = 1u;
}

}  // namespace

const std::vector<VaapiDecCodec> &vaapiDecCodecs() { return kCodecs; }

const VaapiDecCodec *findVaapiDecCodec(const std::string &name) {
    for (const auto &c : kCodecs) {
        if (name == c.name) return &c;
    }
    return nullptr;
}

// ------------------------------------------------------------------------------------------
// Interface: adapted from C2SoftAvcDec::IntfImpl / C2SoftHevcDec / C2SoftVpxDec (AOSP, Apache-2.0).
// ------------------------------------------------------------------------------------------

VaapiDecInterface::VaapiDecInterface(const std::shared_ptr<C2ReflectorHelper> &helper,
                                     const VaapiDecCodec *codec)
    : SimpleInterface<void>::BaseParams(helper, codec->name, C2Component::KIND_DECODER,
                                        C2Component::DOMAIN_VIDEO, codec->mediaType) {
    noPrivateBuffers();
    noInputReferences();
    noOutputReferences();
    noInputLatency();
    noTimeStretch();

    addParameter(DefineParam(mActualOutputDelay, C2_PARAMKEY_OUTPUT_DELAY)
                         .withDefault(new C2PortActualDelayTuning::output(codec->defaultDelay))
                         .withFields({C2F(mActualOutputDelay, value).inRange(0, kMaxOutputDelay)})
                         .withSetter(Setter<decltype(*mActualOutputDelay)>::StrictValueWithNoDeps)
                         .build());

    addParameter(DefineParam(mAttrib, C2_PARAMKEY_COMPONENT_ATTRIBUTES)
                         .withConstValue(new C2ComponentAttributesSetting(
                                 C2Component::ATTRIB_IS_TEMPORAL))
                         .build());

    addParameter(DefineParam(mSize, C2_PARAMKEY_PICTURE_SIZE)
                         .withDefault(new C2StreamPictureSizeInfo::output(0u, 320, 240))
                         .withFields({
                                 C2F(mSize, width).inRange(2, 4096, 2),
                                 C2F(mSize, height).inRange(2, 4096, 2),
                         })
                         .withSetter(SizeSetter)
                         .build());

    // Output pixel format. 8 bits only (420_888): P010 is NOT offered. On redroid, gralloc blows up
    // (SIGFPE in gralloc_gbm_bo_create, inside the allocator service) when allocating a P010 buffer, and since the
    // allocator is critical, the whole of Android restarts. IMPLEMENTATION_DEFINED is there so that the framework
    // can tell the surface mode apart, just like in AOSP's software decoders.
    addParameter(DefineParam(mPixelFormat, C2_PARAMKEY_PIXEL_FORMAT)
                         .withDefault(new C2StreamPixelFormatInfo::output(
                                 0u, HAL_PIXEL_FORMAT_YCBCR_420_888))
                         .withFields({C2F(mPixelFormat, value).oneOf({
                                 HAL_PIXEL_FORMAT_YCBCR_420_888,
                                 HAL_PIXEL_FORMAT_IMPLEMENTATION_DEFINED})})
                         .withSetter(Setter<decltype(*mPixelFormat)>::StrictValueWithNoDeps)
                         .build());

    addParameter(DefineParam(mMaxSize, C2_PARAMKEY_MAX_PICTURE_SIZE)
                         .withDefault(new C2StreamMaxPictureSizeTuning::output(0u, 320, 240))
                         .withFields({
                                 C2F(mSize, width).inRange(2, 4096, 2),
                                 C2F(mSize, height).inRange(2, 4096, 2),
                         })
                         .withSetter(MaxPictureSizeSetter, mSize)
                         .build());

    // Profiles and levels: those of AOSP's software decoders plus the 10-bit ones (HEVC Main10,
    // VP9 profile 2), which is what HDR uses. If the host hardware does not decode them, the session fails on open.
    switch (codec->wireCodec) {
    case VAAPI_HWDEC_CODEC_H264:
        addParameter(
                DefineParam(mProfileLevel, C2_PARAMKEY_PROFILE_LEVEL)
                        .withDefault(new C2StreamProfileLevelInfo::input(
                                0u, C2Config::PROFILE_AVC_CONSTRAINED_BASELINE,
                                C2Config::LEVEL_AVC_5_2))
                        .withFields({
                                C2F(mProfileLevel, profile).oneOf({
                                        C2Config::PROFILE_AVC_CONSTRAINED_BASELINE,
                                        C2Config::PROFILE_AVC_BASELINE,
                                        C2Config::PROFILE_AVC_MAIN,
                                        C2Config::PROFILE_AVC_CONSTRAINED_HIGH,
                                        C2Config::PROFILE_AVC_PROGRESSIVE_HIGH,
                                        C2Config::PROFILE_AVC_HIGH}),
                                C2F(mProfileLevel, level).oneOf({
                                        C2Config::LEVEL_AVC_1, C2Config::LEVEL_AVC_1B,
                                        C2Config::LEVEL_AVC_1_1, C2Config::LEVEL_AVC_1_2,
                                        C2Config::LEVEL_AVC_1_3, C2Config::LEVEL_AVC_2,
                                        C2Config::LEVEL_AVC_2_1, C2Config::LEVEL_AVC_2_2,
                                        C2Config::LEVEL_AVC_3, C2Config::LEVEL_AVC_3_1,
                                        C2Config::LEVEL_AVC_3_2, C2Config::LEVEL_AVC_4,
                                        C2Config::LEVEL_AVC_4_1, C2Config::LEVEL_AVC_4_2,
                                        C2Config::LEVEL_AVC_5, C2Config::LEVEL_AVC_5_1,
                                        C2Config::LEVEL_AVC_5_2}),
                        })
                        .withSetter(ProfileLevelSetter, mSize)
                        .build());
        break;
    case VAAPI_HWDEC_CODEC_HEVC:
        addParameter(
                DefineParam(mProfileLevel, C2_PARAMKEY_PROFILE_LEVEL)
                        .withDefault(new C2StreamProfileLevelInfo::input(
                                0u, C2Config::PROFILE_HEVC_MAIN, C2Config::LEVEL_HEVC_MAIN_5_1))
                        .withFields({
                                C2F(mProfileLevel, profile).oneOf({
                                        C2Config::PROFILE_HEVC_MAIN,
                                        C2Config::PROFILE_HEVC_MAIN_STILL,
                                        C2Config::PROFILE_HEVC_MAIN_10}),
                                C2F(mProfileLevel, level).oneOf({
                                        C2Config::LEVEL_HEVC_MAIN_1, C2Config::LEVEL_HEVC_MAIN_2,
                                        C2Config::LEVEL_HEVC_MAIN_2_1, C2Config::LEVEL_HEVC_MAIN_3,
                                        C2Config::LEVEL_HEVC_MAIN_3_1, C2Config::LEVEL_HEVC_MAIN_4,
                                        C2Config::LEVEL_HEVC_MAIN_4_1, C2Config::LEVEL_HEVC_MAIN_5,
                                        C2Config::LEVEL_HEVC_MAIN_5_1, C2Config::LEVEL_HEVC_MAIN_5_2,
                                        C2Config::LEVEL_HEVC_HIGH_4, C2Config::LEVEL_HEVC_HIGH_4_1,
                                        C2Config::LEVEL_HEVC_HIGH_5, C2Config::LEVEL_HEVC_HIGH_5_1,
                                        C2Config::LEVEL_HEVC_HIGH_5_2}),
                        })
                        .withSetter(ProfileLevelSetter, mSize)
                        .build());
        break;
    default:  // VP9
        addParameter(
                DefineParam(mProfileLevel, C2_PARAMKEY_PROFILE_LEVEL)
                        .withDefault(new C2StreamProfileLevelInfo::input(
                                0u, C2Config::PROFILE_VP9_0, C2Config::LEVEL_VP9_5))
                        .withFields({
                                C2F(mProfileLevel, profile).oneOf({C2Config::PROFILE_VP9_0, C2Config::PROFILE_VP9_2}),
                                C2F(mProfileLevel, level).oneOf({
                                        C2Config::LEVEL_VP9_1, C2Config::LEVEL_VP9_1_1,
                                        C2Config::LEVEL_VP9_2, C2Config::LEVEL_VP9_2_1,
                                        C2Config::LEVEL_VP9_3, C2Config::LEVEL_VP9_3_1,
                                        C2Config::LEVEL_VP9_4, C2Config::LEVEL_VP9_4_1,
                                        C2Config::LEVEL_VP9_5}),
                        })
                        .withSetter(ProfileLevelSetter, mSize)
                        .build());
        break;
    }

    addParameter(DefineParam(mMaxInputSize, C2_PARAMKEY_INPUT_MAX_BUFFER_SIZE)
                         .withDefault(new C2StreamMaxBufferSizeInfo::input(0u, kMinInputBufferSize))
                         .withFields({C2F(mMaxInputSize, value).any()})
                         .calculatedAs(MaxInputSizeSetter, mMaxSize)
                         .build());

    std::shared_ptr<C2StreamColorInfo::output> defaultColorInfo =
            C2StreamColorInfo::output::AllocShared({C2ChromaOffsetStruct::ITU_YUV_420_0()}, 0u,
                                                   8u /* bitDepth */, C2Color::YUV_420);
    helper->addStructDescriptors<C2ChromaOffsetStruct>();
    addParameter(DefineParam(mColorInfo, C2_PARAMKEY_CODED_COLOR_INFO)
                         .withConstValue(defaultColorInfo)
                         .build());

    addParameter(
            DefineParam(mDefaultColorAspects, C2_PARAMKEY_DEFAULT_COLOR_ASPECTS)
                    .withDefault(new C2StreamColorAspectsTuning::output(
                            0u, C2Color::RANGE_UNSPECIFIED, C2Color::PRIMARIES_UNSPECIFIED,
                            C2Color::TRANSFER_UNSPECIFIED, C2Color::MATRIX_UNSPECIFIED))
                    .withFields({
                            C2F(mDefaultColorAspects, range)
                                    .inRange(C2Color::RANGE_UNSPECIFIED, C2Color::RANGE_OTHER),
                            C2F(mDefaultColorAspects, primaries)
                                    .inRange(C2Color::PRIMARIES_UNSPECIFIED,
                                             C2Color::PRIMARIES_OTHER),
                            C2F(mDefaultColorAspects, transfer)
                                    .inRange(C2Color::TRANSFER_UNSPECIFIED,
                                             C2Color::TRANSFER_OTHER),
                            C2F(mDefaultColorAspects, matrix)
                                    .inRange(C2Color::MATRIX_UNSPECIFIED, C2Color::MATRIX_OTHER),
                    })
                    .withSetter(DefaultColorAspectsSetter)
                    .build());

    addParameter(
            DefineParam(mCodedColorAspects, C2_PARAMKEY_VUI_COLOR_ASPECTS)
                    .withDefault(new C2StreamColorAspectsInfo::input(
                            0u, C2Color::RANGE_LIMITED, C2Color::PRIMARIES_UNSPECIFIED,
                            C2Color::TRANSFER_UNSPECIFIED, C2Color::MATRIX_UNSPECIFIED))
                    .withFields({
                            C2F(mCodedColorAspects, range)
                                    .inRange(C2Color::RANGE_UNSPECIFIED, C2Color::RANGE_OTHER),
                            C2F(mCodedColorAspects, primaries)
                                    .inRange(C2Color::PRIMARIES_UNSPECIFIED,
                                             C2Color::PRIMARIES_OTHER),
                            C2F(mCodedColorAspects, transfer)
                                    .inRange(C2Color::TRANSFER_UNSPECIFIED,
                                             C2Color::TRANSFER_OTHER),
                            C2F(mCodedColorAspects, matrix)
                                    .inRange(C2Color::MATRIX_UNSPECIFIED, C2Color::MATRIX_OTHER),
                    })
                    .withSetter(CodedColorAspectsSetter)
                    .build());

    addParameter(
            DefineParam(mColorAspects, C2_PARAMKEY_COLOR_ASPECTS)
                    .withDefault(new C2StreamColorAspectsInfo::output(
                            0u, C2Color::RANGE_UNSPECIFIED, C2Color::PRIMARIES_UNSPECIFIED,
                            C2Color::TRANSFER_UNSPECIFIED, C2Color::MATRIX_UNSPECIFIED))
                    .withFields({
                            C2F(mColorAspects, range)
                                    .inRange(C2Color::RANGE_UNSPECIFIED, C2Color::RANGE_OTHER),
                            C2F(mColorAspects, primaries)
                                    .inRange(C2Color::PRIMARIES_UNSPECIFIED,
                                             C2Color::PRIMARIES_OTHER),
                            C2F(mColorAspects, transfer)
                                    .inRange(C2Color::TRANSFER_UNSPECIFIED,
                                             C2Color::TRANSFER_OTHER),
                            C2F(mColorAspects, matrix)
                                    .inRange(C2Color::MATRIX_UNSPECIFIED, C2Color::MATRIX_OTHER),
                    })
                    .withSetter(ColorAspectsSetter, mDefaultColorAspects, mCodedColorAspects)
                    .build());

    addParameter(DefineParam(mPixelFormat, C2_PARAMKEY_PIXEL_FORMAT)
                         .withConstValue(new C2StreamPixelFormatInfo::output(
                                 0u, HAL_PIXEL_FORMAT_YCBCR_420_888))
                         .build());
}

C2R VaapiDecInterface::SizeSetter(bool mayBlock, const C2P<C2StreamPictureSizeInfo::output> &oldMe,
                                  C2P<C2StreamPictureSizeInfo::output> &me) {
    (void)mayBlock;
    C2R res = C2R::Ok();
    if (!me.F(me.v.width).supportsAtAll(me.v.width)) {
        res = res.plus(C2SettingResultBuilder::BadValue(me.F(me.v.width)));
        me.set().width = oldMe.v.width;
    }
    if (!me.F(me.v.height).supportsAtAll(me.v.height)) {
        res = res.plus(C2SettingResultBuilder::BadValue(me.F(me.v.height)));
        me.set().height = oldMe.v.height;
    }
    return res;
}

C2R VaapiDecInterface::MaxPictureSizeSetter(bool mayBlock,
                                            C2P<C2StreamMaxPictureSizeTuning::output> &me,
                                            const C2P<C2StreamPictureSizeInfo::output> &size) {
    (void)mayBlock;
    me.set().width = c2_min(c2_max(me.v.width, size.v.width), 4096u);
    me.set().height = c2_min(c2_max(me.v.height, size.v.height), 4096u);
    return C2R::Ok();
}

C2R VaapiDecInterface::MaxInputSizeSetter(bool mayBlock, C2P<C2StreamMaxBufferSizeInfo::input> &me,
                                          const C2P<C2StreamMaxPictureSizeTuning::output> &maxSize) {
    (void)mayBlock;
    me.set().value = c2_max((((maxSize.v.width + 15) / 16) * ((maxSize.v.height + 15) / 16) * 192),
                            kMinInputBufferSize);
    return C2R::Ok();
}

C2R VaapiDecInterface::ProfileLevelSetter(bool mayBlock, C2P<C2StreamProfileLevelInfo::input> &me,
                                          const C2P<C2StreamPictureSizeInfo::output> &size) {
    (void)mayBlock;
    (void)size;
    (void)me;
    return C2R::Ok();
}

C2R VaapiDecInterface::DefaultColorAspectsSetter(bool mayBlock,
                                                 C2P<C2StreamColorAspectsTuning::output> &me) {
    (void)mayBlock;
    if (me.v.range > C2Color::RANGE_OTHER) me.set().range = C2Color::RANGE_OTHER;
    if (me.v.primaries > C2Color::PRIMARIES_OTHER) me.set().primaries = C2Color::PRIMARIES_OTHER;
    if (me.v.transfer > C2Color::TRANSFER_OTHER) me.set().transfer = C2Color::TRANSFER_OTHER;
    if (me.v.matrix > C2Color::MATRIX_OTHER) me.set().matrix = C2Color::MATRIX_OTHER;
    return C2R::Ok();
}

C2R VaapiDecInterface::CodedColorAspectsSetter(bool mayBlock,
                                               C2P<C2StreamColorAspectsInfo::input> &me) {
    (void)mayBlock;
    if (me.v.range > C2Color::RANGE_OTHER) me.set().range = C2Color::RANGE_OTHER;
    if (me.v.primaries > C2Color::PRIMARIES_OTHER) me.set().primaries = C2Color::PRIMARIES_OTHER;
    if (me.v.transfer > C2Color::TRANSFER_OTHER) me.set().transfer = C2Color::TRANSFER_OTHER;
    if (me.v.matrix > C2Color::MATRIX_OTHER) me.set().matrix = C2Color::MATRIX_OTHER;
    return C2R::Ok();
}

C2R VaapiDecInterface::ColorAspectsSetter(bool mayBlock, C2P<C2StreamColorAspectsInfo::output> &me,
                                          const C2P<C2StreamColorAspectsTuning::output> &def,
                                          const C2P<C2StreamColorAspectsInfo::input> &coded) {
    (void)mayBlock;
    me.set().range = coded.v.range == C2Color::RANGE_UNSPECIFIED ? def.v.range : coded.v.range;
    me.set().primaries = coded.v.primaries == C2Color::PRIMARIES_UNSPECIFIED ? def.v.primaries
                                                                             : coded.v.primaries;
    me.set().transfer = coded.v.transfer == C2Color::TRANSFER_UNSPECIFIED ? def.v.transfer
                                                                          : coded.v.transfer;
    me.set().matrix = coded.v.matrix == C2Color::MATRIX_UNSPECIFIED ? def.v.matrix : coded.v.matrix;
    return C2R::Ok();
}

// ------------------------------------------------------------------------------------------
// Componente
// ------------------------------------------------------------------------------------------

VaapiDecComponent::VaapiDecComponent(const char *name, c2_node_id_t id,
                                     const std::shared_ptr<VaapiDecInterface> &intf,
                                     const VaapiDecCodec *codec)
    : SimpleC2Component(std::make_shared<SimpleInterface<VaapiDecInterface>>(name, id, intf)),
      mIntf(intf),
      mCodec(codec) {}

VaapiDecComponent::~VaapiDecComponent() {
    std::lock_guard<std::mutex> lock(mLock);
    closeSessionLocked();
}

void VaapiDecComponent::unmapShmLocked() {
    if (mShm) {
        munmap(mShm, mShmSize);
        mShm = nullptr;
        mShmSize = 0;
    }
}

bool VaapiDecComponent::openSessionLocked() {
    if (mSock >= 0) return true;
    unmapShmLocked();  // leftover of a session that fell over
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        ALOGE("socket() failed: %s", strerror(errno));
        return false;
    }
    struct timeval tv = {kSocketTimeoutSec, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    struct sockaddr_un addr = {};
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, VAAPI_DAEMON_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    if (connect(fd, reinterpret_cast<struct sockaddr *>(&addr), sizeof(addr)) != 0) {
        ALOGE("connect(%s) failed: %s", VAAPI_DAEMON_SOCKET_PATH, strerror(errno));
        close(fd);
        return false;
    }

    uint32_t tag = VAAPI_CMD_HWDEC;
    HwDecOpenRequest req = {};
    req.codec = mCodec->wireCodec;
    req.flags = VAAPI_HWDEC_OPEN_SHM;  // frames through shared memory if the daemon can
    HwDecOpenResponse resp = {};
    int shmFd = -1;
    if (!writeAll(fd, &tag, sizeof(tag)) || !writeAll(fd, &req, sizeof(req)) ||
        !recvOpenResponse(fd, &resp, &shmFd)) {
        ALOGE("hwdec open: the daemon closed the connection");
        close(fd);
        return false;
    }
    if (resp.status != 0) {
        if (shmFd >= 0) close(shmFd);
        // There is no software fallback here: whoever calls (MediaCodec/the player) picks another decoder.
        ALOGE("the daemon refused to open a %s session (status %d): this hardware cannot decode it",
              mCodec->mediaType, resp.status);
        close(fd);
        return false;
    }
    if (resp.shm_mib != 0 && shmFd >= 0) {
        const size_t size = static_cast<size_t>(resp.shm_mib) << 20;
        void *m = mmap(nullptr, size, PROT_READ, MAP_SHARED, shmFd, 0);
        if (m == MAP_FAILED) {
            // The daemon already offered the shared memory: without being able to map it, that mode cannot go on.
            ALOGE("mmap of the shared frame memory failed: %s", strerror(errno));
            close(shmFd);
            close(fd);
            return false;
        }
        mShm = static_cast<uint8_t *>(m);
        mShmSize = size;
    } else if (resp.shm_mib != 0) {
        ALOGE("the daemon announced shared memory but sent no fd");
        close(fd);
        return false;
    }
    if (shmFd >= 0) close(shmFd);  // the mapping stays valid without the fd
    mSock = fd;
    ALOGI("hwdec session open for %s%s", mCodec->name, mShm ? " (shared memory)" : "");
    return true;
}

void VaapiDecComponent::closeSessionLocked() {
    if (mSock < 0) {
        unmapShmLocked();
        return;
    }
    HwDecRequest req = {};
    req.msg = VAAPI_HWDEC_MSG_CLOSE;
    HwDecResponse resp = {};
    if (writeAll(mSock, &req, sizeof(req))) readAll(mSock, &resp, sizeof(resp));
    close(mSock);
    mSock = -1;
    unmapShmLocked();
}

int VaapiDecComponent::exchangeLocked(uint32_t msg, const uint8_t *data, uint32_t size, int64_t pts,
                                      std::vector<Frame> *frames) {
    if (mSock < 0) return -1;
    HwDecRequest req = {};
    req.msg = msg;
    req.size = size;
    req.pts = pts;
    if (!writeAll(mSock, &req, sizeof(req)) || (size && !writeAll(mSock, data, size))) {
        ALOGE("hwdec: write to the daemon failed: %s", strerror(errno));
        close(mSock);
        mSock = -1;
        return -1;
    }
    HwDecResponse resp = {};
    if (!readAll(mSock, &resp, sizeof(resp))) {
        ALOGE("hwdec: reading the response failed: %s", strerror(errno));
        close(mSock);
        mSock = -1;
        return -1;
    }
    size_t shmOff = 0;
    for (uint32_t i = 0; i < resp.nframes; i++) {
        HwDecFrameHeader h = {};
        if (!readAll(mSock, &h, sizeof(h)) || h.size > (1u << 30)) {
            ALOGE("hwdec: reading a frame header failed");
            close(mSock);
            mSock = -1;
            return -1;
        }
        Frame f;
        f.width = h.width;
        f.height = h.height;
        f.tenBit = h.is_10bit != 0;
        f.pts = h.pts;
        f.size = h.size;
        if (mShm) {
            // The response frames are in the shared memory, one after another, each one aligned.
            if (shmOff + h.size > mShmSize) {
                ALOGE("hwdec: frame outside the shared memory (off=%zu size=%u)", shmOff, h.size);
                close(mSock);
                mSock = -1;
                return -1;
            }
            f.data = mShm + shmOff;
            shmOff += (static_cast<size_t>(h.size) + VAAPI_HWDEC_SHM_ALIGN - 1) / VAAPI_HWDEC_SHM_ALIGN *
                      VAAPI_HWDEC_SHM_ALIGN;
        } else {
            f.owned.resize(h.size);
            if (!readAll(mSock, f.owned.data(), h.size)) {
                ALOGE("hwdec: reading a frame body failed");
                close(mSock);
                mSock = -1;
                return -1;
            }
            f.data = f.owned.data();
        }
        if (frames) frames->push_back(std::move(f));
    }
    return resp.status;
}

c2_status_t VaapiDecComponent::onInit() {
    // The session is opened HERE and not at the first frame: if this hardware does not decode the codec,
    // MediaCodec fails on start and the player falls back cleanly to another decoder, instead of breaking
    // halfway through the video.
    std::lock_guard<std::mutex> lock(mLock);
    mSignalledError = false;
    mSignalledOutputEos = false;
    mPending.clear();
    mWidth = mHeight = 0;
    return openSessionLocked() ? C2_OK : C2_NOT_FOUND;
}

c2_status_t VaapiDecComponent::onStop() {
    std::lock_guard<std::mutex> lock(mLock);
    closeSessionLocked();
    mPending.clear();
    return C2_OK;
}

void VaapiDecComponent::onReset() {
    std::lock_guard<std::mutex> lock(mLock);
    closeSessionLocked();
    mPending.clear();
}

void VaapiDecComponent::onRelease() {
    std::lock_guard<std::mutex> lock(mLock);
    closeSessionLocked();
    mPending.clear();
}

c2_status_t VaapiDecComponent::onFlush_sm() {
    std::lock_guard<std::mutex> lock(mLock);
    std::vector<Frame> dropped;
    if (mSock >= 0) exchangeLocked(VAAPI_HWDEC_MSG_FLUSH, nullptr, 0, 0, &dropped);
    mPending.clear();
    mSignalledOutputEos = false;
    return C2_OK;
}

void VaapiDecComponent::completeEmpty(uint64_t index, const std::unique_ptr<C2Work> &current) {
    mPending.erase(index);
    if (current && c2_cntr64_t(index) == current->input.ordinal.frameIndex) {
        fillEmptyWork(current);
    } else {
        finish(index, [](const std::unique_ptr<C2Work> &w) {
            fillEmptyWork(w);
            w->result = C2_OK;
        });
    }
}

void VaapiDecComponent::finishFrame(Frame &frame, const std::unique_ptr<C2Work> &current,
                                    const std::shared_ptr<C2BlockPool> &pool) {
    const uint64_t index = static_cast<uint64_t>(frame.pts);
    mPending.erase(index);

    // Output size: the framework is told before the first frame and on every change.
    std::shared_ptr<C2Param> sizeUpdate;
    if (frame.width != mWidth || frame.height != mHeight) {
        C2StreamPictureSizeInfo::output size(0u, frame.width, frame.height);
        std::vector<std::unique_ptr<C2SettingResult>> failures;
        if (mIntf->config({&size}, C2_MAY_BLOCK, &failures) != C2_OK) {
            ALOGE("cannot set the output picture size");
            mSignalledError = true;
            return;
        }
        sizeUpdate.reset(C2Param::Copy(size).release());
        mWidth = frame.width;
        mHeight = frame.height;
    }

    // Output format: always 8-bit YV12. With 10-bit input (HEVC Main10, VP9 profile 2) it
    // keeps the high 8 bits of each sample, like AOSP's software decoders when there is no P010.
    // P010 support is NOT queried (getHalPixelFormatForBitDepth10 / isHalPixelFormatSupported
    // allocate a test buffer): on redroid that kills the gralloc allocator and restarts Android.
    const uint32_t format = HAL_PIXEL_FORMAT_YV12;

    std::shared_ptr<C2GraphicBlock> block;
    C2MemoryUsage usage = {C2MemoryUsage::CPU_READ, C2MemoryUsage::CPU_WRITE};
    // redroid's gralloc allocator aligns the pitch to 256 bytes (see alignPitch).
    c2_status_t err = pool->fetchGraphicBlock(alignPitch(frame.width), frame.height, format, usage, &block);
    if (err != C2_OK) {
        ALOGE("fetchGraphicBlock for the output failed: %d", err);
        mSignalledError = true;
        return;
    }
    {
        C2GraphicView wView = block->map().get();
        if (wView.error() != C2_OK) {
            ALOGE("output graphic view map failed: %d", wView.error());
            mSignalledError = true;
            return;
        }
        // The daemon delivers compact NV12 (8-bit) or P010 (10-bit), without padding; the block has the
        // layout gralloc gave it, so it is copied plane by plane according to rowInc/colInc
        // (just like C2SoftVpxDec).
        const uint32_t w = frame.width, h = frame.height;
        const uint8_t *src = frame.data;
        uint8_t *dstY = const_cast<uint8_t *>(wView.data()[C2PlanarLayout::PLANE_Y]);
        uint8_t *dstU = const_cast<uint8_t *>(wView.data()[C2PlanarLayout::PLANE_U]);
        uint8_t *dstV = const_cast<uint8_t *>(wView.data()[C2PlanarLayout::PLANE_V]);
        C2PlanarLayout layout = wView.layout();
        const size_t dstYStride = layout.planes[C2PlanarLayout::PLANE_Y].rowInc;
        const size_t dstUStride = layout.planes[C2PlanarLayout::PLANE_U].rowInc;
        const size_t dstVStride = layout.planes[C2PlanarLayout::PLANE_V].rowInc;
        const int32_t dstUColInc = layout.planes[C2PlanarLayout::PLANE_U].colInc;
        const int32_t dstVColInc = layout.planes[C2PlanarLayout::PLANE_V].colInc;

        if (frame.tenBit) {
            // 10 bits but the consumer asked for 8: it keeps the high 8 bits of each sample.
            const uint16_t *srcY = reinterpret_cast<const uint16_t *>(src);
            const uint16_t *srcUv = srcY + static_cast<size_t>(w) * h;
            for (uint32_t y = 0; y < h; y++) {
                uint8_t *dst = dstY + y * dstYStride;
                const uint16_t *row = srcY + static_cast<size_t>(y) * w;
                for (uint32_t x = 0; x < w; x++) dst[x] = static_cast<uint8_t>(row[x] >> 8);
            }
            for (uint32_t y = 0; y < h / 2; y++) {
                const uint16_t *row = srcUv + static_cast<size_t>(y) * w;
                uint8_t *dstURow = dstU + y * dstUStride;
                uint8_t *dstVRow = dstV + y * dstVStride;
                for (uint32_t x = 0; x < w / 2; x++) {
                    dstURow[x * dstUColInc] = static_cast<uint8_t>(row[x * 2 + 0] >> 8);
                    dstVRow[x * dstVColInc] = static_cast<uint8_t>(row[x * 2 + 1] >> 8);
                }
            }
        } else {
            const uint8_t *srcUv = src + static_cast<size_t>(w) * h;
            for (uint32_t y = 0; y < h; y++) {
                memcpy(dstY + y * dstYStride, src + static_cast<size_t>(y) * w, w);
            }
            for (uint32_t y = 0; y < h / 2; y++) {
                const uint8_t *row = srcUv + static_cast<size_t>(y) * w;
                uint8_t *dstURow = dstU + y * dstUStride;
                uint8_t *dstVRow = dstV + y * dstVStride;
                for (uint32_t x = 0; x < w / 2; x++) {
                    dstURow[x * dstUColInc] = row[x * 2 + 0];
                    dstVRow[x * dstVColInc] = row[x * 2 + 1];
                }
            }
        }
    }

    std::shared_ptr<C2Buffer> buffer = createGraphicBuffer(std::move(block),
                                                           C2Rect(frame.width, frame.height));
    {
        auto lock = mIntf->lock();
        buffer->setInfo(mIntf->getColorAspects_l());
    }

    auto fillWork = [buffer, sizeUpdate](const std::unique_ptr<C2Work> &w) {
        w->worklets.front()->output.flags = static_cast<C2FrameData::flags_t>(0);
        w->worklets.front()->output.buffers.clear();
        w->worklets.front()->output.buffers.push_back(buffer);
        w->worklets.front()->output.ordinal = w->input.ordinal;
        if (sizeUpdate) w->worklets.front()->output.configUpdate.push_back(C2Param::Copy(*sizeUpdate));
        w->workletsProcessed = 1u;
        w->result = C2_OK;
    };
    if (current && c2_cntr64_t(index) == current->input.ordinal.frameIndex) {
        fillWork(current);
    } else {
        finish(index, fillWork);
    }
}

c2_status_t VaapiDecComponent::drainInternal(uint32_t drainMode,
                                             const std::shared_ptr<C2BlockPool> &pool,
                                             const std::unique_ptr<C2Work> &current) {
    if (drainMode == NO_DRAIN) {
        ALOGW("drain with NO_DRAIN: no-op");
        return C2_OK;
    }
    if (drainMode == DRAIN_CHAIN) {
        ALOGW("DRAIN_CHAIN not supported");
        return C2_OMITTED;
    }

    std::vector<Frame> frames;
    int status;
    {
        std::lock_guard<std::mutex> lock(mLock);
        status = exchangeLocked(VAAPI_HWDEC_MSG_EOS, nullptr, 0, 0, &frames);
    }
    for (Frame &f : frames) finishFrame(f, current, pool);
    // After draining, any job that is still pending had no image (the decoder dropped it).
    std::set<uint64_t> leftovers;
    leftovers.swap(mPending);
    for (uint64_t index : leftovers) completeEmpty(index, current);
    if (status < 0) {
        mSignalledError = true;
        return C2_CORRUPTED;
    }
    return C2_OK;
}

c2_status_t VaapiDecComponent::drain(uint32_t drainMode, const std::shared_ptr<C2BlockPool> &pool) {
    return drainInternal(drainMode, pool, nullptr);
}

void VaapiDecComponent::process(const std::unique_ptr<C2Work> &work,
                                const std::shared_ptr<C2BlockPool> &pool) {
    work->result = C2_OK;
    work->workletsProcessed = 0u;
    work->worklets.front()->output.flags = work->input.flags;

    if (mSignalledError || mSignalledOutputEos) {
        work->result = C2_BAD_VALUE;
        return;
    }

    const bool eos = (work->input.flags & C2FrameData::FLAG_END_OF_STREAM) != 0;
    const bool config = (work->input.flags & C2FrameData::FLAG_CODEC_CONFIG) != 0;
    const uint64_t index = work->input.ordinal.frameIndex.peekull();

    size_t inSize = 0;
    C2ReadView rView = mDummyReadView;
    if (!work->input.buffers.empty()) {
        rView = work->input.buffers[0]->data().linearBlocks().front().map().get();
        inSize = rView.capacity();
        if (inSize && rView.error()) {
            ALOGE("input read view map failed: %d", rView.error());
            work->result = rView.error();
            work->workletsProcessed = 1u;
            return;
        }
    }

    bool sentPicture = false;  // this job left an access unit in the decoder waiting for its frame
    if (inSize > 0) {
        if (inSize > kMaxAccessUnit) {
            ALOGE("access unit too large: %zu", inSize);
            mSignalledError = true;
            work->result = C2_CORRUPTED;
            work->workletsProcessed = 1u;
            return;
        }
        std::vector<Frame> frames;
        int status;
        {
            std::lock_guard<std::mutex> lock(mLock);
            // The parameters (SPS/PPS/VPS) travel as CONFIG: the daemon prepends them to the next access
            // unit (libavcodec rejects an H.264 packet that carries no slice).
            status = exchangeLocked(config ? VAAPI_HWDEC_MSG_CONFIG : VAAPI_HWDEC_MSG_AU, rView.data(),
                                    static_cast<uint32_t>(inSize), static_cast<int64_t>(index), &frames);
        }
        if (status < 0 && frames.empty()) {
            ALOGE("the daemon failed decoding an access unit (status %d)", status);
            mSignalledError = true;
            work->result = C2_CORRUPTED;
            work->workletsProcessed = 1u;
            return;
        }
        // The configuration parameters (SPS/PPS/VPS) produce no image: no frame is awaited.
        if (!config) {
            mPending.insert(index);
            sentPicture = true;
        }
        for (Frame &f : frames) {
            finishFrame(f, work, pool);
            if (mSignalledError) {
                work->result = C2_CORRUPTED;
                work->workletsProcessed = 1u;
                return;
            }
        }
        // If the decoder holds back more jobs than is reasonable, the oldest one was dropped.
        while (mPending.size() > kMaxPending) completeEmpty(*mPending.begin(), work);
    }

    if (eos) {
        drainInternal(DRAIN_COMPONENT_WITH_EOS, pool, work);
        mSignalledOutputEos = true;
        if (work->workletsProcessed == 0u) fillEmptyWork(work);
    } else if (!sentPicture && work->workletsProcessed == 0u) {
        fillEmptyWork(work);  // empty input or only parameters: there is nothing to wait for
    }
    work->input.buffers.clear();
}

}  // namespace android
