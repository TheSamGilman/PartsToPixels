/*
 * socket.c — Raw Ethernet transport for FPGA LED controller
 *
 * The FPGA receiver card is an FPGA-based LED controller commonly used in
 * large LED panels. It speaks a proprietary protocol over raw Ethernet (no IP).
 * This module opens an AF_PACKET raw socket on eth0 and builds Ethernet frames
 * by hand — source/destination MAC, EtherType, and payload.
 *
 * Two packet types drive the display:
 *
 *   EtherType 0x5500 — Row data
 *     Sent once per scanline (64 times per frame). Payload is a 7-byte header
 *     (row index, pixel count, protocol flags) followed by raw RGB pixel data.
 *
 *   EtherType 0x0107 — Frame commit
 *     Sent once per frame after all rows. A fixed 98-byte command packet with
 *     brightness values embedded at specific offsets. This tells the FPGA to
 *     latch the accumulated row data and push it to the LEDs.
 *
 * The destination MAC 11:22:33:44:55:66 is the FPGA receiver's default address.
 */

#include "socket.h"
#include <arpa/inet.h>
#include <linux/if_packet.h>
#include <net/if.h>
#include <netinet/ether.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

// ── Internal constants ──────────────────────────────────────────────

#define ETH_ALEN  6
#define BUF_SIZ   1540                     /* Max Ethernet frame we'll build */
#define NIC_NAME  "eth0"

// ── Module state ────────────────────────────────────────────────────

static int       fd;                       /* Raw socket file descriptor */
static int       ifrindex;                 /* Interface index for eth0 */
static uint64_t  src_mac;                  /* Our MAC address (read from NIC) */
static int       current_brightness = 0;
static uint8_t   frame_data[FRAME_DATA_LENGTH] = {0}; /* Pre-zeroed frame commit template */

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Unpack a 48-bit MAC stored in the lower bytes of a uint64_t into a
 * 6-byte array (network byte order, MSB first). Used to populate
 * ether_header fields and sockaddr_ll from our integer MAC constants.
 */
static void encode_mac(uint8_t dest[ETH_ALEN], uint64_t mac) {
  dest[0] = (mac >> 40) & 0xFF;
  dest[1] = (mac >> 32) & 0xFF;
  dest[2] = (mac >> 24) & 0xFF;
  dest[3] = (mac >> 16) & 0xFF;
  dest[4] = (mac >>  8) & 0xFF;
  dest[5] =  mac        & 0xFF;
}

// ── Socket lifecycle ────────────────────────────────────────────────

/** Close the raw socket. Uses the module-level fd. */
void close_socket(void) {
  close(fd);
}

/** Open a raw AF_PACKET socket on eth0 and cache the interface index + MAC. */
int open_socket(void) {
  fd = socket(AF_PACKET, SOCK_RAW, IPPROTO_RAW);

  struct ifreq if_idx;
  memset(&if_idx, 0, sizeof(struct ifreq));
  strncpy(if_idx.ifr_name, NIC_NAME, IFNAMSIZ - 1);
  if (ioctl(fd, SIOCGIFINDEX, &if_idx) < 0)
    perror("SIOCGIFINDEX");
  ifrindex = if_idx.ifr_ifindex;

  struct ifreq if_mac;
  memset(&if_mac, 0, sizeof(struct ifreq));
  strncpy(if_mac.ifr_name, NIC_NAME, IFNAMSIZ - 1);
  if (ioctl(fd, SIOCGIFHWADDR, &if_mac) < 0)
    perror("SIOCGIFHWADDR");
  memcpy(&src_mac, if_mac.ifr_hwaddr.sa_data, 6);

  return fd;
}

// ── Packet construction + send ──────────────────────────────────────

/*
 * Build and send a raw Ethernet frame. Constructs the full Layer 2 header
 * (src MAC, dst MAC, EtherType) and appends the payload. No IP, no UDP —
 * this is as close to the wire as userspace gets.
 */
static int send_socket(unsigned int ether_type, uint8_t *data, int len) {
  char sendbuf[BUF_SIZ];
  struct ether_header *eh = (struct ether_header *)sendbuf;
  int tx_len = 0;
  struct sockaddr_ll socket_address;
  memset(sendbuf, 0, BUF_SIZ);

  encode_mac(eh->ether_shost, src_mac);    /* Source MAC (our NIC) */
  encode_mac(eh->ether_dhost, DEST_MAC);   /* Destination MAC (FPGA receiver) */

  eh->ether_type = htons(ether_type);
  tx_len += sizeof(struct ether_header);

  /* Clamp payload to buffer capacity */
  if (len + (int)sizeof(struct ether_header) > BUF_SIZ)
    len = BUF_SIZ - sizeof(struct ether_header);
  memcpy(sendbuf + sizeof(struct ether_header), data, len);
  tx_len += len;

  /* Link-layer destination for sendto() */
  socket_address.sll_ifindex = ifrindex;
  socket_address.sll_halen = ETH_ALEN;
  encode_mac(socket_address.sll_addr, DEST_MAC);

  ssize_t sent = sendto(fd, sendbuf, tx_len, 0,
                         (struct sockaddr *)&socket_address,
                         sizeof(struct sockaddr_ll));
  if (sent < 0)
    perror("sendto");

  return (int)sent;
}

// ── Brightness ──────────────────────────────────────────────────────

void set_brightness(int brightness) {
  if (brightness < 0 || brightness > 255) {
    fprintf(stderr, "Warning: brightness %d out of range, clamping to 0-255\n",
            brightness);
    if (brightness < 0)   brightness = 0;
    if (brightness > 255)  brightness = 255;
  }
  current_brightness = brightness;
}

// ── Frame + row transmission ────────────────────────────────────────

/*
 * Send the frame commit packet (EtherType 0x0107). This tells the FPGA
 * to latch all previously received row data and drive the LEDs. Brightness
 * is embedded at named offsets in the 98-byte command structure.
 */
int send_frame(void) {
  frame_data[FRAME_BRIGHTNESS_OFFSET]   = current_brightness;
  frame_data[FRAME_GAMMA_FLAG_OFFSET]   = 5;
  frame_data[FRAME_BRIGHTNESS_R_OFFSET] = current_brightness;
  frame_data[FRAME_BRIGHTNESS_G_OFFSET] = current_brightness;
  frame_data[FRAME_BRIGHTNESS_B_OFFSET] = current_brightness;
  return send_socket(FRAME_ETHER_TYPE, frame_data, FRAME_DATA_LENGTH);
}

/** Send a single row of pixel data (EtherType 0x5500). */
int send_row(uint8_t *data, size_t len) {
  return send_socket(ROW_ETHER_TYPE, data, (int)len);
}
