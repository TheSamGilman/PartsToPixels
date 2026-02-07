/*
 * player.ts — Canvas animation engine for LED sign playback
 *
 * Renders frame-by-frame animations on an off-screen 2D canvas (skia-canvas)
 * for a 320×64 LED matrix. The rendering pipeline is:
 *
 *   Movie (JSON)
 *     → Screenplay entries (scene name + params + start offset)
 *       → Timeline functions (produce AnimationDescriptor arrays)
 *         → GSAP master timeline (tweens targets over time)
 *           → Per-frame seek + draw loop (canvas pixels → RGBA buffer)
 *
 * Each frame is exported as a raw RGBA buffer and pushed to Redis, where
 * the C sender (sender.c) pops it and blasts it over raw Ethernet to the
 * FPGA receiver.
 *
 * Brightness compensation:
 *   The sensor daemon publishes a brightness level (1-100). Rather than
 *   dimming at the hardware level alone (which crushes dark colors), we
 *   also scale RGB values in software. A "dark boost" bumps already-dark
 *   colors slightly so they don't vanish at low brightness. See
 *   adjustColorForBrightness() for the formula.
 *
 * Data flow:
 *   Movie JSON → Player.load() → GSAP timeline
 *   Player.play() → seek + draw → getImageData() → RGBA Buffer → Redis
 */

import { gsap } from "gsap";

// ── Constants ───────────────────────────────────────────────────────

const FPS = 240;
const BRIGHTNESS_SCALING_FACTOR = 0.7;
const DARK_BOOST = 0.1;

// ── Interfaces ──────────────────────────────────────────────────────

export type AnimationValue = string | number;

export interface PlayerCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): PlayerContext;
}

export interface PlayerContext {
  globalAlpha: number;
  fillStyle: string | object;
  font: string;
  textAlign: string;
  textBaseline: string;
  getImageData(sx: number, sy: number, sw: number, sh: number): PlayerImageData;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
}

interface PlayerImageData {
  data: {
    buffer: ArrayBufferLike;
    byteOffset: number;
    byteLength: number;
  };
}

export interface Sign {
  width: number;
  height: number;
  theme: string;
  fps?: number;
}

export interface Fills {
  background: { from: string; to: string };
  progress: string;
  text: string;
}

export interface ThemeFills {
  [theme: string]: Fills[];
}

export interface AnimationDescriptor {
  name: string;
  animation: string;
  start: number;
  layer: number;
  props: Record<string, AnimationValue>;
  keyframes: Keyframe[];
}

export interface Keyframe {
  duration: number;
  [key: string]: AnimationValue;
}

export interface ScreenplayEntry {
  timeline: string;
  start: number;
  params: Record<string, unknown>;
}

export interface Movie {
  sign: Sign;
  data: Record<string, unknown>;
  screenplay: ScreenplayEntry[];
}

interface BuiltTimeline {
  animations: AnimationDescriptor[];
  start: number;
}

interface BuiltMovie {
  sign: Sign;
  data: Record<string, unknown>;
  timelines: BuiltTimeline[];
}

type TimelineFunction = (
  sign: Sign,
  params: Record<string, unknown>,
  data: Record<string, unknown>,
  cycles: number,
) => AnimationDescriptor[];

interface SlideInFromRightParams {
  name: string;
  duration: number;
  font: { name: string; weight: string; size: number };
  text: string;
  fills: { themes: ThemeFills };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Scale a hex color to compensate for hardware brightness dimming.
 *
 * At low brightness the LEDs crush dark tones, so we boost RGB values in
 * software to keep colors visible. The formula:
 *
 *   scale = 1 − SCALING_FACTOR × (1 − brightness/100)
 *
 * At brightness=100 → scale=1.0 (no change). At brightness=10 →
 * scale ≈ 0.37, significantly brightening the software color to offset
 * the hardware dim. An additional "dark boost" raises already-dark colors
 * (avg channel < 100) so they don't disappear entirely.
 */
function adjustColorForBrightness(hexColor: string, brightness: number): string {
  if (brightness === 100 || (BRIGHTNESS_SCALING_FACTOR as number) === 0) return hexColor;

  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  const scale = 1 - BRIGHTNESS_SCALING_FACTOR * (1 - brightness / 100);
  const avgBrightness = (r + g + b) / 3;
  const darkBoost =
    avgBrightness < 100 ? (1 - avgBrightness / 100) * DARK_BOOST : 0;
  const adjustedScale = scale + darkBoost;

  const newR = Math.min(255, Math.round(r * adjustedScale));
  const newG = Math.min(255, Math.round(g * adjustedScale));
  const newB = Math.min(255, Math.round(b * adjustedScale));

  return `#${newR.toString(16).padStart(2, "0")}${newG.toString(16).padStart(2, "0")}${newB.toString(16).padStart(2, "0")}`;
}

// ── Animation classes ───────────────────────────────────────────────

interface AnimationOptions {
  player: Player;
  canvas: PlayerCanvas;
  context: PlayerContext;
  target: Record<string, AnimationValue>;
  state: gsap.TweenVars;
  props: Record<string, AnimationValue>;
  layer: number;
  name: string;
}

/**
 * Base animation element. Each instance owns a GSAP-tweened `target` object
 * and a static `props` bag. Subclasses override `draw()` to render the
 * current interpolated values onto the canvas.
 */
class Base {
  player: Player;
  canvas: PlayerCanvas;
  context: PlayerContext;
  target: Record<string, AnimationValue>;
  layer: number;
  props: Record<string, AnimationValue>;
  name: string;
  animating: boolean;

