import type { Asset, ClipSettings, ProjectDocument, Scene } from "./types";
export interface TimelineEntry {
  scene: Scene;
  index: number;
  start: number;
  end: number;
  duration: number;
  overlap: number;
}
export const bound = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
export function clipLength(clip: ClipSettings, asset?: Asset): number {
  const end = clip.trim_end ?? asset?.duration ?? 0;
  return Math.max(0, end - clip.trim_start) / Math.max(0.25, clip.speed);
}
export function sceneDuration(scene: Scene, assets: Asset[]): number {
  const kind = scene.duration_mode;
  if (kind === "manual")
    return Math.max(3, Math.round(bound(scene.duration, 0.1, 120) * 30)) / 30;
  const settings = kind === "voice" ? scene.voice : scene.video;
  const id = kind === "voice" ? scene.voice_id : scene.video_id;
  return (
    Math.max(
      3,
      Math.round(
        bound(
          settings.offset +
            clipLength(
              settings,
              assets.find((a) => a.id === id),
            ),
          0.1,
          120,
        ) * 30,
      ),
    ) / 30
  );
}
export function buildTimeline(
  project: Pick<ProjectDocument, "scenes">,
  assets: Asset[],
): TimelineEntry[] {
  let end = 0;
  return project.scenes.map((scene, index) => {
    const duration = sceneDuration(scene, assets);
    const previous = project.scenes[index - 1];
    const overlap =
      previous && previous.transition.type !== "none"
        ? Math.floor(
            Math.min(
              Math.max(0, previous.transition.duration),
              sceneDuration(previous, assets) / 2,
              duration / 2,
            ) *
              30 +
              1e-7,
          ) / 30
        : 0;
    const start = Math.max(0, end - overlap);
    end = start + duration;
    return { scene, index, start, end, duration, overlap };
  });
}
export const formatTime = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(Math.max(0, seconds) % 60)
    .toString()
    .padStart(2, "0")}.${Math.floor((Math.max(0, seconds) % 1) * 10)}`;
export function sourceTime(
  clip: ClipSettings,
  asset: Asset | undefined,
  local: number,
): { time: number; active: boolean } {
  const end = clip.trim_end ?? asset?.duration ?? 0;
  const length = Math.max(0, end - clip.trim_start);
  const elapsed = (local - clip.offset) * clip.speed;
  const active =
    local >= clip.offset && length > 0 && (clip.loop || elapsed < length);
  return {
    time:
      clip.trim_start +
      (length > 0
        ? clip.loop && elapsed >= 0
          ? elapsed % length
          : bound(elapsed, 0, Math.max(0, length - 0.025))
        : 0),
    active,
  };
}
