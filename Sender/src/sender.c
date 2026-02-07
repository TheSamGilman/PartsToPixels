/*
 * sender.c — Real-time frame sender for FPGA LED controller
 *
 * This program bridges a Node.js animation engine ("player") to an FPGA
 * receiver card driving a 320x64 LED matrix. The player renders
 * frames at 240 FPS using GSAP timelines on a 2D canvas and pushes raw RGBA
 * pixel buffers onto a Redis list. This program pops each frame, converts it
 * to the FPGA row protocol, and transmits it over raw Ethernet — no IP
 * stack, no UDP, just Layer 2 frames straight to the FPGA.
 *
 * Achieving 240 FPS means each frame budget is ~4.167 ms. The timing loop uses
 * a hybrid sleep/spin-wait strategy:
 *
 *   1. If more than 200 us remain, usleep() for (remaining - 100 us).
 *      This yields the CPU to the OS and avoids burning cycles needlessly.
 *
 *   2. For the final ~100-200 us, spin on CLOCK_MONOTONIC_RAW until the
 *      deadline. This avoids the kernel's minimum sleep granularity (~50-100 us)
 *      and delivers consistent sub-10 us jitter on the frame commit.
 *
 * The binary is pinned to a single CPU core via taskset (see ./start) and
 * compiled with -O3 -march=native -flto. It requires CAP_NET_RAW to open
 * the raw socket.
 *
 * Protocol overview (see socket.c for packet construction):
 *   - 64 row packets   (EtherType 0x5500) — one per scanline, 7-byte header + RGB data
 *   - 1  frame packet  (EtherType 0x0107) — commit signal with brightness, triggers display
 *
 * Data flow:
 *   Player (Node.js)  —RGBA buffer—>  Redis (BLPOP)  —>  sender  —raw Ethernet—>  FPGA
 */

#include "socket.h"
#include <hiredis/hiredis.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// ── Constants ───────────────────────────────────────────────────────

#define BILLION 1000000000L
#define BYTES_PER_PIXEL 4              /* RGBA from the player's canvas */
#define FPS 240                        /* Target refresh rate */
#define FPS_SLEEP (1.0 / FPS)          /* ~4.167 ms frame budget */
#define ROW_HEADER_SIZE 7              /* FPGA row header bytes (see fpga_row_header_t) */
#define REDIS_BLPOP_KEY "player:frames"
#define REDIS_SOCKET "/var/run/redis/redis-server.sock"
#define SENDER_BRIGHTNESS_KEY "sender:brightness"
#define SIGN_WIDTH 320                 /* Pixels per row */
#define SIGN_HEIGHT 64                 /* Rows (scanlines) */
#define SLEEP_THRESHOLD_S 0.000200     /* Below this, spin-wait only (200 us) */
#define SLEEP_MARGIN_S 0.000100        /* Wake early by this amount (100 us) */

// ── Signal handling ─────────────────────────────────────────────────

volatile sig_atomic_t running = 1;

void sig_handler(int signum) { running = 0; }

// ── Timing ──────────────────────────────────────────────────────────

/** Returns elapsed time in seconds (nanosecond resolution). */
double get_time_diff(struct timespec started_at, struct timespec ended_at) {
  long seconds = ended_at.tv_sec - started_at.tv_sec;
  long nanoseconds = ended_at.tv_nsec - started_at.tv_nsec;
  return seconds + nanoseconds / (double)BILLION;
}

// ── Redis ───────────────────────────────────────────────────────────

/** Connect to Redis via Unix socket, retrying every second until success. */
redisContext *connect_to_redis(const char *path) {
  redisContext *c;
  do {
    c = redisConnectUnix(path);
    if (c == NULL || c->err) {
      if (c) {
        fprintf(stderr, "ERROR: Redis connection: %s\n", c->errstr);
        redisFree(c);
      } else {
        fprintf(stderr, "ERROR: Redis allocation.\n");
      }
      sleep(1);
    }
  } while (c == NULL || c->err);
  return c;
}

// ── Frame processing ────────────────────────────────────────────────

/*
 * Pop one RGBA frame from Redis, convert to RGB row packets, and send all 64
 * rows to the FPGA. Returns 0 on success, -1 if no frame was available
 * or the connection broke.
 *
 * The two Redis commands are pipelined into a single round-trip:
 *   BLPOP player:frames 1   — blocks up to 1 s for the next frame
 *   GET sender:brightness    — non-blocking read of current brightness
 */
