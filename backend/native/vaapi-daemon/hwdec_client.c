/* Ver hwdec_client.h. */
#include "hwdec_client.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

struct HwDecClient {
    int fd;
    uint8_t *q;        /* frames recibidos y aun no entregados: [HwDecFrameHeader][bytes]... */
    size_t qlen, qcap, qoff;
};

static int rd(int fd, void *buf, size_t len) {
    size_t got = 0;
    while (got < len) {
        ssize_t n = read(fd, (char *)buf + got, len - got);
        if (n == 0) return -1;
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        got += (size_t)n;
    }
    return 0;
}

static int wr(int fd, const void *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = write(fd, (const char *)buf + sent, len - sent);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        sent += (size_t)n;
    }
    return 0;
}

static int dial(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un a = {0};
    a.sun_family = AF_UNIX;
    strncpy(a.sun_path, path, sizeof(a.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&a, sizeof(a)) != 0) { close(fd); return -1; }
    return fd;
}

HwDecClient *hwdec_client_open(const char *socket_path, HwDecCodec codec) {
    int fd = dial(socket_path);
    if (fd < 0) { perror("hwdec_client: connect"); return NULL; }
    uint32_t tag = VAAPI_CMD_HWDEC;
    HwDecOpenRequest rq = {.codec = (uint32_t)codec};
    HwDecOpenResponse rs;
    if (wr(fd, &tag, sizeof(tag)) || wr(fd, &rq, sizeof(rq)) || rd(fd, &rs, sizeof(rs))) {
        fprintf(stderr, "hwdec_client: el daemon cerro la conexion al abrir (%s)\n", hwdec_codec_name(codec));
        close(fd);
        return NULL;
    }
    if (rs.status != 0) {
        fprintf(stderr, "hwdec_client: el daemon rechazo %s (el hardware no lo decodifica)\n", hwdec_codec_name(codec));
        close(fd);
        return NULL;
    }
    HwDecClient *c = calloc(1, sizeof(*c));
    if (!c) { close(fd); return NULL; }
    c->fd = fd;
    return c;
}

/* Lee la respuesta de un mensaje y deja sus frames en la cola. */
static int read_response(HwDecClient *c) {
    HwDecResponse rs;
    if (rd(c->fd, &rs, sizeof(rs))) return -1;
    if (c->qoff == c->qlen) c->qoff = c->qlen = 0;  /* cola vacia: se reutiliza el buffer */
    for (uint32_t i = 0; i < rs.nframes; i++) {
        HwDecFrameHeader h;
        if (rd(c->fd, &h, sizeof(h))) return -1;
        size_t need = c->qlen + sizeof(h) + h.size;
        if (need > c->qcap) {
            size_t cap = c->qcap ? c->qcap : 1u << 20;
            while (cap < need) cap *= 2;
            uint8_t *nb = realloc(c->q, cap);
            if (!nb) return -1;
            c->q = nb;
            c->qcap = cap;
        }
        memcpy(c->q + c->qlen, &h, sizeof(h));
        if (rd(c->fd, c->q + c->qlen + sizeof(h), h.size)) return -1;
        c->qlen = need;
    }
    return rs.status;
}

static int request(HwDecClient *c, uint32_t msg, const uint8_t *data, uint32_t size, int64_t pts) {
    HwDecRequest rq = {.msg = msg, .size = size, .pts = pts};
    if (wr(c->fd, &rq, sizeof(rq))) return -1;
    if (size && wr(c->fd, data, size)) return -1;
    return read_response(c);
}

int hwdec_client_send(HwDecClient *c, const uint8_t *data, size_t size, int64_t pts) {
    return request(c, VAAPI_HWDEC_MSG_AU, data, (uint32_t)size, pts);
}
int hwdec_client_flush(HwDecClient *c) { return request(c, VAAPI_HWDEC_MSG_FLUSH, NULL, 0, 0); }
int hwdec_client_eos(HwDecClient *c) { return request(c, VAAPI_HWDEC_MSG_EOS, NULL, 0, 0); }

int hwdec_client_next_frame(HwDecClient *c, HwDecFrame *out) {
    if (c->qoff >= c->qlen) return HWDEC_AGAIN;
    HwDecFrameHeader h;
    memcpy(&h, c->q + c->qoff, sizeof(h));
    out->width = h.width;
    out->height = h.height;
    out->is_10bit = (int)h.is_10bit;
    out->pts = h.pts;
    out->size = h.size;
    out->data = c->q + c->qoff + sizeof(h);
    c->qoff += sizeof(h) + h.size;
    return HWDEC_OK;
}

void hwdec_client_close(HwDecClient *c) {
    if (!c) return;
    HwDecRequest rq = {.msg = VAAPI_HWDEC_MSG_CLOSE};
    if (!wr(c->fd, &rq, sizeof(rq))) { HwDecResponse rs; (void)rd(c->fd, &rs, sizeof(rs)); }
    close(c->fd);
    free(c->q);
    free(c);
}

int hwdec_client_caps(const char *socket_path, HwDecCaps *caps) {
    memset(caps, 0, sizeof(*caps));
    int fd = dial(socket_path);
    if (fd < 0) return -1;
    uint32_t tag = VAAPI_CMD_HWDEC_CAPS;
    HwDecCapsResponse rs;
    int bad = wr(fd, &tag, sizeof(tag)) || rd(fd, &rs, sizeof(rs));
    close(fd);
    if (bad || rs.status != 0) return -1;
    for (int i = 0; i < HWDEC_NCODECS; i++) {
        caps->supported[i] = (rs.supported_mask >> i) & 1;
        caps->supported_10bit[i] = (rs.supported_10bit_mask >> i) & 1;
    }
    rs.driver[sizeof(rs.driver) - 1] = 0;
    snprintf(caps->driver, sizeof(caps->driver), "%s", rs.driver);
    return 0;
}
