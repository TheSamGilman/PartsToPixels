/*
 * socket.h — Raw Ethernet interface to the FPGA LED receiver
 *
 * Declares the transport layer for a proprietary protocol that drives
 * LED panels over raw Ethernet (no IP stack). Two packet types:
 *
 *   EtherType 0x5500 — Row data  (7-byte header + RGB pixel payload)
 *   EtherType 0x0107 — Frame commit (98-byte command with brightness)
 *
 * The FPGA receiver's default MAC is 11:22:33:44:55:66. All packets
 * are built and sent via AF_PACKET raw sockets on eth0.
 */

#ifndef SOCKET_H
#define SOCKET_H

#include <stddef.h>
#include <stdint.h>

// ── Protocol constants ──────────────────────────────────────────────

#define DEST_MAC            0x112233445566ULL  /* FPGA receiver default MAC */
#define ROW_ETHER_TYPE      0x5500             /* EtherType for row data packets */
#define FRAME_ETHER_TYPE    0x0107             /* EtherType for frame commit packets */
#define FRAME_DATA_LENGTH   98                 /* Frame commit packet size (bytes) */

// ── Frame commit brightness offsets ─────────────────────────────────
// Byte positions within the 98-byte frame commit payload where
// brightness values are embedded (reverse-engineered from the FPGA
// receiver's protocol).

#define FRAME_BRIGHTNESS_OFFSET     21  /* Global brightness */
#define FRAME_GAMMA_FLAG_OFFSET     22  /* Gamma correction flag (always 5) */
#define FRAME_BRIGHTNESS_R_OFFSET   24  /* Per-channel: red */
#define FRAME_BRIGHTNESS_G_OFFSET   25  /* Per-channel: green */
#define FRAME_BRIGHTNESS_B_OFFSET   26  /* Per-channel: blue */

// ── FPGA row header ─────────────────────────────────────────────────
// 7-byte header prepended to each row's RGB pixel data. Encodes the
// row index, pixel count (big-endian uint16), and protocol flags.

typedef struct __attribute__((packed)) {
  uint8_t  row;           /* Scanline index (0-63) */
  uint8_t  reserved_hi;   /* Always 0 */
  uint8_t  reserved_lo;   /* Always 0 */
  uint8_t  width_hi;      /* Pixel count, high byte */
  uint8_t  width_lo;      /* Pixel count, low byte */
  uint8_t  flags_1;       /* Protocol flag: 0x08 */
  uint8_t  flags_2;       /* Protocol flag: 0x88 */
} fpga_row_header_t;

// ── Public API ──────────────────────────────────────────────────────

extern int  open_socket(void);
extern void close_socket(void);
extern int  send_frame(void);
extern void set_brightness(int brightness);
extern int  send_row(uint8_t *data, size_t len);

#endif /* SOCKET_H */
