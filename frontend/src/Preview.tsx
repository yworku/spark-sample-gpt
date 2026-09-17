import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Asset, ClipSettings, Project, Scene } from "./types";
import { bound, buildTimeline, sourceTime } from "./timeline";
import {
  dissolveCells,
  imageMotion,
  incomingTransition,
  outgoingTransition,
} from "./editor-motion";
interface Props {
  project: Project;
  assets: Asset[];
  time: number;
  playing: boolean;
}
function useSyncedMedia(
  ref: React.RefObject<HTMLMediaElement | null>,
  clip: ClipSettings,
  asset: Asset | undefined,
  time: number,
  playing: boolean,
  volume = clip.volume,
) {
  useEffect(() => {
    const node = ref.current;
    if (!node || !asset) return;
    const synchronize = () => {
      const source = sourceTime(clip, asset, time);
      node.volume = bound(volume, 0, 1);
      node.playbackRate = bound(clip.speed, 0.25, 4);
      const tolerance = playing ? 0.14 : 0.001;
      if (
        Number.isFinite(source.time) &&
        Math.abs(node.currentTime - source.time) > tolerance
      ) {
        try {
          node.currentTime = source.time;
        } catch {
          /* Metadata may not have loaded yet. */
        }
      }
      if (playing && source.active) {
        if (node.paused) void node.play().catch(() => {});
      } else node.pause();
    };
    synchronize();
    node.addEventListener("loadedmetadata", synchronize);
    return () => node.removeEventListener("loadedmetadata", synchronize);
  }, [ref, clip, asset, time, playing, volume]);
  useEffect(
    () => () => {
      ref.current?.pause();
    },
    [ref],
  );
}
function SceneSound({
  scene,
  assets,
  time,
  playing,
  audioGain,
}: {
  scene: Scene;
  assets: Asset[];
  time: number;
  playing: boolean;
  audioGain: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const asset = assets.find((a) => a.id === scene.voice_id);
  useSyncedMedia(
    ref,
    scene.voice,
    asset,
    time,
    playing,
    scene.voice.volume * audioGain,
  );
  return asset ? <audio ref={ref} src={asset.url} preload="metadata" /> : null;
}
function SceneVisual({
  scene,
  assets,
  time,
  duration,
  playing,
  height,
  audioGain,
}: {
  scene: Scene;
  assets: Asset[];
  time: number;
  duration: number;
  playing: boolean;
  height: number;
  audioGain: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const asset = assets.find(
    (a) =>
      a.id === (scene.visual === "video" ? scene.video_id : scene.image_id),
  );
  const fallback = assets.find((a) => a.id === scene.image_id);
  const source = sourceTime(scene.video, asset, time);
  useSyncedMedia(
    videoRef,
    scene.video,
    asset,
    time,
    playing,
    scene.video.volume * audioGain,
  );
  const effect = imageMotion(scene, time, duration);
  const isVideo = scene.visual === "video" && asset?.kind === "video";
  const afterVideo = time >= scene.video.offset && !source.active;
  const showFallback =
    isVideo &&
    (time < scene.video.offset ||
      (afterVideo && scene.video.end_behavior === "image"));
  const caption = scene.caption;
  const captionText = caption.words.length
    ? caption.words
        .filter((w) => !w.hidden && time >= w.start && time < w.end)
        .map((w) => w.text)
        .join(" ")
    : caption.text || scene.script;
  const fontScale = height / 1080;
  return (
    <>
      <div className="editor-scene-picture" style={effect}>
        {asset ? (
          isVideo ? (
            <>
              <video
                ref={videoRef}
                src={asset.url}
                playsInline
                preload="auto"
                style={{ visibility: showFallback ? "hidden" : "visible" }}
              />
              {showFallback && fallback && (
                <img src={fallback.url} alt="Scene illustration" />
              )}
            </>
          ) : (
            <img src={asset.url} alt={scene.title} />
          )
        ) : null}
      </div>
      {scene.layers
        .filter(
          (layer) =>
            time >= layer.start && (layer.end === null || time < layer.end),
        )
        .map((layer) => (
          <div
            key={layer.id}
            className={`editor-layer editor-layer-${layer.kind}`}
            style={{
              left: `${layer.x * 100}%`,
              top: `${layer.y * 100}%`,
              width: `${layer.width * 100}%`,
              height: `${layer.height * 100}%`,
              opacity: layer.opacity,
              fontSize: layer.font_size * fontScale,
              color: layer.color,
            }}
          >
            {layer.kind === "text"
              ? layer.text
              : assets.find((a) => a.id === layer.asset_id) && (
                  <img
                    src={assets.find((a) => a.id === layer.asset_id)!.url}
                    alt="Scene overlay"
                  />
                )}
          </div>
        ))}
      {caption.enabled && captionText && (
        <div
          className={`editor-caption editor-caption-${caption.position} editor-caption-${caption.style}`}
          style={{
            fontFamily: caption.font,
            fontSize: caption.size * fontScale,
            color: caption.color,
          }}
        >
          <span
            style={{ background: caption.background, padding: 18 * fontScale }}
          >
            {captionText}
          </span>
        </div>
      )}
      <SceneSound
        scene={scene}
        assets={assets}
        time={time}
        playing={playing}
        audioGain={audioGain}
      />
    </>
  );
}
function Music({
  project,
  assets,
  time,
  playing,
}: {
  project: Project;
  assets: Asset[];
  time: number;
  playing: boolean;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const asset = assets.find((a) => a.id === project.music.asset_id);
  const timeline = buildTimeline(project, assets);
  const total = timeline.at(-1)?.end ?? 0;
  const music = project.music;
  const duck =
    music.ducking &&
    timeline.some(
      (e) =>
        time >= e.start &&
        time < e.end &&
        e.scene.voice.volume > 0 &&
        assets.some((a) => a.id === e.scene.voice_id) &&
        sourceTime(
          e.scene.voice,
          assets.find((a) => a.id === e.scene.voice_id),
          time - e.start,
        ).active,
    );
  const gain =
    (music.fade_in > 0
      ? bound(time / Math.min(music.fade_in, total), 0, 1)
      : 1) *
    (music.fade_out > 0
      ? bound((total - time) / Math.min(music.fade_out, total), 0, 1)
      : 1) *
    (duck ? 0.35 : 1);
  const clip = useMemo(
    () => ({
      trim_start: music.trim_start,
      trim_end: music.trim_end,
      speed: 1,
      volume: music.volume,
      offset: 0,
      loop: music.loop,
      end_behavior: "hold" as const,
    }),
    [music],
  );
  useSyncedMedia(ref, clip, asset, time, playing, music.volume * gain);
  return asset ? <audio ref={ref} src={asset.url} preload="metadata" /> : null;
}
export default function Preview({ project, assets, time, playing }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 960, height: 540 });
  const height = dimensions.height;
  const timeline = useMemo(
    () => buildTimeline(project, assets),
    [project, assets],
  );
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const parts = project.ratio.split(":").map(Number);
      const ratio = parts[0] / parts[1];
      const width = Math.min(
        node.clientWidth,
        Math.max(1, node.clientHeight - 19) * ratio,
      );
      setDimensions({ width, height: width / ratio });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [project.ratio]);
  const last = timeline.at(-1);
  const actual = Math.min(time, Math.max(0, (last?.end ?? 0) - 0.001));
  const active = timeline.filter(
    (entry) => actual >= entry.start && actual < entry.end,
  );
  return (
    <div ref={ref} className="editor-preview-wrap">
      <div
        className="editor-preview-stage"
        style={{ width: dimensions.width, height: dimensions.height }}
      >
        {active.map((entry) => {
          const style: CSSProperties = { zIndex: entry.index };
          const previous = timeline[entry.index - 1];
          const incoming =
            previous &&
            entry.overlap > 0 &&
            actual < entry.start + entry.overlap;
          const progress = incoming
            ? bound((actual - entry.start) / entry.overlap, 0, 1)
            : 1;
          const maskId = `dissolve-${entry.scene.id}`;
          if (incoming)
            Object.assign(
              style,
              incomingTransition(
                previous.scene.transition.type,
                progress,
                maskId,
              ),
            );
          const next = timeline[entry.index + 1];
          if (next && next.overlap > 0 && actual >= next.start)
            Object.assign(
              style,
              outgoingTransition(
                entry.scene.transition.type,
                (actual - next.start) / next.overlap,
              ),
            );
          return (
            <div
              key={entry.scene.id}
              className="editor-active-scene"
              style={style}
            >
              {incoming && previous.scene.transition.type === "dissolve" && (
                <svg
                  width="0"
                  height="0"
                  aria-hidden="true"
                  style={{ position: "absolute" }}
                >
                  <defs>
                    <clipPath id={maskId} clipPathUnits="objectBoundingBox">
                      {dissolveCells
                        .filter((cell) => progress >= cell.threshold)
                        .map((cell) => (
                          <rect
                            key={`${cell.x}-${cell.y}`}
                            x={cell.x / 32}
                            y={cell.y / 18}
                            width={1 / 32 + 0.000001}
                            height={1 / 18 + 0.000001}
                          />
                        ))}
                    </clipPath>
                  </defs>
                </svg>
              )}
              <SceneVisual
                scene={entry.scene}
                assets={assets}
                time={actual - entry.start}
                duration={entry.duration}
                playing={playing}
                height={height}
                audioGain={
                  (entry.overlap > 0
                    ? bound((actual - entry.start) / entry.overlap, 0, 1)
                    : 1) *
                  (next && next.overlap > 0
                    ? bound((entry.end - actual) / next.overlap, 0, 1)
                    : 1)
                }
              />
            </div>
          );
        })}
        {active.length === 0 && (
          <div className="editor-empty-preview">
            <strong>Add your first scene</strong>
            <span>Your story will appear here</span>
          </div>
        )}
      </div>
      <Music project={project} assets={assets} time={time} playing={playing} />
    </div>
  );
}