  constructor({ player, canvas, context, target, state, props, layer, name }: AnimationOptions) {
    this.player = player;
    this.canvas = canvas;
    this.context = context;
    this.target = target;
    this.layer = layer;
    this.props = props;
    this.name = name;
    this.animating = false;
    state.onStart = () => { this.animating = true; };
    state.onComplete = () => { this.animating = false; };
  }

  get<T extends AnimationValue>(attr: string): T {
    return (attr in this.target ? this.target[attr] : this.props[attr]) as T;
  }

  draw(): void {}
}

class RectangleAnimation extends Base {
  draw(): void {
    const alpha = this.get<number>("alpha");
    const fill = this.get<string>("fill");
    const width = this.get<number>("width");
    const height = this.get<number>("height");
    const x = this.get<number>("x");
    const y = this.get<number>("y");

    this.context.globalAlpha = alpha;
    this.context.fillStyle = adjustColorForBrightness(
      fill,
      this.player.brightness,
    );
    this.context.fillRect(x, y, width, height);
  }
}

class TextAnimation extends Base {
  draw(): void {
    const alpha = this.get<number>("alpha");
    const fill = this.get<string>("fill");
    const font = this.get<string>("font");
    const fontSize = this.get<number>("fontSize");
    const fontWeight = this.get<string>("fontWeight");
    const text = this.get<string>("textPlain") || this.get<string>("text");
    const textAlign = this.get<string>("textAlign");
    const textBaseline = this.get<string>("textBaseline");
    const x = this.get<number>("x");
    const y = this.get<number>("y");

    this.context.globalAlpha = alpha;
    this.context.fillStyle = adjustColorForBrightness(
      fill,
      this.player.brightness,
    );
    this.context.font = `${fontWeight} ${fontSize}px ${font}`;
    this.context.textAlign = textAlign;
    this.context.textBaseline = textBaseline;
    this.context.fillText(text, x, y);
  }
}

const Animations: Record<string, typeof Base> = { RectangleAnimation, TextAnimation };

// ── Timeline functions ──────────────────────────────────────────────

/**
 * Slide-in-from-right timeline: a full-screen text animation with three layers.
 *
 * Visual sequence:
 *   0.00s  Background cross-fades from→to color
 *   0.00s  Progress bar starts growing left→right (1px tall)
 *   0.00s  Text starts off-screen right, eases in to center (power3.out)
 *   1.00s  Text holds at center
 *   (duration−1.4)s  Text eases down and fades out (power2.in)
 *   (duration)s  Progress bar reaches full width; cycle ends
 */
function slideInFromRight(
  sign: Sign,
  rawParams: Record<string, unknown>,
  data: Record<string, unknown>,
  cycles: number,
): AnimationDescriptor[] {
  const params = rawParams as unknown as SlideInFromRightParams;
  const { duration, font, text } = params;
  const { width, height, theme } = sign;
  const themeFills: Fills[] = params.fills.themes[theme];
  const fills = themeFills[cycles % themeFills.length];
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);

  return [
    /* Layer 0: Background — cross-fade from one shade to another */
    {
      name: `${params.name} (background)`,
      animation: "RectangleAnimation",
      start: 0,
      layer: 0,
      props: { alpha: 1, width, height, x: 0, y: 0 },
      keyframes: [
        { duration: 0, fill: fills.background.from },            /* instant: initial color */
        { duration: 0.25, fill: fills.background.to },           /* 250ms cross-fade */
        { duration: duration - 0.25, fill: fills.background.to },/* hold until end */
      ],
    },
    /* Layer 1: Progress bar — 1px tall, grows from 0 to full width */
    {
      name: `${params.name} (progress)`,
      animation: "RectangleAnimation",
      start: 0,
      layer: 1,
      props: { alpha: 1, x: 0, y: 0, fill: fills.progress, height: 1 },
      keyframes: [
        { duration: 0, width: 0 },       /* start at zero width */
        { duration, width },              /* grow to full width over duration */
      ],
    },
    /* Layer 2: Text — slides in from right, holds, drops down and fades */
    {
      name: `${params.name} (text)`,
      animation: "TextAnimation",
      start: 0,
      layer: 2,
      props: {
        alpha: 1,
        fill: fills.text,
        font: font.name,
        fontWeight: font.weight,
        fontSize: font.size,
        textAlign: "center",
        textBaseline: "middle",
        text,
      },
      keyframes: [
        { alpha: 1, duration: 0, ease: "power3.out", x: centerX + width, y: centerY },    /* start off-screen right */
        { alpha: 1, duration: 1, ease: "power3.out", x: centerX, y: centerY },             /* ease in to center */
        { alpha: 1, duration: duration - 1.4, x: centerX, y: centerY },                    /* hold at center */
        { alpha: 0, duration: 0.4, ease: "power2.in", x: centerX, y: height + 25 },       /* drop down + fade out */
      ],
    },
  ];
}

