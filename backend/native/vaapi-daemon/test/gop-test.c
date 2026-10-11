/* The GOP policy (gop.h). Build and run:  cc -O2 -o /tmp/gop-test test/gop-test.c -I. && /tmp/gop-test */
#include <stdio.h>
#include "gop.h"

static int fails;
#define CHECK(c, msg) do { if (!(c)) { printf("FAIL: %s\n", msg); fails++; } } while (0)

int main(void) {
    GopState g = {0};
    int64_t t = 1000000000LL;
    const int64_t dt = 16666667;

    /* the first frame is an IDR; the next ones are P with frame_num 1, 2, ... referencing the previous surface */
    GopDecision d = gop_next(&g, 10, 1280, 720, t, 120, 0);
    CHECK(d.is_idr && d.frame_num == 0 && d.ref == -1, "first frame is an IDR");
    gop_commit(&g, &d, 10, 1280, 720, t);
    int cur0 = d.cur;
    t += dt;
    d = gop_next(&g, 10, 1280, 720, t, 120, 0);
    CHECK(!d.is_idr && d.frame_num == 1 && d.ref == cur0 && d.cur == (cur0 ^ 1), "second frame is a P frame that references the IDR and writes the other surface");
    CHECK(d.poc == 2 && d.ref_poc == 0 && d.ref_frame_num == 0, "poc/frame numbers of the first P frame");
    gop_commit(&g, &d, 10, 1280, 720, t);

    /* the surfaces alternate and frame_num wraps at 16 without becoming an IDR */
    int idr = 0, last_cur = d.cur;
    for (int i = 2; i < 120; i++) {
        t += dt;
        d = gop_next(&g, 10, 1280, 720, t, 120, 0);
        idr += d.is_idr;
        CHECK(d.cur != last_cur && d.ref == last_cur, "surfaces alternate");
        CHECK(d.frame_num == (unsigned)(i & 15), "frame_num counts modulo 16");
        gop_commit(&g, &d, 10, 1280, 720, t);
        last_cur = d.cur;
    }
    CHECK(idr == 0, "no IDR inside the GOP");
    t += dt;
    d = gop_next(&g, 10, 1280, 720, t, 120, 0);
    CHECK(d.is_idr, "an IDR when the GOP is full (every 120 frames)");
    gop_commit(&g, &d, 10, 1280, 720, t);

    /* stream changes, pauses and failures force an IDR */
    t += dt;
    CHECK(gop_next(&g, 11, 1280, 720, t, 120, 0).is_idr, "another process: IDR");
    CHECK(gop_next(&g, 10, 1920, 1080, t, 120, 0).is_idr, "another size: IDR");
    CHECK(gop_next(&g, 10, 1280, 720, t + 2000000000LL, 120, 0).is_idr, "after a pause longer than 1.5 s: IDR");
    CHECK(gop_next(&g, 10, 1280, 720, t - 2 * dt, 120, 0).is_idr, "time going backwards: IDR");
    CHECK(!gop_next(&g, 10, 1280, 720, t + dt, 120, 0).is_idr, "a normal next frame is not");
    gop_reset(&g);
    CHECK(gop_next(&g, 10, 1280, 720, t + dt, 120, 0).is_idr, "after a failed frame: IDR");

    /* two streams interleaved are all-intra: never a wrong reference */
    GopState g2 = {0};
    int p = 0;
    for (int i = 0; i < 100; i++) {
        pid_t pid = (i & 1) ? 20 : 21;
        t += dt;
        GopDecision x = gop_next(&g2, pid, 1280, 720, t, 120, 0);
        p += !x.is_idr;
        gop_commit(&g2, &x, pid, 1280, 720, t);
    }
    CHECK(p == 0, "interleaved streams never produce a P frame");

    /* the old behaviour is available */
    GopState g3 = {0};
    d = gop_next(&g3, 1, 1280, 720, t, 120, 1);
    gop_commit(&g3, &d, 1, 1280, 720, t);
    CHECK(gop_next(&g3, 1, 1280, 720, t + dt, 120, 1).is_idr, "intra_only: always IDR");
    CHECK(gop_next(&g3, 1, 1280, 720, t + dt, 1, 0).is_idr, "period 1: always IDR");

    printf(fails ? "FAIL\n" : "OK\n");
    return fails != 0;
}