int process_and_send_frame(redisContext *rc, uint8_t *payload, size_t payload_len) {
  redisAppendCommand(rc, "BLPOP %s %d", REDIS_BLPOP_KEY, 1);
  redisAppendCommand(rc, "GET %s", SENDER_BRIGHTNESS_KEY);

  redisReply *rr_blpop = NULL;
  redisReply *rr_brightness = NULL;

  if (redisGetReply(rc, (void **)&rr_blpop) != REDIS_OK ||
      redisGetReply(rc, (void **)&rr_brightness) != REDIS_OK) {
    if (rr_blpop) freeReplyObject(rr_blpop);
    if (rr_brightness) freeReplyObject(rr_brightness);
    return -1;
  }

  /* Apply brightness from Redis (0-255), passed through to the frame commit packet. */
  if (rr_brightness && rr_brightness->type == REDIS_REPLY_STRING) {
    int brightness = atoi(rr_brightness->str);
    if (brightness >= 0 && brightness <= 255) {
      set_brightness(brightness);
    }
  }
  if (rr_brightness) freeReplyObject(rr_brightness);

  /* No frame available (BLPOP timed out). */
  if (!rr_blpop || rr_blpop->type == REDIS_REPLY_NIL) {
    if (rr_blpop) freeReplyObject(rr_blpop);
    return -1;
  }

  const unsigned char *matrix_str = (const unsigned char *)rr_blpop->element[1]->str;
  size_t matrix_len = rr_blpop->element[1]->len;
  size_t expected_len = SIGN_WIDTH * SIGN_HEIGHT * BYTES_PER_PIXEL;

  if (matrix_len != expected_len) {
    fprintf(stderr, "Invalid matrix: expected %zu, got %zu\n", expected_len, matrix_len);
    freeReplyObject(rr_blpop);
    return -1;
  }

  /*
   * Encode and transmit 64 row packets. Each row has a 7-byte FPGA
   * header followed by 320 RGB triplets (960 bytes). The player's canvas
   * stores pixels as BGRA, so we reorder to RGB here.
   */
  const unsigned char *src = matrix_str;
  for (int row = 0; row < SIGN_HEIGHT; row++) {
    /* Build the FPGA row header using the packed struct from socket.h */
    fpga_row_header_t *hdr = (fpga_row_header_t *)payload;
    hdr->row         = row;
    hdr->reserved_hi = 0;
    hdr->reserved_lo = 0;
    hdr->width_hi    = (SIGN_WIDTH >> 8);
    hdr->width_lo    = (SIGN_WIDTH & 0xFF);
    hdr->flags_1     = 0x08;
    hdr->flags_2     = 0x88;

    /* BGRA → RGB conversion, one pixel at a time */
    uint8_t *pixel_data = payload + ROW_HEADER_SIZE;
    for (int col = 0; col < SIGN_WIDTH; col++) {
      *pixel_data++ = src[2]; /* R */
      *pixel_data++ = src[1]; /* G */
      *pixel_data++ = src[0]; /* B */
      src += BYTES_PER_PIXEL;
    }
    send_row(payload, payload_len);
  }

  freeReplyObject(rr_blpop);
  return 0;
}

// ── Main loop ───────────────────────────────────────────────────────

int main() {
  signal(SIGINT, sig_handler);
  signal(SIGTERM, sig_handler);

  redisContext *rc = connect_to_redis(REDIS_SOCKET);

  /* Default brightness to max if no key exists yet. */
  redisReply *rr_check = redisCommand(rc, "GET %s", SENDER_BRIGHTNESS_KEY);
  if (!rr_check || rr_check->type == REDIS_REPLY_NIL) {
    redisReply *rr_set = redisCommand(rc, "SET %s %d", SENDER_BRIGHTNESS_KEY, 255);
    if (rr_set) freeReplyObject(rr_set);
  }
  if (rr_check) freeReplyObject(rr_check);

  open_socket();

  /* Pre-allocate a reusable row buffer: 7-byte header + 320 pixels * 3 bytes RGB. */
  const size_t payload_length = ROW_HEADER_SIZE + SIGN_WIDTH * 3;
  uint8_t *payload = malloc(payload_length);
  if (payload == NULL) {
    fprintf(stderr, "Failed to allocate payload memory.\n");
    redisFree(rc);
    return 1;
  }

  int sends = 0;
  struct timespec start_time, send_started;
  clock_gettime(CLOCK_MONOTONIC_RAW, &start_time);
  clock_gettime(CLOCK_MONOTONIC_RAW, &send_started);

  while (running) {
    if (process_and_send_frame(rc, payload, payload_length) != 0) {
      if (!running) break;
      usleep(100); /* Queue empty — back off to avoid pegging the CPU. */
      continue;
    }

    /*
     * Hybrid wait: sleep while there's enough remaining time for the kernel
     * to wake us accurately, then spin-wait through the final microseconds.
     * CLOCK_MONOTONIC_RAW is immune to NTP adjustments, giving us a stable
     * reference that won't jump or smear.
     */
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC_RAW, &now);
    double elapsed_time_s = get_time_diff(send_started, now);

    while (elapsed_time_s < FPS_SLEEP) {
      double remaining = FPS_SLEEP - elapsed_time_s;

      /* Sleep phase: yield CPU while > 200 us remain, waking 100 us early. */
      if (remaining > SLEEP_THRESHOLD_S) {
        useconds_t us = (useconds_t)((remaining - SLEEP_MARGIN_S) * 1e6);
        if (us > 0) usleep(us);
      }

      /* Spin phase: tight poll until the exact deadline. */
      clock_gettime(CLOCK_MONOTONIC_RAW, &now);
      elapsed_time_s = get_time_diff(send_started, now);
    }

    /* Mark the new frame boundary and tell the FPGA to latch the row data. */
    clock_gettime(CLOCK_MONOTONIC_RAW, &send_started);
    send_frame();

    /* Print actual FPS every 240 frames (once per second at target rate). */
    sends++;
    if (sends % FPS == 0) {
      struct timespec current_time;
      clock_gettime(CLOCK_MONOTONIC_RAW, &current_time);
      double total_diff = get_time_diff(start_time, current_time);
      printf("FPS: %d | Actual: %.4f\n", FPS, sends / total_diff);
      clock_gettime(CLOCK_MONOTONIC_RAW, &start_time);
      sends = 0;
    }
  }

  free(payload);
  close_socket();
  redisFree(rc);
  printf("Sender shutdown.\n");
  return 0;
}