const timelines: Record<string, TimelineFunction> = { slideInFromRight };

// ── Player ──────────────────────────────────────────────────────────

/**
 * Frame-by-frame animation player. Owns a GSAP master timeline, an
 * off-screen canvas, and a list of drawable animation elements. The
 * director calls play() in a loop, extracting one RGBA frame per call.
 */
class Player {
  canvas: PlayerCanvas;
  context: PlayerContext;
  animations: Base[];
  movie: BuiltMovie | null;
  timeline: gsap.core.Timeline | null;
  frames: number;
  frame: number;
  duration: number;
  cycles: number;
  brightness: number;
  private _movie!: Movie;

  constructor(canvas: PlayerCanvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.animations = [];
    this.movie = null;
    this.timeline = null;
    this.frames = 0;
    this.frame = 0;
    this.duration = 0;
    this.cycles = 0;
    this.brightness = 100;
  }

  /** Compile the raw Movie into a BuiltMovie with resolved timeline functions. */
  build(): void {
    const { sign, data, screenplay } = this._movie;
    this.movie = {
      sign,
      data,
      timelines: screenplay.map(({ timeline, params, start }) => ({
        animations: timelines[timeline](sign, params, data, this.cycles),
        start,
      })),
    };
  }

  /** Extract the current canvas contents as a raw RGBA buffer for Redis. */
  getImageData(): Buffer {
    const img = this.context.getImageData(
      0,
      0,
      this.movie!.sign.width,
      this.movie!.sign.height,
    );
    return Buffer.from(
      img.data.buffer,
      img.data.byteOffset,
      img.data.byteLength,
    );
  }

  /**
   * Load a movie definition and build the GSAP timeline.
   *
   * Deep-clones the movie first because GSAP mutates tween target objects
   * in place — without a fresh copy, reload() would see stale end-state
   * values instead of the original keyframe starting points.
   */
  load(movie: Movie): void {
    this._movie = JSON.parse(JSON.stringify(movie));
    this.build();
    this.animations = [];
    this.timeline = gsap.timeline({ paused: true });

    this.movie!.timelines.forEach((scene) => {
      const sceneTimeline = gsap.timeline();
      scene.animations.forEach((item) => {
        const { animation, keyframes, props, layer, start, name } = item;
        const state: gsap.TweenVars = { keyframes };
        /* Deep-clone the first keyframe as the tween target — GSAP will
           mutate this object's values as it interpolates each frame. */
        const target = JSON.parse(JSON.stringify(keyframes[0])) as Record<string, AnimationValue>;
        delete target.duration;
        sceneTimeline.to(target, state, start);
        this.animations.push(
          new Animations[animation]({
            player: this,
            canvas: this.canvas,
            context: this.context,
            props,
            target,
            state,
            layer,
            name,
          }),
        );
      });
      this.timeline!.add(sceneTimeline, scene.start);
    });

    /* Sort by layer for painter's algorithm — lower layers draw first,
       higher layers paint on top. */
    this.animations.sort((a, b) => a.layer - b.layer);
    this.duration = this.timeline!.duration();
    this.frames = Math.ceil(this.duration * FPS);
    this.frame = 0;
  }

  /**
   * Advance the animation and render the next visible frame.
   *
   * Skips over frames where no animation element is active (i.e. all
   * elements report animating=false). This avoids pushing blank pixel
   * buffers to Redis during gaps between scenes. Returns `true` when
   * the movie wraps around to the beginning (one full cycle completed).
   */
  play(): true | undefined {
    if (!this.movie) return;

    let hasActiveAnimation = false;
    let skippedFrames = 0;

    while (!hasActiveAnimation) {
      const progress = this.frame / (this.frames - 1 || 1);
      this.timeline!.seek(this.duration * progress, false);
      this.canvas.width = this.canvas.width; /* Standard canvas clearing trick (resets all pixels) */

      this.animations.forEach((animation) => {
        if (animation.animating) {
          hasActiveAnimation = true;
          this.context.save();
          animation.draw();
          this.context.restore();
        }
      });

      skippedFrames++;
      if (skippedFrames >= this.frames) hasActiveAnimation = true;

      this.frame++;
      if (this.frame >= this.frames) {
        this.frame = 0;
        this.cycles++;
        return true;
      }
    }
  }

  reload(): void {
    this.load(this._movie);
  }
}

export default Player;
