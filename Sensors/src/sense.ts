/*
 * sense.ts — Ambient light sensor daemon for LED brightness control
 *
 * Reads lux values from a BH1750FVI I2C light sensor, maps them to a
 * brightness level (1-100) using a gamma curve and rolling average,
 * then publishes the result to Redis for the player/sender to consume.
 *
 * The gamma curve (0.6) boosts perceived brightness at low light levels
 * so the display doesn't appear dim indoors. A rolling window of the
 * last 10 readings smooths out flicker from transient shadows or
 * reflections. Brightness changes are rate-limited to ±5 steps per
 * cycle so the display fades gradually instead of jumping.
 *
 * BH1750FVI datasheet reference: ROHM Semiconductor, Rev. 011
 *   - Default I2C address 0x23 (ADDR pin low)
 *   - One Time H-Resolution Mode (opcode 0x21): single 1-lux
 *     measurement, sensor returns to power-down after read
 *   - Raw count to lux: lux = count / 1.2 (sensitivity 1.2 counts/lx)
 *   - Measurement time: 120ms typical, 180ms max
 *
 * Data flow:
 *   BH1750 (I2C) —lux—> sense.ts —gamma + avg—> Redis PUB + SET —> player/sender
 */

import { Redis } from "ioredis";
import i2c, { PromisifiedBus } from "i2c-bus";

// ── Redis ────────────────────────────────────────────────────────────
const REDIS_PATH: string = "/var/run/redis/redis-server.sock";
const BRIGHTNESS_CHANNEL: string = "player:brightness:channel"; // PUB channel the player subscribes to
const BRIGHTNESS_KEY: string = "player:brightness";             // persisted key for cold-start reads

const redis = new Redis({
  path: REDIS_PATH,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redis.on("error", (err: Error) => {
  console.error("Redis error:", err);
});

// ── BH1750FVI opcodes (datasheet §4, Table 2) ──────────────────────
const BH1750_POWER_ON: number = 0x01;          // exit power-down, wait for command
const BH1750_RESET: number = 0x07;             // reset data register (requires power-on first)
const BH1750_ONE_TIME_HIGH_RES: number = 0x21; // single measurement, 1 lx resolution, auto power-down

// ── BH1750FVI I2C / conversion ──────────────────────────────────────
const I2C_BUS: number = 1;                     // /dev/i2c-1
const I2C_ADDRESS: number = 0x23;             // ADDR pin low → 0x23
const SENSITIVITY: number = 1.2;              // counts per lux (datasheet §11)
const MEASUREMENT_WAIT_MS: number = 180;      // max conversion time for high-res mode (datasheet §3)
const LUX_MAX: number = 400;                  // clamp — indoor range is plenty

// ── Brightness mapping ───────────────────────────────────────────────
const BRIGHTNESS_MIN: number = 1;             // lowest output value
const BRIGHTNESS_MAX: number = 100;           // highest output value
const BRIGHTNESS_INC_MAX: number = 5;         // max step per cycle (fade rate)
const GAMMA: number = 0.6;                    // <1 = boost low-light perception

// ── Timing / smoothing ──────────────────────────────────────────────
const SLEEP_MS: number = 1000;                // idle sleep when brightness unchanged
const BACKOFF_MS: number = 1000;              // wait after I2C or Redis error
const WINDOW_SIZE: number = 10;               // rolling average window

// ── Runtime state ────────────────────────────────────────────────────
let i2cBus: PromisifiedBus | null = null;
let sensorReadings: number[] = [];
let currentBrightness: number = 1;
const DEBUG: boolean = process.argv.includes("--debug");

// ── I2C bus management ───────────────────────────────────────────────

async function openBus(): Promise<PromisifiedBus> {
  i2cBus = await i2c.openPromisified(I2C_BUS);
  return i2cBus;
}

async function closeBus(): Promise<void> {
  if (i2cBus) {
    await i2cBus.close();
    i2cBus = null;
  }
}

/**
 * Read lux from BH1750FVI.
 *
 * Sequence: power on → trigger one-time measurement → wait for
 * conversion → read 2-byte result → convert raw count to lux.
 * The sensor auto-powers-down after the read.
 */
async function readLux(): Promise<number> {
  if (!i2cBus) await openBus();

  // Wake the sensor — required before every one-time measurement
  await i2cBus!.i2cWrite(I2C_ADDRESS, 1, Buffer.from([BH1750_POWER_ON]));

  // Trigger one-time high-resolution measurement
  await i2cBus!.i2cWrite(I2C_ADDRESS, 1, Buffer.from([BH1750_ONE_TIME_HIGH_RES]));

  // Wait for conversion (180ms max per datasheet)
  await new Promise<void>((resolve) => setTimeout(resolve, MEASUREMENT_WAIT_MS));

  // Read 2-byte result (MSB first)
  const buf = Buffer.alloc(2);
  await i2cBus!.i2cRead(I2C_ADDRESS, 2, buf);

  const raw = buf[0] * 256 + buf[1];
  return Math.floor(raw / SENSITIVITY);
}

/**
 * Map a lux reading to brightness (1-100) using a gamma curve,
 * smoothed through a rolling average window.
 */
function luxToBrightness(lux: number): number {
  const normalized = Math.min(lux / LUX_MAX, 1);
  const mapped =
    Math.pow(normalized, GAMMA) * (BRIGHTNESS_MAX - BRIGHTNESS_MIN) +
    BRIGHTNESS_MIN;
  const reading = Math.round(mapped);

  // Rolling average window
  sensorReadings.push(reading);
  if (sensorReadings.length > WINDOW_SIZE) {
    sensorReadings.shift();
  }

  const average =
    sensorReadings.reduce((sum, val) => sum + val, 0) / sensorReadings.length;

  return Math.round(average);
}

/**
 * One iteration of the brightness control loop.
 * Reads the sensor, maps to brightness, rate-limits the change,
 * and publishes to Redis.
 */
async function updateBrightness(): Promise<void> {
  const lux = await readLux();
  const target = luxToBrightness(lux);

  const diff = target - currentBrightness;

  // Already at target — no change needed, idle until next cycle
  if (!diff) {
    await new Promise<void>((r) => setTimeout(r, SLEEP_MS));
    return;
  }

  // Rate-limit: move toward target by at most BRIGHTNESS_INC_MAX per cycle.
  // Math.sign gives direction (±1), Math.min caps the magnitude.
  const inc = Math.sign(diff) * Math.min(Math.abs(diff), BRIGHTNESS_INC_MAX);

  if (DEBUG) {
    console.log({ lux, target, currentBrightness, inc, windowSize: sensorReadings.length });
  }

  const brightness = Math.max(
    Math.min(currentBrightness + inc, BRIGHTNESS_MAX),
    BRIGHTNESS_MIN,
  );

  currentBrightness = brightness;

  await Promise.all([
    redis.publish(BRIGHTNESS_CHANNEL, brightness.toString()),
    redis.set(BRIGHTNESS_KEY, brightness),
  ]);
}

// ── Graceful shutdown ────────────────────────────────────────────────
async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  await closeBus();
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Main loop ────────────────────────────────────────────────────────
(async () => {
  await redis.connect();

  while (true) {
    try {
      await updateBrightness();
    } catch (err) {
      console.error("Error in brightness loop:", err);
      // Reset the I2C bus — the handle may be in a bad state after
      // a NACK, bus timeout, or incomplete transaction
      await closeBus();
      await new Promise<void>((r) => setTimeout(r, BACKOFF_MS));
    }
  }
})();
