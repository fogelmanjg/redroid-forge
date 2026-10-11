/* Simulation of the rate controller against a synthetic intra-frame size model
 * (size = complexity * 2^(-qp/6)) with changing content and variable frame timing.
 * Build and run:  cc -O2 -o /tmp/ratectl-test test/ratectl-test.c -I. -lm && /tmp/ratectl-test */
#include <stdio.h>
#include <stdlib.h>
#include "ratectl.h"

static double run(const char *name, uint32_t w, uint32_t h, uint32_t bitrate, double fps, int jitter, double c_lo, double c_hi) {
    RateCtl rc = {0};
    int64_t now = 1000000000LL;
    double total = 0, secs = 0;
    int n = (int)(fps * 30);
    int qp_min = 99, qp_max = 0;
    for (int i = 0; i < n; i++) {
        double dt = 1.0 / fps;
        if (jitter) dt *= 0.4 + 1.2 * (rand() / (double)RAND_MAX);
        now += (int64_t)(dt * 1e9);
        /* the content alternates between "easy" and "hard" every 3 seconds */
        double c = ((int)(secs / 3) % 2) ? c_hi : c_lo;
        c *= 0.9 + 0.2 * (rand() / (double)RAND_MAX);
        int qp = rc_next_qp(&rc, now, bitrate, w, h);
        size_t bytes = (size_t)(c * (double)w * h * pow(2.0, -qp / 6.0));
        rc_frame_done(&rc, now, bytes, qp);
        total += bytes; secs += dt;
        if (i > fps * 2) { if (qp < qp_min) qp_min = qp; if (qp > qp_max) qp_max = qp; }
    }
    double mbps = total * 8 / secs / 1e6;
    printf("%-34s target %5.1f Mbps -> %5.1f Mbps (%+.0f%%), qp %d..%d\n", name, bitrate / 1e6, mbps, (mbps / (bitrate / 1e6) - 1) * 100, qp_min, qp_max);
    return mbps / (bitrate / 1e6);
}

/* The same with a GOP: an IDR every `period` frames and P frames in between (a P frame is p_ratio of the intra size
 * at the same QP, with noise). Returns delivered / asked. */
static double run_gop(const char *name, uint32_t w, uint32_t h, uint32_t bitrate, double fps, int period, double p_ratio,
                      double c_lo, double c_hi) {
    RateCtl rc = {0};
    rc.gop = 1;
    int64_t now = 1000000000LL;
    double total = 0, secs = 0, idr_bytes = 0;
    int n = (int)(fps * 30);
    int qp_min = 99, qp_max = 0, since_idr = period;
    for (int i = 0; i < n; i++) {
        double dt = 1.0 / fps;
        now += (int64_t)(dt * 1e9);
        double c = ((int)(secs / 3) % 2) ? c_hi : c_lo;
        c *= 0.9 + 0.2 * (rand() / (double)RAND_MAX);
        int is_idr = since_idr >= period;
        since_idr = is_idr ? 1 : since_idr + 1;
        int qp = rc_next_qp_t(&rc, now, bitrate, w, h, is_idr);
        size_t bytes = (size_t)(c * (is_idr ? 1.0 : p_ratio * (0.8 + 0.4 * (rand() / (double)RAND_MAX))) * (double)w * h * pow(2.0, -qp / 6.0));
        rc_frame_done_t(&rc, now, bytes, qp, is_idr);
        total += bytes; secs += dt;
        if (is_idr) idr_bytes += bytes;
        if (i > fps * 2) { if (qp < qp_min) qp_min = qp; if (qp > qp_max) qp_max = qp; }
    }
    double mbps = total * 8 / secs / 1e6;
    printf("%-34s target %5.1f Mbps -> %5.1f Mbps (%+.0f%%), qp %d..%d, IDR frames are %.0f%% of the bytes\n", name, bitrate / 1e6, mbps,
           (mbps / (bitrate / 1e6) - 1) * 100, qp_min, qp_max, 100.0 * idr_bytes / total);
    return mbps / (bitrate / 1e6);
}

int main(void) {
    srand(7);
    int bad = 0;
    double r;
    r = run("720p60 steady", 1280, 720, 8000000, 60, 0, 2.0, 2.0); bad += fabs(r - 1) > 0.12;
    r = run("720p60 content changes", 1280, 720, 8000000, 60, 0, 1.0, 4.0); bad += fabs(r - 1) > 0.15;
    r = run("720p variable frame rate", 1280, 720, 8000000, 40, 1, 1.0, 4.0); bad += fabs(r - 1) > 0.15;
    r = run("1080p30 4 Mbps", 1920, 1080, 4000000, 30, 0, 1.0, 3.0); bad += fabs(r - 1) > 0.15;
    r = run("1080p60 20 Mbps", 1920, 1080, 20000000, 60, 1, 1.0, 3.0); bad += fabs(r - 1) > 0.15;
    /* with P frames: the budget has to hold, and the QP must come out well below the all-intra one at the same bitrate */
    r = run_gop("GOP 720p60 8 Mbps, P=20%", 1280, 720, 8000000, 60, 120, 0.2, 2.0, 2.0); bad += fabs(r - 1) > 0.15;
    r = run_gop("GOP 720p60 content changes", 1280, 720, 8000000, 60, 120, 0.2, 1.0, 4.0); bad += fabs(r - 1) > 0.18;
    r = run_gop("GOP 720p60 busy (P=45%)", 1280, 720, 8000000, 60, 120, 0.45, 2.0, 2.0); bad += fabs(r - 1) > 0.15;
    r = run_gop("GOP 1080p30 4 Mbps", 1920, 1080, 4000000, 30, 60, 0.2, 1.0, 3.0); bad += fabs(r - 1) > 0.18;
    printf(bad ? "FAIL\n" : "OK\n");
    return bad;
}
