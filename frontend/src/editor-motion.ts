import type { CSSProperties } from "react";
import type { Scene } from "./types";
import { bound } from "./timeline";
/** Exact two-dimensional camera formula shared with the local renderer. */
export function imageMotion(
  scene: Scene,
  time: number,
  duration: number,
): CSSProperties {
  if (scene.visual === "video") return {};
  const f = bound(time / Math.max(1 / 30, duration - 1 / 30), 0, 1),
    i = bound(scene.effect.intensity, 0, 1);
  let zoom = 1,
    x = 0.5,
    y = 0.5,
    rotation = 0;
  switch (scene.effect.type) {
    case "zoom_in":
      zoom = 1 + i * f;
      break;
    case "zoom_out":
      zoom = 1 + i * (1 - f);
      break;
    case "pan_left":
      zoom = 1 + i;
      x = f;
      break;
    case "pan_right":
      zoom = 1 + i;
      x = 1 - f;
      break;
    case "pan_up":
      zoom = 1 + i;
      y = f;
      break;
    case "pan_down":
      zoom = 1 + i;
      y = 1 - f;
      break;
    case "ken_burns":
      zoom = 1 + i * f;
      x = f;
      y = f;
      break;
    case "drift":
      zoom = 1 + i;
      x = 0.5 + 0.5 * Math.sin(2 * Math.PI * f);
      y = 0.5 + 0.5 * Math.cos(2 * Math.PI * f);
      break;
    case "pulse":
      zoom = 1 + i * (0.5 - 0.5 * Math.cos(2 * Math.PI * f));
      break;
    case "bounce":
      zoom = 1 + i;
      y = 0.5 - 0.5 * Math.cos(4 * Math.PI * f);
      break;
    case "rotate":
      rotation = 20 * i * (2 * f - 1);
      break;
    case "tilt":
      rotation = 8 * i * Math.sin(2 * Math.PI * f);
      break;
  }
  return {
    transform: `scale(${zoom}) translate(${(((0.5 - x) * (zoom - 1)) / zoom) * 100}%, ${(((0.5 - y) * (zoom - 1)) / zoom) * 100}%) rotate(${rotation}deg)`,
  };
}
export const dissolveCells = Array.from({ length: 32 * 18 }, (_, index) => {
  const x = index % 32,
    y = Math.floor(index / 32),
    seed = x * 17 + y * 29;
  return { x, y, threshold: 1 - ((seed * (seed + 13) + 19) % 997) / 997 };
});
export function incomingTransition(
  type: Scene["transition"]["type"],
  progress: number,
  maskId: string,
): CSSProperties {
  const p = bound(progress, 0, 1);
  switch (type) {
    case "fade":
    case "crossfade":
    case "zoom":
      return { opacity: p };
    case "dissolve":
      return { clipPath: `url(#${maskId})` };
    case "slide_left":
      return { transform: `translateX(${(1 - p) * 100}%)` };
    case "slide_right":
      return { transform: `translateX(${-(1 - p) * 100}%)` };
    case "slide_up":
      return { transform: `translateY(${(1 - p) * 100}%)` };
    case "slide_down":
      return { transform: `translateY(${-(1 - p) * 100}%)` };
    case "wipe_left":
      return { clipPath: `inset(0 0 0 ${(1 - p) * 100}%)` };
    case "wipe_right":
      return { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` };
    case "wipe_up":
      return { clipPath: `inset(${(1 - p) * 100}% 0 0 0)` };
    case "wipe_down":
      return { clipPath: `inset(0 0 ${(1 - p) * 100}% 0)` };
    default:
      return {};
  }
}
export function outgoingTransition(
  type: Scene["transition"]["type"],
  progress: number,
): CSSProperties {
  const p = bound(progress, 0, 1);
  switch (type) {
    case "slide_left":
      return { transform: `translateX(${-p * 100}%)` };
    case "slide_right":
      return { transform: `translateX(${p * 100}%)` };
    case "slide_up":
      return { transform: `translateY(${-p * 100}%)` };
    case "slide_down":
      return { transform: `translateY(${p * 100}%)` };
    case "zoom":
      return { transform: `scale(${1 + 0.25 * p})` };
    default:
      return {};
  }
}
