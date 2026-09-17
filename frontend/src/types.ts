export type Ratio = "16:9" | "9:16" | "1:1";
export type AssetKind = "image" | "video" | "voice" | "music" | "character";
export interface ClipSettings {
  trim_start: number;
  trim_end: number | null;
  speed: number;
  volume: number;
  offset: number;
  loop: boolean;
  end_behavior: "hold" | "image";
}
export interface CaptionSettings {
  enabled: boolean;
  text: string;
  style: "plain" | "bubble" | "highlight";
  position: "top" | "center" | "bottom";
  font: string;
  size: number;
  color: string;
  background: string;
  words: { text: string; start: number; end: number; hidden: boolean }[];
}
export interface Layer {
  id: string;
  kind: "text" | "image";
  text: string;
  asset_id: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number | null;
  font_size: number;
  color: string;
  opacity: number;
}
export interface Scene {
  id: string;
  title: string;
  script: string;
  image_prompt: string;
  video_prompt: string;
  character_ids: string[];
  image_id: string | null;
  video_id: string | null;
  voice_id: string | null;
  visual: "image" | "video";
  duration_mode: "manual" | "voice" | "video";
  duration: number;
  video: ClipSettings;
  voice: ClipSettings;
  caption: CaptionSettings;
  effect: {
    type:
      | "none"
      | "zoom_in"
      | "zoom_out"
      | "pan_left"
      | "pan_right"
      | "pan_up"
      | "pan_down"
      | "ken_burns"
      | "drift"
      | "pulse"
      | "rotate"
      | "tilt"
      | "bounce";
    intensity: number;
  };
  transition: {
    type:
      | "none"
      | "fade"
      | "crossfade"
      | "dissolve"
      | "slide_left"
      | "slide_right"
      | "slide_up"
      | "slide_down"
      | "wipe_left"
      | "wipe_right"
      | "wipe_up"
      | "wipe_down"
      | "zoom";
    duration: number;
  };
  layers: Layer[];
}
export interface Character {
  id: string;
  name: string;
  description: string;
  asset_id: string | null;
}
export interface MusicSettings {
  asset_id: string | null;
  volume: number;
  trim_start: number;
  trim_end: number | null;
  loop: boolean;
  fade_in: number;
  fade_out: number;
  ducking: boolean;
}
export interface ProjectDocument {
  name: string;
  kind: "video";
  ratio: Ratio;
  style: string;
  language: string;
  scenes: Scene[];
  characters: Character[];
  music: MusicSettings;
}
export interface Project extends ProjectDocument {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}
export interface Asset {
  id: string;
  project_id: string;
  scene_id: string | null;
  character_id: string | null;
  kind: AssetKind;
  name: string;
  mime_type: string;
  url: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
  source: "upload" | "generated";
  metadata: Record<string, unknown>;
}
export interface Job {
  id: string;
  project_id: string;
  scene_id?: string | null;
  character_id?: string | null;
  kind: string;
  status:
    "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  progress: number;
  error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
}
export interface VideoExport {
  id: string;
  project_id: string;
  revision: number;
  url: string;
  resolution: number;
  duration: number;
  byte_size: number;
  created_at: string;
}
export interface Capabilities {
  project_types: { id: string; label: string; enabled: boolean }[];
  providers: {
    story: boolean;
    image: boolean;
    voice: boolean;
    video: boolean;
    music: boolean;
  };
  voices: { id: string; name: string; description: string }[];
  styles: { id: string; name: string; category: string; prompt: string }[];
  limits: Record<string, number>;
}
export const newClip = (): ClipSettings => ({
  trim_start: 0,
  trim_end: null,
  speed: 1,
  volume: 1,
  offset: 0,
  loop: false,
  end_behavior: "hold",
});
export const newScene = (title = "Scene", script = ""): Scene => ({
  id: crypto.randomUUID(),
  title,
  script,
  image_prompt: "",
  video_prompt: "",
  character_ids: [],
  image_id: null,
  video_id: null,
  voice_id: null,
  visual: "image",
  duration_mode: "manual",
  duration: 6,
  video: { ...newClip(), volume: 0.15 },
  voice: newClip(),
  caption: {
    enabled: true,
    text: "",
    style: "plain",
    position: "bottom",
    font: "DejaVu Sans",
    size: 48,
    color: "#ffffff",
    background: "#00000099",
    words: [],
  },
  effect: { type: "none", intensity: 0.2 },
  transition: { type: "none", duration: 0.5 },
  layers: [],
});
export const newMusic = (): MusicSettings => ({
  asset_id: null,
  volume: 0.15,
  trim_start: 0,
  trim_end: null,
  loop: true,
  fade_in: 0.5,
  fade_out: 1,
  ducking: true,
});
