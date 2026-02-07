# PartsToPixels

![Raspberry Pi](https://img.shields.io/badge/Raspberry%20Pi%205-A22846?logo=raspberrypi&logoColor=white)
![C](https://img.shields.io/badge/C-00599C?logo=c&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js%2023-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Lua](https://img.shields.io/badge/Lua-2C2D72?logo=lua&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)
![GSAP](https://img.shields.io/badge/GSAP-88CE02?logo=greensock&logoColor=black)
![Bash](https://img.shields.io/badge/Bash-4EAA25?logo=gnubash&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)
![Debian](https://img.shields.io/badge/Debian-A81D33?logo=debian&logoColor=white)
![Git](https://img.shields.io/badge/Git-F05032?logo=git&logoColor=white)
![Canvas](https://img.shields.io/badge/Canvas-E72429?logo=canvas&logoColor=white)

![PartsToPixels](https://d3tjpla53o89sp.cloudfront.net/github/hero.gif)

Born from building [SurfSign](https://www.surfsign.com/), commercial weather displays for high-end venues. The original prototype followed all the normal routes: Adafruit libraries, GitHub tutorials, off-the-shelf drivers. They all fell short of a professional sign, so the entire stack was rebuilt over multiple iterations.

### Lessons learned through multiple iterations

🧩 **Multiple disciplines** - Software, electrical, and mechanical engineering, each one deep.

🔀 **Full stack** - Microsecond C on one core, TypeScript animations on another.

⏱️ **Timing** - Raw Layer 2 socket, hybrid sleep/spin-wait, sub-10 μs jitter at 240 FPS.

🔥 **Heat** - Without thermal design, components fail or become fire hazards.

☀️ **Brightness** - Weak LEDs wash out in sunlight, powerful LEDs blind at night.

🎯 **Pixel perfection** - Low resolution forces pixel-perfect fonts or creative rasterization.

🧱 **Isolation** - Four processes, four CPU cores. Kernel-level isolation, zero SD card wear.

💰 **Hardware** - Wrong components hurt. Bad suppliers who ship junk hurt more.

📐 **Precision** - Each case iteration costs hundreds of dollars. Off by 2mm, start over.

🚫 **No mulligans** - Physical products have no undo button. Mistakes live with you.

🌧️ **Corrosion** - Rain, humidity, salt air. Moisture destroys components.

🔍 **Debugging** - Code, wiring, power supply, LED panel. All domains at once.

🔒 **The industry** - Suppliers sell solutions, not knowledge.

Avoid these pain points with a free start-to-finish course at [partstopixels.com](https://www.partstopixels.com/). Optional premium layer: agentic animation, remote content updates, and a live web interface over WebSockets.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│           Sender                           FPGA                             LEDs           │
│  ┌───────────────────────────┐    ┌─────────────────────────┐        ┌───────────────────┐ │
│  │  BPOPs frames from Redis  │    │  Fine tuned to latch    │──────► │ P4 RGB LED matrix │ │
│  │  and sends 240 FPS at μs  │L2─►│  frames from Sender and │HUB75─► │ 1/8 scan @ 3840hz │ │
│  │  precision to FPGA        │    │  drive LED modules      │──────► │ 10 panels 20k+ px │ │
│  └───────────────────────────┘    └─────────────────────────┘        └───────────────────┘ │
│                           ▲                                                                │
│                           │           Embedded Systems: RPI5                               │
│                         BLPOP                                                              │
│                       ┌───────────────────────────────────┐                                │
│                       │               Redis               │                                │
│                       └───────────────────────────────────┘                                │
│                          ▲           SUBSCRIBE        ▲                                    │
│                          │               │            │                                    │
│                       PUBLISH            ▼          LPUSH                                  │
│  ┌────────────────────────────┐   ┌────────────────────────────┐   ┌──────────────────┐    │
│  │  Determines brightness and │   │  Directs Player and pushes │◄─►│  Builds and      │    │
│  │  publishes to Director     │   │  frames to Sender          │   │  animates movie  │    │
│  └────────────────────────────┘   └────────────────────────────┘   └──────────────────┘    │
│            Sensors                          Director                     Player            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                                                 ▲
                                           ┌────────────┐
                                           │ WebSockets │
                                           └────────────┘
                                                 ▼
                                     _   _   _   __   _   _   _
                                   _/ \_/ \_/ \_/  \_/ \_/ \_/ \_
                                  /                              \
                                 /    Cloud Services (Optional)   \
                                /     -------------------------    \
                               /        · Web interface             \
                              /         · Easy updates               \
                              \         · Dynamic integrations       /
                               \        · Agentic animation         /
                                \_      · Help and support        _/
                                  \___   __   __    __   __   ___/
                                      \_/  \_/  \__/  \_/  \_/
```

Raspberry Pi 5 running DietPi, three isolated CPU cores, all IPC through Redis over a Unix socket.

| Process | Core | Description |
|---------|------|-------------|
| Redis | CPU 0 | Ephemeral Unix socket IPC, zero persistence |
| Sender | CPU 1 | C - raw L2 Ethernet to FPGA at ~120 Mbps, sub-10 μs jitter |
| Director | CPU 2 | TypeScript - GSAP on headless skia-canvas at 240 FPS |
| Sensors | CPU 3 | TypeScript - BH1750 I2C, gamma + rolling average brightness |

Each process pinned to its core via `taskset`, launched through DietPi postboot scripts in deterministic order. Cloud services optional: agentic animation, remote updates, web interface over WebSockets.

## Repository Structure

```
Raspberry/
  Sender/          C - raw Ethernet frame transport (CPU 1)
    src/
      sender.c       Main loop: Redis BLPOP, RGBA→RGB, timing, frame commit
      socket.c       AF_PACKET raw socket, packet construction, brightness
      socket.h       Protocol constants, FPGA row header struct
    Makefile         gcc -O3 -march=native -flto, setcap CAP_NET_RAW
    start / debug    Production (background) and debug (foreground) launchers

  Director/        TypeScript - playback orchestrator (CPU 2)
    src/
      direct.ts      Main loop: Player.play(), Redis rpush, back-pressure
    fonts/           Typefaces registered with skia-canvas
    start / debug

  Player/          TypeScript - canvas animation engine (library, no process)
    src/
      player.ts      GSAP timeline builder, frame-by-frame renderer

  Sensors/         TypeScript - ambient light daemon (CPU 0)
    src/
      sense.ts       BH1750FVI I2C driver, lux→brightness pipeline
      i2c-bus.d.ts   Type declarations for i2c-bus module
    start / debug
```

## Software

The pre-built DietPi image ships with the full stack configured: the C Sender compiled and pinned to CPU 1, Director and Player built and pinned to CPU 2, Sensors daemon pinned to CPU 0, Redis running ephemeral on CPU 3 over a Unix socket. Kernel-level CPU isolation, performance governor, postboot scripts for deterministic launch order, three network interfaces configured (eth0 raw L2 for the FPGA, USB Ethernet for internet, WiFi backup), Node.js 23, hiredis, and all native addons pre-compiled. Flash the image to an SD card and the sign boots into a working pipeline.

### Redis

[Redis](https://redis.io/) runs ephemeral - no persistence, no SD card writes, no snapshots, no AOF. Pub/sub, lists, and atomic operations out of the box; primitives that would need to be reinvented with shared memory or file-based IPC. Battle-tested, zero SD card wear, all IPC over a Unix socket.

### Sender

The [Sender](https://github.com/TheSamGilman/PartsToPixels/blob/main/Sender/src/sender.c) is a C program that sends frames to the FPGA over raw Ethernet at 240 FPS, pinned to CPU 1.

```bash
# Build
make

# Production - background, pinned to CPU 1, silent
./start

# Debug - foreground, pinned to CPU 1
./debug
```

**How it works** - Pops frames from the Redis queue, converts RGBA to the FPGA's row-based RGB protocol, and blasts them out over raw Ethernet - no IP stack, no UDP, just Layer 2 frames direct to the FPGA. Each frame is split into 65 packets: 64 row packets (one per scanline, 981 bytes each) plus a final commit packet that tells the FPGA to latch and display. Brightness (0-255) is read from Redis (`sender:brightness`) every frame and embedded in the commit packet.

**FPGA protocol** - The FPGA receiver listens on MAC `11:22:33:44:55:66` for two custom EtherTypes: `0x5500` for row data (7-byte header + 960 bytes RGB per row) and `0x0107` for frame commit with brightness at offsets 21, 24-26. At 240 FPS, that's ~15,600 packets per second pushing ~15 MB/s sustained throughput.

**Microsecond timing** - At 240 FPS each frame has a ~4.167 ms budget. The timing loop uses a hybrid sleep/spin-wait strategy: if more than 200 μs remain, `usleep()` yields the CPU; for the final ~100-200 μs, a tight loop on `CLOCK_MONOTONIC_RAW` spins until the exact deadline. The result is consistent sub-10 μs jitter. The binary is compiled with `-O3 -march=native -flto` and requires `CAP_NET_RAW` (set via `setcap` in the Makefile).

### Director / Player

The [Director](https://github.com/TheSamGilman/PartsToPixels/blob/main/Director/src/direct.ts) is the playback daemon, pinned to CPU 2.

```bash
# Install
npm install

# Build
npm run build

# Production - background, pinned to CPU 2, silent
./start

# Debug - foreground, pinned to CPU 2
./debug
```

> Player must be installed and built before Director (`cd Player && npm install && npm run build`).

**How it works** - The Director loads a movie definition, creates a headless skia-canvas, and passes both to the Player. On each frame, the Player renders onto the canvas and the Director pushes the raw RGBA pixel buffer to a Redis list (`player:frames`). The Director also subscribes to brightness updates from the Sensors daemon and applies them to all rendered colors.

**Player** - The [Player](https://github.com/TheSamGilman/PartsToPixels/blob/main/Player/src/player.ts) is not a separate process. It's a canvas animation framework that takes a canvas and a movie definition, builds GSAP timelines, and renders frame-by-frame at 240 FPS. The Player is environment-agnostic; it works anywhere there's a Canvas API and GSAP, including embedded systems with skia-canvas, browsers, or any Node.js environment. Adding a new animation is just writing a timeline function; no class inheritance or registration needed.

### Sensors

The [Sensors](https://github.com/TheSamGilman/PartsToPixels/blob/main/Sensors/src/sense.ts) daemon reads a **BH1750FVI** ambient light sensor over I2C and publishes a brightness value (1-100) to Redis, pinned to CPU 0.

```bash
# Install
npm install

# Build
npm run build

# Production - background, pinned to CPU 0, silent
./start

# Debug - foreground, logs lux + brightness each cycle
./debug
```

**How it works** - Reads raw lux from the BH1750 and converts it into a perceptual brightness value that the Director and Sender use to adjust display output in real time. The conversion runs a three-stage pipeline: gamma correction to map lux to a perceptually linear scale, a rolling average to smooth transient fluctuations, and rate limiting to cap how fast brightness can change; preventing flicker or jumps when light conditions shift.

**I2C protocol** - The BH1750 operates in One Time H-Resolution Mode (`0x21`): power on (`0x01`) → trigger → wait up to 180 ms → read 2 bytes (`count / 1.2 = lux`). The sensor powers down after each read. This mode was chosen over continuous measurement for explicit timing control and to avoid stale data. On I2C errors, the daemon closes and reopens the bus rather than retrying on a potentially corrupted handle.

### Boot

The core pipeline launches through DietPi postboot scripts (`/var/lib/dietpi/postboot.d/`), not systemd units. Postboot runs once, sequentially, after the system is fully booted and time is synced - deterministic launch order without dependency resolution or race conditions. Each process gets its own script, pinned to its assigned CPU core. Systemd handles the peripherals: reverse proxies, monitoring, anything that needs restart-on-failure.

## Casing

You will need a case to house your components, align the LEDs, and mount it to a wall or stand. Building a case is surprisingly hard and LED modules need mm-level precision to line up properly - some panels have 2mm pitch, giving you almost no room for error.

![PartsToPixels Case - Front](https://d3tjpla53o89sp.cloudfront.net/github/case-4.2-front.webp)

![PartsToPixels Case - Back](https://d3tjpla53o89sp.cloudfront.net/github/case-4.2-back.webp)

Ideal materials are acrylic or aluminum. Acrylic cases can be assembled by all levels, while aluminum cases require AC/DC TIG welding skills, so probably start with acrylic unless you are a TIG welder or want to spend a year learning that skill.

Open [`PartsToPixels-Case-4.2.FCStd`](https://github.com/TheSamGilman/PartsToPixels/blob/main/PartsToPixels-Case-4.2.FCStd) in FreeCAD (0.21+). Each panel is a separate body that can be individually exported to DXF for laser cutting.

## Components

You will need many components and most are easy to get.

![Components](https://d3tjpla53o89sp.cloudfront.net/github/components-3.webp)

The hardest components to source are the LED modules. Understanding their electrical specifications is a challenge on its own, and finding a good supplier is difficult because they don't like small orders and you can't find them on typical retail sites. The remaining components are less tricky but can still be hard to find.

## Dependencies

You don't need to do any of this unless you're curious - it's all pre-configured in the DietPi image.

### OS and System

- Flash DietPi to an SD card for the Raspberry Pi 5
- Walk through the DietPi first-boot wizard - set passwords, disable serial UART, skip optional software
- Configure hostname
- Set up SSH key authentication, disable password login, and configure a reverse SSH proxy for remote access
- Lock DNS to Google and Cloudflare resolvers and make the config immutable with `chattr +i`

### Network

The Pi uses three network interfaces, each with a dedicated role:

- **eth0** (native RJ45) - dedicated exclusively to the FPGA. This interface carries raw Layer 2 Ethernet frames - no IP, no DHCP, no TCP. The Sender opens a raw socket on eth0 and writes frames directly to the wire. DietPi will try to manage this interface by default, so it needs to be configured as hotplug-only with a high metric to keep it out of the routing table.

- **eth1** (USB Ethernet dongle) - primary internet connection. Since eth0 is reserved for the FPGA, a USB dongle provides the actual network connectivity. This gets the lowest metric so all outbound traffic routes here by default.

- **wlan0** (WiFi) - backup internet with a higher metric than eth1. DietPi's built-in WiFi management conflicts with manual configuration, so the global wpa_supplicant service needs to be disabled and replaced with a per-interface config. WiFi power management must also be disabled via a postboot script; the default power saving introduces latency spikes that interfere with the real-time pipeline.

Each interface needs its own drop-in config under `/etc/network/interfaces.d/` with explicit metrics to control routing priority. The main interfaces file is replaced with a single `source` directive and made immutable with `chattr +i` to prevent DietPi from overwriting it on updates.

### Performance

- Set CPU governor to `performance`
- Isolate CPUs 0, 1, and 2 via kernel boot parameters (`isolcpus`, `nohz_full`, `rcu_nocbs`)
- Pin all system services to CPU 3
- Pin each process to its own isolated core using `taskset`

### Hardware

- Enable I2C for the BH1750 ambient light sensor

### Packages

**System packages:**

- `build-essential` - gcc, make, and standard C toolchain
- `tcl` - required for building Redis from source
- `i2c-tools` - I2C bus debugging for the BH1750 sensor
- `dnsutils` - DNS utilities
- `curl`, `git`, `unzip`
- `python3` - required by node-gyp for compiling native Node.js addons

**Runtime:**

- [Node.js](https://nodejs.org/) v23 via nvm
- [Redis](https://redis.io/) built from source - runs ephemeral (no persistence) over a Unix socket with a dedicated `redis` system user

**C libraries:**

- [hiredis](https://github.com/redis/hiredis) - Redis C client, required to build the Sender (`make && make install && ldconfig`)

**Native Node.js addons** (compiled during `npm install`):

- [skia-canvas](https://github.com/nicpeck/skia-canvas) - headless Canvas rendering for the Player (prebuilt ARM64 binaries available, falls back to source compilation requiring a Rust toolchain)
- [i2c-bus](https://github.com/fivdi/i2c-bus) - I2C communication for the Sensors daemon (requires `python3` and `node-gyp`)

**Sender runtime:**

- Raw Ethernet socket access (`CAP_NET_RAW` / `CAP_NET_ADMIN` capabilities, or run as root)

---

Built from scratch. Start to finish at [partstopixels.com](https://www.partstopixels.com/).
