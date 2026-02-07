/*
 * direct.ts — Playback daemon / orchestrator for LED sign
 *
 * Sits between the Player (canvas animation engine) and the Sender (C raw
 * Ethernet transmitter), coordinating frame production and Redis transport.
 *
 * The main loop calls player.play() to render one frame, pushes the RGBA
 * buffer to a Redis list, and applies back-pressure so the list doesn't
 * grow unbounded if the sender falls behind or is offline:
 *
 *   1. After rpush, check if the list length equals FPS (one second of
 *      buffered frames). If not, keep producing — the sender is consuming.
 *   2. If it does equal FPS, wait SENDER_WAIT_MS for the sender to drain.
 *   3. Re-check list length. If still FPS, the sender is stalled — flush
 *      the list and sleep PLAYER_BACKOFF_MS to avoid filling memory.
 *
 * Data flow:
 *   Player.play() → RGBA buffer → Redis list (player:frames) → sender.c (BLPOP)
 *   Sensor daemon → Redis PUB (player:brightness:channel) → subscriber → player.brightness
 */

import path from "path";
import { fileURLToPath } from "url";
import { Canvas, FontLibrary } from "skia-canvas";
import { Redis } from "ioredis";
import Player from "@myled/player";
import type { Movie } from "@myled/player";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ───────────────────────────────────────────────────────

const FPS = 240;
const PLAYER_BACKOFF_MS = 100;           /* Pause when sender is stalled */
const PLAYER_FRAMES_KEY = "player:frames";
const REDIS_PATH = "/var/run/redis/redis-server.sock";
const SENDER_WAIT_MS = 5;               /* Grace period before re-checking list length */
const ERROR_BACKOFF_MS = 1000;           /* Cooldown after an error in the main loop */

// ── Helpers ─────────────────────────────────────────────────────────

const sleep = async (t: number): Promise<void> =>
  new Promise((r) => setTimeout(r, t));

// ── Redis keys ──────────────────────────────────────────────────────

const BRIGHTNESS_CHANNEL = "player:brightness:channel";
const BRIGHTNESS_KEY = "player:brightness";

// ── Default movie ───────────────────────────────────────────────────
// Fallback content shown when no movie has been pushed from the web
// interface. Displays a simple "Hello, World!" slide-in animation that
// cycles through color themes indefinitely.

const movie: Movie = {
  sign: {
    width: 320,
    height: 64,
    theme: "dark",
  },
  data: {},
  screenplay: [
    {
      timeline: "slideInFromRight",
      start: 0,
      params: {
        name: "Hello World",
        duration: 4,
        text: "Hello, World!",
        font: { name: "Inter", size: 28, weight: 900 },
        fills: {
          themes: {
            dark: [
              {
                background: { from: "#000000", to: "#010101" },
                progress: "#FFD700",
                text: "#FFFFFF",
              },
              {
                background: { from: "#010101", to: "#010101" },
                progress: "#4FFF4F",
                text: "#FFFFFF",
              },
            ],
            light: [
              {
                background: { from: "#FFFFFF", to: "#F0F0F0" },
                progress: "#5050FF",
                text: "#000000",
              },
            ],
          },
        },
      },
    },
  ],
};

// ── Redis ───────────────────────────────────────────────────────────

const redis = new Redis({
  path: REDIS_PATH,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

const subscriber = new Redis({
  path: REDIS_PATH,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redis.on("error", (err: Error) => console.error("Redis error:", err));
subscriber.on("error", (err: Error) =>
  console.error("Redis subscriber error:", err),
);

// ── Canvas + Player ─────────────────────────────────────────────────

const canvas = new Canvas(movie.sign.width, movie.sign.height);
const player = new Player(canvas);

// ── Font loading ────────────────────────────────────────────────────
// skia-canvas doesn't use system fonts — every typeface must be
// explicitly registered before it can be referenced in fillText().

FontLibrary.use("Inter", [path.join(__dirname, "..", "fonts", "Inter.ttf")]);

// ── Brightness ──────────────────────────────────────────────────────

subscriber.on("message", (channel: string, message: string) => {
  if (channel === BRIGHTNESS_CHANNEL) {
    player.brightness = Number(message);
  }
});

// ── Graceful shutdown ───────────────────────────────────────────────

const shutdown = async (): Promise<void> => {
  console.log("Shutting down...");
  await subscriber.quit();
  await redis.quit();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Main loop ───────────────────────────────────────────────────────

(async () => {
  await redis.connect();
  await subscriber.connect();
  await subscriber.subscribe(BRIGHTNESS_CHANNEL);

  const storedBrightness = await redis.get(BRIGHTNESS_KEY);
  if (storedBrightness) player.brightness = Number(storedBrightness);
  player.load(movie);

  while (true) {
    try {
      player.play();
      const frame = player.getImageData();

      let pushed = await redis.rpush(PLAYER_FRAMES_KEY, frame);

      /*
       * Back-pressure: if the Redis list has accumulated one full second
       * of frames (FPS), the sender may be stalled. Wait briefly, then
       * double-check — if the list is still full, flush it and pause to
       * avoid unbounded memory growth.
       */
      const fps = player.movie!.sign.fps ?? FPS;
      if (pushed === fps) {
        await sleep(SENDER_WAIT_MS);
        pushed = await redis.llen(PLAYER_FRAMES_KEY);
        if (pushed === fps) {
          await Promise.all([
            redis.del(PLAYER_FRAMES_KEY),
            sleep(PLAYER_BACKOFF_MS),
          ]);
        }
      }
    } catch (err) {
      console.error("Error in playback loop:", err);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
})();
