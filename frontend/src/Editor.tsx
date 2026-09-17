import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "./api";
import type {
  Asset,
  AssetKind,
  Capabilities,
  ClipSettings,
  Job,
  Layer,
  Project,
  ProjectDocument,
  Scene,
  VideoExport,
} from "./types";
import { newScene } from "./types";
import Preview from "./Preview";
import { bound, buildTimeline, formatTime } from "./timeline";
import "./editor.css";
interface Props {
  project: Project;
  onBack: () => void;
  onProject: (project: Project) => void;
  capabilities: Capabilities;
}
type Panel = "visual" | "voice" | "captions" | "layers";
const documentOf = (p: Project): ProjectDocument => ({
  name: p.name,
  kind: p.kind,
  ratio: p.ratio,
  style: p.style,
  language: p.language,
  scenes: p.scenes,
  characters: p.characters,
  music: p.music,
});
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    back: "m14 6-6 6 6 6",
    play: "m8 5 11 7-11 7Z",
    pause: "M8 5v14M16 5v14",
    plus: "M12 5v14M5 12h14",
    image: "M4 4h16v16H4ZM4 16l5-5 4 4 3-3 4 4M15 8h.01",
    video: "M3 5h13v14H3ZM16 9l5-3v12l-5-3",
    voice:
      "M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8",
    music:
      "M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3ZM20 16a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3Z",
    download: "M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6",
    undo: "M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
    copy: "M8 8h12v13H8ZM4 16H2V2h12v2",
    close: "m6 6 12 12M6 18 18 6",
    check: "m4 12 5 5L20 6",
    spark: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z",
    people:
      "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-2a7 7 0 0 1 14 0v2M17 4a4 4 0 0 1 0 7M19 15a6 6 0 0 1 3 6",
    captions: "M3 5h18v14H3ZM10 9H7v6h3M18 9h-3v6h3",
    layers: "m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5",
    arrow: "m9 5 7 7-7 7",
    upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.spark} />
    </svg>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="e-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 120,
  step = 0.1,
  nullable = false,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        placeholder={nullable ? "Full clip" : ""}
        onChange={(e) => {
          if (e.target.value === "") {
            if (nullable) onChange(null);
            return;
          }
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) onChange(bound(n, min, max));
        }}
      />
    </Field>
  );
}
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="e-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
function Section({
  title,
  children,
  open = true,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="e-section" open={open}>
      <summary>
        {title}
        <span>⌄</span>
      </summary>
      <div className="e-section-body">{children}</div>
    </details>
  );
}
function ClipControls({
  clip,
  onChange,
  isVideo = false,
}: {
  clip: ClipSettings;
  onChange: (clip: ClipSettings) => void;
  isVideo?: boolean;
}) {
  const patch = (p: Partial<ClipSettings>) => onChange({ ...clip, ...p });
  return (
    <>
      <div className="e-two">
        <NumberField
          label="Trim start (s)"
          value={clip.trim_start}
          onChange={(v) => patch({ trim_start: v ?? 0 })}
        />
        <NumberField
          label="Trim end (s)"
          value={clip.trim_end}
          nullable
          onChange={(v) => patch({ trim_end: v })}
        />
        <NumberField
          label="Start in scene (s)"
          value={clip.offset}
          onChange={(v) => patch({ offset: v ?? 0 })}
        />
        <NumberField
          label="Playback speed"
          value={clip.speed}
          min={0.25}
          max={4}
          step={0.25}
          onChange={(v) => patch({ speed: v ?? 1 })}
        />
      </div>
      <Field label={`Volume · ${Math.round(clip.volume * 100)}%`}>
        <input
          type="range"
          min="0"
          max="1"
          step=".01"
          value={clip.volume}
          onChange={(e) => patch({ volume: +e.target.value })}
        />
      </Field>
      <Toggle
        label="Loop clip"
        value={clip.loop}
        onChange={(loop) => patch({ loop })}
      />
      {isVideo && (
        <Field label="When the clip ends">
          <select
            value={clip.end_behavior}
            onChange={(e) =>
              patch({
                end_behavior: e.target.value as ClipSettings["end_behavior"],
              })
            }
          >
            <option value="hold">Hold the last frame</option>
            <option value="image">Return to scene image</option>
          </select>
        </Field>
      )}
    </>
  );
}
function Modal({
  title,
  onClose,
  children,
  wide = false,
  error,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      className={`e-modal ${wide ? "e-modal-wide" : ""}`}
      ref={ref}
      onCancel={onClose}
      onClick={(event) => {
        const rect = ref.current?.getBoundingClientRect();
        if (
          event.target === ref.current &&
          rect &&
          (event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom)
        )
          onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="e-icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {error && (
        <p className="e-error" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
function Jobs({
  jobs,
  onCancel,
}: {
  jobs: Job[];
  onCancel: (job: Job) => void;
}) {
  if (!jobs.length) return null;
  return (
    <div className="e-jobs">
      {jobs.slice(0, 5).map((job) => (
        <div className={`e-job e-job-${job.status}`} key={job.id}>
          <div>
            <strong>
              {job.kind.replace("_", " ")}{" "}
              {job.kind === "export" ? "" : "generation"}
            </strong>
            <span>
              {job.status === "unknown" ? "Status uncertain" : job.status}
            </span>
            {["queued", "running"].includes(job.status) && (
              <button className="e-link" onClick={() => onCancel(job)}>
                Cancel
              </button>
            )}
          </div>
          {["queued", "running"].includes(job.status) && (
            <progress
              max="1"
              value={job.progress > 1 ? job.progress / 100 : job.progress}
            />
          )}
          <small>
            {job.error ??
              (job.status === "succeeded"
                ? "Ready to review below."
                : job.status === "unknown"
                  ? "The provider response is uncertain. Review its status before creating another request."
                  : "")}
          </small>
        </div>
      ))}
    </div>
  );
}
export default function Editor({
  project: initial,
  onBack,
  onProject,
  capabilities,
}: Props) {
  const [project, setProject] = useState(initial);
  const current = useRef(initial);
  const revision = useRef(initial.revision);
  const saved = useRef(JSON.stringify(documentOf(initial)));
  const pending = useRef<Promise<Project> | null>(null);
  const blocked = useRef(false);
  const [saveState, setSaveState] = useState("All changes saved");
  const [error, setError] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [exports, setExports] = useState<VideoExport[]>([]);
  const [selected, setSelected] = useState(initial.scenes[0]?.id ?? "");
  const [panel, setPanel] = useState<Panel>("visual");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [modal, setModal] = useState<"music" | "characters" | "export" | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const [undo, setUndo] = useState<ProjectDocument[]>([]);
  const [editPrompt, setEditPrompt] = useState("");
  const [voice, setVoice] = useState(capabilities.voices[0]?.id ?? "alloy");
  const [resolution, setResolution] = useState(720);
  const [quality, setQuality] = useState("high");
  const [musicLibrary, setMusicLibrary] = useState<Asset[] | null>(null);
  const [characterLibrary, setCharacterLibrary] = useState<Array<{
    id: string;
    source_project_id: string;
    source_character_id: string;
    project_name: string;
    name: string;
    description: string;
    asset: Asset | null;
  }> | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const selectedScene =
    project.scenes.find((s) => s.id === selected) ?? project.scenes[0];
  const timeline = useMemo(
    () => buildTimeline(project, assets),
    [project, assets],
  );
  const total = timeline.at(-1)?.end ?? 0;
  const sceneOrder = project.scenes.map((s) => s.id).join(",");
  const change = useCallback(
    (fn: (document: Project) => Project, remember = true) => {
      const previous = current.current;
      const next = fn(previous);
      if (remember)
        setUndo((stack) => [...stack.slice(-29), documentOf(previous)]);
      current.current = next;
      setProject(next);
      setSaveState("Unsaved changes");
    },
    [],
  );
  const patchScene = (patch: Partial<Scene>, id = selectedScene?.id) =>
    change((p) => ({
      ...p,
      scenes: p.scenes.map((s) =>
        s.id === id
          ? {
              ...s,
              ...patch,
              ...(patch.visual === "video"
                ? {
                    effect: {
                      type: "none" as const,
                      intensity: s.effect.intensity,
                    },
                  }
                : {}),
            }
          : s,
      ),
    }));
  const saveNow = useCallback(async (): Promise<Project> => {
    if (blocked.current)
      throw new Error(
        "Reload the current project before continuing, or download your local edits.",
      );
    if (pending.current) {
      await pending.current;
      if (JSON.stringify(documentOf(current.current)) !== saved.current)
        return saveNow();
      return current.current;
    }
    const document = documentOf(current.current);
    const fingerprint = JSON.stringify(document);
    if (fingerprint === saved.current) return current.current;
    setSaveState("Saving…");
    const work = api
      .saveProject(current.current.id, revision.current, document)
      .then((result) => {
        revision.current = result.revision;
        saved.current = fingerprint;
        const next = {
          ...current.current,
          revision: result.revision,
          updated_at: result.updated_at,
        };
        current.current = next;
        setProject(next);
        onProject(next);
        setSaveState(
          JSON.stringify(documentOf(next)) === fingerprint
            ? "All changes saved"
            : "Unsaved changes",
        );
        return next;
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          blocked.current = true;
          setSaveState("Changes need your attention");
        } else setSaveState("Could not save");
        setError(message(e));
        throw e;
      })
      .finally(() => {
        pending.current = null;
      });
    pending.current = work;
    const result = await work;
    if (JSON.stringify(documentOf(current.current)) !== saved.current)
      return saveNow();
    return result;
  }, [onProject]);
  useEffect(() => {
    if (
      JSON.stringify(documentOf(project)) === saved.current ||
      blocked.current
    )
      return;
    const timer = setTimeout(() => void saveNow().catch(() => {}), 750);
    return () => clearTimeout(timer);
  }, [project, saveNow]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(documentOf(current.current)) !== saved.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onNavigate = (event: Event) => {
      if (
        JSON.stringify(documentOf(current.current)) !== saved.current ||
        pending.current
      ) {
        event.preventDefault();
        void saveNow()
          .then(() => window.history.back())
          .catch(() => {});
      }
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("spark-before-navigate", onNavigate);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("spark-before-navigate", onNavigate);
    };
  }, [saveNow]);
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api.assets(initial.id),
      api.jobs(initial.id),
      api.exports(initial.id),
    ]);
    if (results[0].status === "fulfilled") setAssets(results[0].value);
    if (results[1].status === "fulfilled") setJobs(results[1].value);
    if (results[2].status === "fulfilled") setExports(results[2].value);
    const rejected = results.find((r) => r.status === "rejected");
    if (rejected?.status === "rejected") setError(message(rejected.reason));
  }, [initial.id]);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - previous) / 1000;
      previous = now;
      setTime((value) => {
        if (value + elapsed >= total) {
          setPlaying(false);
          return total;
        }
        return value + elapsed;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total]);
  useEffect(() => {
    setTime((t) => Math.min(t, total));
  }, [total]);
  useEffect(() => {
    const entry = timeline.find((item) => item.scene.id === selected);
    if (entry) {
      setTime(Math.min(entry.end - 0.001, entry.start + entry.overlap));
      setPlaying(false);
    }
  }, [selected, sceneOrder]);
  const chooseScene = (id: string) => {
    setSelected(id);
    setPlaying(false);
    const entry = timeline.find((e) => e.scene.id === id);
    setTime(
      entry ? Math.min(entry.end - 0.001, entry.start + entry.overlap) : 0,
    );
  };
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };
  const generate = (
    kind: string,
    settings: Record<string, unknown> = {},
    prompt?: string,
    character_id?: string,
  ) =>
    void run(`generate-${kind}`, async () => {
      const p = await saveNow();
      const job = await api.job(p.id, {
        kind,
        base_revision: p.revision,
        scene_id: [
          "image",
          "image_edit",
          "voice",
          "video",
          "caption_align",
        ].includes(kind)
          ? selectedScene?.id
          : undefined,
        character_id,
        prompt,
        settings,
      });
      setJobs((old) => [job, ...old]);
      await refresh();
    });
  const upload = (
    file: File | undefined,
    kind: AssetKind,
    character_id?: string,
  ) => {
    if (!file) return;
    void run(`upload-${kind}`, async () => {
      const sceneId = ["image", "video", "voice"].includes(kind)
        ? selectedScene?.id
        : undefined;
      await saveNow();
      const result = await api.upload(
        project.id,
        file,
        kind,
        sceneId,
        character_id,
      );
      setAssets((old) => [result, ...old]);
      if (kind === "music")
        change((p) => ({ ...p, music: { ...p.music, asset_id: result.id } }));
      else if (kind === "character")
        change((p) => ({
          ...p,
          characters: p.characters.map((c) =>
            c.id === character_id ? { ...c, asset_id: result.id } : c,
          ),
        }));
      else if (sceneId)
        patchScene(
          kind === "image"
            ? { image_id: result.id, visual: "image" }
            : kind === "video"
              ? { video_id: result.id, visual: "video" }
              : { voice_id: result.id },
          sceneId,
        );
    });
  };
  const openMusicLibrary = () =>
    void run("music-library", async () =>
      setMusicLibrary(await api.libraryAssets("music")),
    );
  const openCharacterLibrary = () =>
    void run("character-library", async () =>
      setCharacterLibrary(await api.libraryCharacters()),
    );
  const importMusic = (source: Asset) =>
    void run("import-music", async () => {
      const imported = await api.importAsset(project.id, {
        source_asset_id: source.id,
      });
      setAssets((old) => [imported, ...old]);
      change((p) => ({ ...p, music: { ...p.music, asset_id: imported.id } }));
      setMusicLibrary(null);
    });
  const importCharacter = (source: {
    source_project_id: string;
    source_character_id: string;
  }) =>
    void run("import-character", async () => {
      const base = await saveNow();
      const work = api
        .importCharacter(project.id, {
          source_project_id: source.source_project_id,
          source_character_id: source.source_character_id,
          base_revision: base.revision,
        })
        .then((result) => {
          const added = result.characters.filter(
            (character) =>
              !base.characters.some((existing) => existing.id === character.id),
          );
          setUndo((stack) => [
            ...stack.slice(-29),
            documentOf(current.current),
          ]);
          const next = {
            ...current.current,
            characters: [...current.current.characters, ...added],
            revision: result.revision,
            updated_at: result.updated_at,
          };
          revision.current = result.revision;
          saved.current = JSON.stringify(documentOf(result));
          current.current = next;
          setProject(next);
          onProject(next);
          setSaveState(
            JSON.stringify(documentOf(next)) === saved.current
              ? "All changes saved"
              : "Unsaved changes",
          );
          return next;
        })
        .catch((e) => {
          if (e instanceof ApiError && e.status === 409) {
            blocked.current = true;
            setSaveState("Changes need your attention");
          }
          throw e;
        })
        .finally(() => {
          pending.current = null;
        });
      pending.current = work;
      await work;
      await refresh();
      setCharacterLibrary(null);
    });
  const UploadButton = ({
    kind,
    label = "Upload",
    character_id,
  }: {
    kind: AssetKind;
    label?: string;
    character_id?: string;
  }) => (
    <label className={`e-btn e-upload ${busy ? "e-disabled" : ""}`}>
      <Icon name="upload" />
      {label}
      <input
        type="file"
        disabled={!!busy}
        accept={
          kind === "voice" || kind === "music"
            ? "audio/*"
            : kind === "video"
              ? "video/*"
              : "image/*"
        }
        onChange={(e) => {
          upload(e.target.files?.[0], kind, character_id);
          e.target.value = "";
        }}
      />
    </label>
  );
  const cancel = (job: Job) =>
    void run("cancel", async () => {
      await api.cancelJob(job.id);
      await refresh();
    });
  const alternatives = (kind: AssetKind) =>
    assets.filter(
      (a) =>
        a.kind === kind &&
        (a.scene_id === selectedScene?.id || a.scene_id === null),
    );
  const versions = (kind: "image" | "video" | "voice") => (
    <div className={`e-versions e-versions-${kind}`}>
      {alternatives(kind).length === 0 ? (
        <p className="e-muted">
          Your {kind === "voice" ? "narration" : kind} versions will appear
          here.
        </p>
      ) : (
        alternatives(kind).map((asset) => (
          <button
            key={asset.id}
            className={`e-version ${selectedScene?.[`${kind}_id`] === asset.id ? "selected" : ""}`}
            onClick={() =>
              patchScene(
                kind === "image"
                  ? { image_id: asset.id, visual: "image" }
                  : kind === "video"
                    ? { video_id: asset.id, visual: "video" }
                    : { voice_id: asset.id },
              )
            }
          >
            {kind === "image" ? (
              <img src={asset.url} alt={asset.name} />
            ) : kind === "video" ? (
              <video src={asset.url} preload="metadata" />
            ) : (
              <Icon name="voice" />
            )}
            <span>{asset.name}</span>
            {selectedScene?.[`${kind}_id`] === asset.id && (
              <b>
                <Icon name="check" size={12} />
              </b>
            )}
          </button>
        ))
      )}
    </div>
  );
  const reorder = (id: string, targetId: string) => {
    if (id === targetId) return;
    change((p) => {
      const scenes = [...p.scenes];
      const from = scenes.findIndex((s) => s.id === id);
      const to = scenes.findIndex((s) => s.id === targetId);
      if (from < 0 || to < 0) return p;
      scenes.splice(to, 0, scenes.splice(from, 1)[0]);
      return { ...p, scenes };
    });
  };
  const addScene = () => {
    if (project.scenes.length >= 50) {
      setError("This video can contain up to 50 scenes.");
      return;
    }
    const scene = newScene(`Scene ${project.scenes.length + 1}`);
    change((p) => ({ ...p, scenes: [...p.scenes, scene] }));
    setSelected(scene.id);
    setPlaying(false);
    setTime(total);
  };
  const duplicate = () => {
    if (!selectedScene || project.scenes.length >= 50) return;
    const copy = {
      ...structuredClone(selectedScene),
      id: crypto.randomUUID(),
      title: `${selectedScene.title} copy`,
      layers: selectedScene.layers.map((l) => ({
        ...l,
        id: crypto.randomUUID(),
      })),
    };
    change((p) => {
      const scenes = [...p.scenes];
      scenes.splice(
        scenes.findIndex((s) => s.id === selectedScene.id) + 1,
        0,
        copy,
      );
      return { ...p, scenes };
    });
    setSelected(copy.id);
    setPlaying(false);
  };
  const remove = () => {
    if (!selectedScene) return;
    const scenes = project.scenes.filter((s) => s.id !== selectedScene.id);
    change((p) => ({ ...p, scenes }));
    setSelected(scenes[0]?.id ?? "");
    setTime(0);
    setPlaying(false);
  };
  const undoLast = () => {
    const old = undo.at(-1);
    if (!old) return;
    setUndo(undo.slice(0, -1));
    change((p) => ({ ...p, ...old }), false);
    setPlaying(false);
    if (!old.scenes.some((s) => s.id === selected))
      setSelected(old.scenes[0]?.id ?? "");
  };
  const addLayer = (kind: "text" | "image") => {
    const image = assets.find(
      (asset) => asset.kind === "image" || asset.kind === "character",
    );
    if (kind === "image" && !image) {
      setError(
        "Upload an image in the Visual tab before adding an image layer.",
      );
      return;
    }
    const layer: Layer = {
      id: crypto.randomUUID(),
      kind,
      text: kind === "text" ? "Your text" : "",
      asset_id: kind === "image" ? image!.id : null,
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.2,
      start: 0,
      end: null,
      font_size: 64,
      color: "#ffffff",
      opacity: 1,
    };
    patchScene({ layers: [...selectedScene.layers, layer] });
  };
  const patchLayer = (id: string, patch: Partial<Layer>) =>
    patchScene({
      layers: selectedScene.layers.map((l) =>
        l.id === id
          ? (() => {
              const next = { ...l, ...patch };
              next.width = bound(next.width, 0.01, 1);
              next.height = bound(next.height, 0.01, 1);
              next.x = bound(next.x, 0, 1 - next.width);
              next.y = bound(next.y, 0, 1 - next.height);
              return next;
            })()
          : l,
      ),
    });
  const projectJobs = jobs.filter((job) => job.kind === "export");
  const sceneJobs = jobs.filter(
    (job) =>
      ((job as Job & { scene_id?: string | null }).scene_id ??
        job.result?.scene_id) === selectedScene?.id,
  );
  const alignmentJobs = sceneJobs.filter((job) => job.kind === "caption_align");
  const alignmentMatches = (job: Job, scene: Scene) => {
    const result = job.result;
    if (
      !result ||
      result.scene_id !== scene.id ||
      result.voice_id !== scene.voice_id
    )
      return false;
    const clipMatches = (currentClip: ClipSettings, captured: unknown) =>
      !!captured &&
      typeof captured === "object" &&
      Object.entries(currentClip).every(
        ([key, value]) => (captured as Record<string, unknown>)[key] === value,
      );
    const timing = result.scene_timing as
      | {
          duration_mode?: string;
          duration?: number;
          video_id?: string | null;
          video?: unknown;
        }
      | undefined;
    return (
      clipMatches(scene.voice, result.voice_settings) &&
      !!timing &&
      timing.duration_mode === scene.duration_mode &&
      timing.duration === scene.duration &&
      timing.video_id === scene.video_id &&
      clipMatches(scene.video, timing.video)
    );
  };
  const applyAlignment = (job: Job) => {
    const target = current.current.scenes.find(
      (scene) => scene.id === selectedScene.id,
    );
    if (!target || !alignmentMatches(job, target)) {
      setError(
        "Narration or scene timing changed. Sync captions again before applying this result.",
      );
      return;
    }
    const words = job.result?.words;
    if (
      !Array.isArray(words) ||
      !words.length ||
      !words.every(
        (word) =>
          word &&
          typeof word.text === "string" &&
          Number.isFinite(word.start) &&
          Number.isFinite(word.end) &&
          word.start >= 0 &&
          word.end > word.start,
      )
    ) {
      setError(
        "No usable word timing was returned. Review the narration and sync again.",
      );
      return;
    }
    patchScene(
      {
        caption: {
          ...target.caption,
          enabled: true,
          words: words.map((word) => ({
            text: word.text,
            start: word.start,
            end: word.end,
            hidden: false,
          })),
        },
      },
      target.id,
    );
  };
  return (
    <div className="editor">
      <header className="editor-topbar">
        <div className="editor-project-heading">
          <button
            className="e-icon-button"
            aria-label="Back to guide"
            onClick={() =>
              void run("back", async () => {
                await saveNow();
                onBack();
              })
            }
          >
            <Icon name="back" />
          </button>
          <span className="editor-brand-mark">
            <Icon name="spark" />
          </span>
          <input
            aria-label="Project name"
            value={project.name}
            onChange={(e) => change((p) => ({ ...p, name: e.target.value }))}
          />
          <span className="e-save-status">
            <Icon
              name={saveState === "All changes saved" ? "check" : "upload"}
              size={13}
            />
            {saveState}
          </span>
        </div>
        <nav>
          <button className="e-btn" onClick={() => setModal("characters")}>
            <Icon name="people" />
            Characters
          </button>
          <button className="e-btn" onClick={() => setModal("music")}>
            <Icon name="music" />
            Music
          </button>
          <button
            className="e-btn e-primary"
            onClick={() => {
              setPlaying(false);
              setModal("export");
            }}
          >
            <Icon name="download" />
            Export video
          </button>
        </nav>
      </header>
      {error && (
        <div className="e-error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
      {blocked.current && (
        <div className="e-conflict">
          <span>
            This project changed in another session. Your local edits are still
            here.
          </span>
          <button
            className="e-btn"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [JSON.stringify(documentOf(current.current), null, 2)],
                  { type: "application/json" },
                ),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "spark-local-edits.json";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Download local edits
          </button>
          <button
            className="e-btn"
            onClick={() =>
              void run("reload", async () => {
                const fresh = await api.project(project.id);
                current.current = fresh;
                revision.current = fresh.revision;
                saved.current = JSON.stringify(documentOf(fresh));
                blocked.current = false;
                setProject(fresh);
                onProject(fresh);
                setUndo([]);
                setSaveState("All changes saved");
                setError("");
              })
            }
          >
            Reload saved project
          </button>
        </div>
      )}
      <main className="editor-workspace">
        <section className="editor-canvas-area">
          <div className="editor-canvas-toolbar">
            <span>
              <span className="e-dot" />{" "}
              {playing ? "Playing your story" : "Video preview"}
            </span>
            <div>
              <select
                aria-label="Video aspect ratio"
                value={project.ratio}
                onChange={(e) =>
                  change((p) => ({
                    ...p,
                    ratio: e.target.value as Project["ratio"],
                  }))
                }
              >
                <option value="16:9">16:9 · Landscape</option>
                <option value="9:16">9:16 · Portrait</option>
                <option value="1:1">1:1 · Square</option>
              </select>
              <button
                className="e-icon-button"
                title="Undo last edit"
                aria-label="Undo last edit"
                disabled={!undo.length}
                onClick={undoLast}
              >
                <Icon name="undo" />
              </button>
            </div>
          </div>
          <Preview
            project={project}
            assets={assets}
            time={time}
            playing={playing}
          />
          <div className="editor-playback">
            <button
              className="editor-play-button"
              aria-label={playing ? "Pause video" : "Play video"}
              disabled={!project.scenes.length}
              onClick={() => {
                if (time >= total) setTime(0);
                setPlaying(!playing);
              }}
            >
              <Icon name={playing ? "pause" : "play"} size={18} />
            </button>
            <span className="editor-time">
              {formatTime(time)} <span>/ {formatTime(total)}</span>
            </span>
            <input
              type="range"
              aria-label="Video playhead"
              min="0"
              max={total || 1}
              step=".01"
              value={time}
              onChange={(e) => {
                setTime(+e.target.value);
                setPlaying(false);
              }}
            />
            <span className="e-muted">{project.scenes.length} scenes</span>
          </div>
        </section>
        <aside className="editor-inspector">
          {selectedScene ? (
            <>
              <div className="editor-inspector-heading">
                <span>
                  SCENE{" "}
                  {project.scenes.findIndex((s) => s.id === selectedScene.id) +
                    1}
                </span>
                <input
                  aria-label="Scene title"
                  value={selectedScene.title}
                  onChange={(e) => patchScene({ title: e.target.value })}
                />
                <div>
                  <button
                    className="e-icon-button"
                    aria-label="Duplicate scene"
                    title="Duplicate scene"
                    onClick={duplicate}
                    disabled={project.scenes.length >= 50}
                  >
                    <Icon name="copy" size={16} />
                  </button>
                  <button
                    className="e-icon-button"
                    aria-label="Delete scene (can be undone)"
                    title="Delete scene"
                    onClick={remove}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </div>
              <div className="editor-panel-tabs">
                {(["visual", "voice", "captions", "layers"] as Panel[]).map(
                  (p) => (
                    <button
                      key={p}
                      className={panel === p ? "active" : ""}
                      onClick={() => setPanel(p)}
                    >
                      <Icon name={p === "visual" ? "image" : p} />
                      <span>
                        {p === "visual"
                          ? "Visual"
                          : p === "voice"
                            ? "Voice"
                            : p === "captions"
                              ? "Captions"
                              : "Layers"}
                      </span>
                    </button>
                  ),
                )}
              </div>
              <div className="editor-inspector-scroll">
                {panel === "visual" && (
                  <>
                    <div className="e-segmented">
                      <button
                        className={
                          selectedScene.visual === "image" ? "active" : ""
                        }
                        onClick={() => patchScene({ visual: "image" })}
                      >
                        <Icon name="image" />
                        Image
                      </button>
                      <button
                        className={
                          selectedScene.visual === "video" ? "active" : ""
                        }
                        onClick={() => patchScene({ visual: "video" })}
                      >
                        <Icon name="video" />
                        Video
                      </button>
                    </div>
                    <Section
                      title={
                        selectedScene.visual === "image"
                          ? "Scene image"
                          : "Scene video"
                      }
                    >
                      <Field
                        label={
                          selectedScene.visual === "image"
                            ? "Describe the image"
                            : "Describe the motion"
                        }
                      >
                        <textarea
                          rows={4}
                          placeholder={
                            selectedScene.visual === "image"
                              ? "A sunlit forest, a small explorer, a magical discovery…"
                              : "Describe how the scene moves…"
                          }
                          value={
                            selectedScene.visual === "image"
                              ? selectedScene.image_prompt
                              : selectedScene.video_prompt
                          }
                          onChange={(e) =>
                            patchScene(
                              selectedScene.visual === "image"
                                ? { image_prompt: e.target.value }
                                : { video_prompt: e.target.value },
                            )
                          }
                        />
                      </Field>
                      {project.characters.length > 0 && (
                        <div className="e-character-chips">
                          {project.characters.map((c) => (
                            <label
                              key={c.id}
                              className={
                                selectedScene.character_ids.includes(c.id)
                                  ? "active"
                                  : ""
                              }
                            >
                              <input
                                type="checkbox"
                                checked={selectedScene.character_ids.includes(
                                  c.id,
                                )}
                                onChange={(e) =>
                                  patchScene({
                                    character_ids: e.target.checked
                                      ? [...selectedScene.character_ids, c.id]
                                      : selectedScene.character_ids.filter(
                                          (id) => id !== c.id,
                                        ),
                                  })
                                }
                              />
                              {c.name}
                            </label>
                          ))}
                        </div>
                      )}
                      <div className="e-two-actions">
                        <UploadButton kind={selectedScene.visual} />
                        <button
                          className="e-btn e-primary"
                          disabled={
                            !!busy ||
                            !capabilities.providers[selectedScene.visual]
                          }
                          onClick={() => generate(selectedScene.visual)}
                        >
                          <Icon name="spark" />
                          Generate
                        </button>
                      </div>
                      {!capabilities.providers[selectedScene.visual] && (
                        <p className="e-muted">
                          {selectedScene.visual === "image" ? "Image" : "Video"}{" "}
                          generation is not connected. Upload your own media to
                          continue.
                        </p>
                      )}
                      <Jobs
                        jobs={sceneJobs
                          .filter(
                            (j) =>
                              j.kind === selectedScene.visual ||
                              (selectedScene.visual === "image" &&
                                j.kind === "image_edit"),
                          )
                          .slice(0, 2)}
                        onCancel={cancel}
                      />
                      {versions(selectedScene.visual)}
                    </Section>
                    {selectedScene.visual === "image" &&
                      selectedScene.image_id && (
                        <Section title="Edit this image" open={false}>
                          <Field label="What would you like to change?">
                            <textarea
                              rows={3}
                              value={editPrompt}
                              onChange={(e) => setEditPrompt(e.target.value)}
                              placeholder="Make the sky golden and add soft clouds…"
                            />
                          </Field>
                          <button
                            className="e-btn e-primary"
                            disabled={
                              !!busy ||
                              !editPrompt.trim() ||
                              !capabilities.providers.image
                            }
                            onClick={() =>
                              generate("image_edit", {}, editPrompt)
                            }
                          >
                            Create edited version
                          </button>
                        </Section>
                      )}
                    {selectedScene.visual === "video" && (
                      <Section title="Video settings">
                        <ClipControls
                          isVideo
                          clip={selectedScene.video}
                          onChange={(video) => patchScene({ video })}
                        />
                      </Section>
                    )}
                    <Section title="Scene timing">
                      <Field label="Set duration from">
                        <select
                          value={selectedScene.duration_mode}
                          onChange={(e) =>
                            patchScene({
                              duration_mode: e.target
                                .value as Scene["duration_mode"],
                            })
                          }
                        >
                          <option value="manual">Custom duration</option>
                          <option
                            value="voice"
                            disabled={!selectedScene.voice_id}
                          >
                            Narration length
                          </option>
                          <option
                            value="video"
                            disabled={!selectedScene.video_id}
                          >
                            Video length
                          </option>
                        </select>
                      </Field>
                      {selectedScene.duration_mode === "manual" ? (
                        <NumberField
                          label="Duration (seconds)"
                          value={selectedScene.duration}
                          min={0.1}
                          onChange={(v) => patchScene({ duration: v ?? 6 })}
                        />
                      ) : (
                        <p className="e-muted">
                          Scene duration:{" "}
                          {formatTime(
                            timeline.find(
                              (e) => e.scene.id === selectedScene.id,
                            )?.duration ?? 0,
                          )}
                        </p>
                      )}
                    </Section>
                    <Section title="Motion & transitions" open={false}>
                      <Field label="Camera movement">
                        <select
                          disabled={selectedScene.visual === "video"}
                          value={selectedScene.effect.type}
                          onChange={(e) =>
                            patchScene({
                              effect: {
                                ...selectedScene.effect,
                                type: e.target.value as Scene["effect"]["type"],
                              },
                            })
                          }
                        >
                          <option value="none">None</option>
                          <option value="zoom_in">Zoom in</option>
                          <option value="zoom_out">Zoom out</option>
                          <option value="pan_left">Pan left</option>
                          <option value="pan_right">Pan right</option>
                          <option value="pan_up">Pan up</option>
                          <option value="pan_down">Pan down</option>
                          <option value="ken_burns">Ken Burns</option>
                          <option value="drift">Drift</option>
                          <option value="pulse">Pulse</option>
                          <option value="rotate">Rotate</option>
                          <option value="tilt">Tilt</option>
                          <option value="bounce">Bounce</option>
                        </select>
                      </Field>
                      {selectedScene.visual === "video" && (
                        <small className="e-muted">
                          Camera effects are available for still images.
                        </small>
                      )}
                      {selectedScene.effect.type !== "none" && (
                        <Field label="Movement amount">
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step=".05"
                            value={selectedScene.effect.intensity}
                            onChange={(e) =>
                              patchScene({
                                effect: {
                                  ...selectedScene.effect,
                                  intensity: +e.target.value,
                                },
                              })
                            }
                          />
                        </Field>
                      )}
                      <Field label="Transition to next scene">
                        <select
                          value={selectedScene.transition.type}
                          onChange={(e) =>
                            patchScene({
                              transition: {
                                ...selectedScene.transition,
                                type: e.target
                                  .value as Scene["transition"]["type"],
                              },
                            })
                          }
                        >
                          <option value="none">Cut</option>
                          <option value="fade">Fade</option>
                          <option value="crossfade">Crossfade</option>
                          <option value="dissolve">Dissolve</option>
                          <option value="zoom">Zoom</option>
                          <option value="slide_left">Slide left</option>
                          <option value="slide_right">Slide right</option>
                          <option value="slide_up">Slide up</option>
                          <option value="slide_down">Slide down</option>
                          <option value="wipe_left">Wipe left</option>
                          <option value="wipe_right">Wipe right</option>
                          <option value="wipe_up">Wipe up</option>
                          <option value="wipe_down">Wipe down</option>
                        </select>
                      </Field>
                      {selectedScene.transition.type !== "none" && (
                        <NumberField
                          label="Transition length (s)"
                          value={selectedScene.transition.duration}
                          max={5}
                          onChange={(v) =>
                            patchScene({
                              transition: {
                                ...selectedScene.transition,
                                duration: v ?? 0.5,
                              },
                            })
                          }
                        />
                      )}
                      <small className="e-muted">
                        Transitions overlap neighboring scenes and shorten the
                        full video.
                      </small>
                    </Section>
                  </>
                )}
                {panel === "voice" && (
                  <>
                    <Section title="Narration">
                      <Field label="Scene script">
                        <textarea
                          rows={6}
                          value={selectedScene.script}
                          onChange={(e) =>
                            patchScene({ script: e.target.value })
                          }
                          placeholder="Tell this part of your story…"
                        />
                      </Field>
                      <Field label="Voice">
                        <select
                          value={voice}
                          onChange={(e) => setVoice(e.target.value)}
                        >
                          {capabilities.voices.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div className="e-two-actions">
                        <UploadButton kind="voice" />
                        <button
                          className="e-btn e-primary"
                          disabled={
                            !!busy ||
                            !capabilities.providers.voice ||
                            !selectedScene.script.trim()
                          }
                          onClick={() => generate("voice", { voice })}
                        >
                          <Icon name="spark" />
                          Generate
                        </button>
                      </div>
                      {!capabilities.providers.voice && (
                        <p className="e-muted">
                          Voice generation is not connected. Upload a recording
                          to continue.
                        </p>
                      )}
                      <Jobs
                        jobs={sceneJobs
                          .filter((j) => j.kind === "voice")
                          .slice(0, 2)}
                        onCancel={cancel}
                      />
                      {selectedScene.voice_id && (
                        <audio
                          className="e-audio"
                          controls
                          src={
                            assets.find((a) => a.id === selectedScene.voice_id)
                              ?.url
                          }
                        />
                      )}
                      <Section title="Narration versions">
                        {versions("voice")}
                      </Section>
                      {selectedScene.voice_id && (
                        <button
                          className="e-link"
                          onClick={() =>
                            patchScene({
                              voice_id: null,
                              duration_mode:
                                selectedScene.duration_mode === "voice"
                                  ? "manual"
                                  : selectedScene.duration_mode,
                            })
                          }
                        >
                          Remove narration from scene
                        </button>
                      )}
                    </Section>
                    <Section title="Narration settings">
                      <ClipControls
                        clip={selectedScene.voice}
                        onChange={(voiceSettings) =>
                          patchScene({ voice: voiceSettings })
                        }
                      />
                    </Section>
                  </>
                )}
                {panel === "captions" && (
                  <>
                    <Section title="Captions">
                      <Toggle
                        label="Show captions"
                        value={selectedScene.caption.enabled}
                        onChange={(enabled) =>
                          patchScene({
                            caption: { ...selectedScene.caption, enabled },
                          })
                        }
                      />
                      <Field
                        label="Caption text"
                        hint="Leave blank to use your scene script."
                      >
                        <textarea
                          rows={4}
                          value={selectedScene.caption.text}
                          onChange={(e) =>
                            patchScene({
                              caption: {
                                ...selectedScene.caption,
                                text: e.target.value,
                              },
                            })
                          }
                          placeholder={
                            selectedScene.script || "Add your caption text…"
                          }
                        />
                      </Field>
                      <div className="e-two">
                        <Field label="Style">
                          <select
                            value={selectedScene.caption.style}
                            onChange={(e) =>
                              patchScene({
                                caption: {
                                  ...selectedScene.caption,
                                  style: e.target
                                    .value as Scene["caption"]["style"],
                                },
                              })
                            }
                          >
                            <option value="plain">Plain</option>
                            <option value="bubble">Bubble</option>
                            <option value="highlight">Highlight</option>
                          </select>
                        </Field>
                        <Field label="Position">
                          <select
                            value={selectedScene.caption.position}
                            onChange={(e) =>
                              patchScene({
                                caption: {
                                  ...selectedScene.caption,
                                  position: e.target
                                    .value as Scene["caption"]["position"],
                                },
                              })
                            }
                          >
                            <option value="top">Top</option>
                            <option value="center">Center</option>
                            <option value="bottom">Bottom</option>
                          </select>
                        </Field>
                        <NumberField
                          label="Font size"
                          value={selectedScene.caption.size}
                          min={12}
                          max={160}
                          step={1}
                          onChange={(v) =>
                            patchScene({
                              caption: {
                                ...selectedScene.caption,
                                size: v ?? 48,
                              },
                            })
                          }
                        />
                        <Field label="Color">
                          <input
                            type="color"
                            value={selectedScene.caption.color.slice(0, 7)}
                            onChange={(e) =>
                              patchScene({
                                caption: {
                                  ...selectedScene.caption,
                                  color: e.target.value,
                                },
                              })
                            }
                          />
                        </Field>
                      </div>
                      <Field label="Font">
                        <select
                          value={selectedScene.caption.font}
                          onChange={(e) =>
                            patchScene({
                              caption: {
                                ...selectedScene.caption,
                                font: e.target.value,
                              },
                            })
                          }
                        >
                          <option>DejaVu Sans</option>
                          <option>DejaVu Serif</option>
                          <option>DejaVu Sans Mono</option>
                        </select>
                      </Field>
                      <Field label="Background color">
                        <input
                          value={selectedScene.caption.background}
                          onChange={(e) =>
                            patchScene({
                              caption: {
                                ...selectedScene.caption,
                                background: e.target.value,
                              },
                            })
                          }
                          placeholder="#00000099"
                        />
                      </Field>
                    </Section>
                    <Section title="Sync to narration">
                      <p className="e-muted">
                        Create word timings from your selected narration. Review
                        the result before applying it.
                      </p>
                      <button
                        className="e-btn e-primary"
                        disabled={
                          !!busy ||
                          !selectedScene.voice_id ||
                          !capabilities.providers.voice
                        }
                        onClick={() => generate("caption_align")}
                      >
                        <Icon name="captions" />
                        Sync captions to narration
                      </button>
                      {!selectedScene.voice_id && (
                        <small className="e-muted">
                          Choose a narration recording first.
                        </small>
                      )}
                      {!capabilities.providers.voice && (
                        <small className="e-muted">
                          Caption alignment is not connected. You can enter word
                          timings below.
                        </small>
                      )}
                      <Jobs
                        jobs={alignmentJobs
                          .filter((job) => job.status !== "succeeded")
                          .slice(0, 2)}
                        onCancel={cancel}
                      />
                      {alignmentJobs
                        .filter(
                          (job) =>
                            job.status === "succeeded" &&
                            job.result?.scene_id === selectedScene.id,
                        )
                        .slice(0, 3)
                        .map((job) => (
                          <div className="e-alignment-result" key={job.id}>
                            <strong>
                              {Array.isArray(job.result?.words)
                                ? job.result.words.length
                                : 0}{" "}
                              words ready to review
                            </strong>
                            <p>
                              Transcribed words may differ from your written
                              script. You can edit them after applying.
                            </p>
                            {alignmentMatches(job, selectedScene) ? (
                              <button
                                className="e-btn"
                                onClick={() => applyAlignment(job)}
                              >
                                Apply caption timing
                              </button>
                            ) : (
                              <small>
                                Narration or scene timing changed. Sync again
                                for an updated result.
                              </small>
                            )}
                          </div>
                        ))}
                    </Section>
                    <Section title="Word timing" open={false}>
                      <p className="e-muted">
                        Time words to your narration. Until you add timings, the
                        full caption stays on screen.
                      </p>
                      {selectedScene.caption.words.map((word, index) => (
                        <div className="e-word-row" key={index}>
                          <input
                            aria-label={`Word ${index + 1}`}
                            value={word.text}
                            onChange={(e) =>
                              patchScene({
                                caption: {
                                  ...selectedScene.caption,
                                  words: selectedScene.caption.words.map(
                                    (w, i) =>
                                      i === index
                                        ? { ...w, text: e.target.value }
                                        : w,
                                  ),
                                },
                              })
                            }
                          />
                          <input
                            aria-label={`Word ${index + 1} start`}
                            type="number"
                            min="0"
                            step=".1"
                            value={word.start}
                            onChange={(e) =>
                              patchScene({
                                caption: {
                                  ...selectedScene.caption,
                                  words: selectedScene.caption.words.map(
                                    (w, i) =>
                                      i === index
                                        ? {
                                            ...w,
                                            start: Math.max(0, +e.target.value),
                                          }
                                        : w,
                                  ),
                                },
                              })
                            }
                          />
                          <input
                            aria-label={`Word ${index + 1} end`}
                            type="number"
                            min="0"
                            step=".1"
                            value={word.end}
                            onChange={(e) =>
                              patchScene({
                                caption: {
                                  ...selectedScene.caption,
                                  words: selectedScene.caption.words.map(
                                    (w, i) =>
                                      i === index
                                        ? {
                                            ...w,
                                            end: Math.max(0, +e.target.value),
                                          }
                                        : w,
                                  ),
                                },
                              })
                            }
                          />
                          <input
                            aria-label={`Hide word ${index + 1}`}
                            title="Hide word"
                            type="checkbox"
                            checked={word.hidden}
                            onChange={(e) =>
                              patchScene({
                                caption: {
                                  ...selectedScene.caption,
                                  words: selectedScene.caption.words.map(
                                    (w, i) =>
                                      i === index
                                        ? { ...w, hidden: e.target.checked }
                                        : w,
                                  ),
                                },
                              })
                            }
                          />
                          <button
                            className="e-icon-button"
                            aria-label={`Delete word ${index + 1}`}
                            onClick={() =>
                              patchScene({
                                caption: {
                                  ...selectedScene.caption,
                                  words: selectedScene.caption.words.filter(
                                    (_, i) => i !== index,
                                  ),
                                },
                              })
                            }
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                      <button
                        className="e-btn"
                        onClick={() =>
                          patchScene({
                            caption: {
                              ...selectedScene.caption,
                              words: [
                                ...selectedScene.caption.words,
                                {
                                  text: "Word",
                                  start: 0,
                                  end: 1,
                                  hidden: false,
                                },
                              ],
                            },
                          })
                        }
                      >
                        <Icon name="plus" />
                        Add timed word
                      </button>
                    </Section>
                  </>
                )}
                {panel === "layers" && (
                  <>
                    <div className="e-two-actions">
                      <button
                        className="e-btn"
                        onClick={() => addLayer("text")}
                      >
                        <Icon name="plus" />
                        Text layer
                      </button>
                      <button
                        className="e-btn"
                        onClick={() => addLayer("image")}
                      >
                        <Icon name="image" />
                        Image layer
                      </button>
                    </div>
                    {!selectedScene.layers.length && (
                      <div className="e-empty-inspector">
                        <Icon name="layers" size={35} />
                        <h3>Add another layer</h3>
                        <p>Place text or an image anywhere in your scene.</p>
                      </div>
                    )}
                    {selectedScene.layers.map((layer, index) => (
                      <Section
                        key={layer.id}
                        title={`${layer.kind === "text" ? "Text" : "Image"} layer ${index + 1}`}
                      >
                        <div className="e-layer-actions">
                          <span>Layer {index + 1}</span>
                          <button
                            className="e-icon-button"
                            aria-label={`Delete layer ${index + 1}`}
                            onClick={() =>
                              patchScene({
                                layers: selectedScene.layers.filter(
                                  (l) => l.id !== layer.id,
                                ),
                              })
                            }
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                        {layer.kind === "text" ? (
                          <Field label="Text">
                            <textarea
                              rows={3}
                              value={layer.text}
                              onChange={(e) =>
                                patchLayer(layer.id, { text: e.target.value })
                              }
                            />
                          </Field>
                        ) : (
                          <Field label="Image">
                            <select
                              value={layer.asset_id ?? ""}
                              onChange={(e) =>
                                patchLayer(layer.id, {
                                  asset_id: e.target.value || null,
                                })
                              }
                            >
                              <option value="">Select an uploaded image</option>
                              {assets
                                .filter(
                                  (a) =>
                                    a.kind === "image" ||
                                    a.kind === "character",
                                )
                                .map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        )}
                        <div className="e-two">
                          {(["x", "y", "width", "height"] as const).map(
                            (key) => (
                              <NumberField
                                key={key}
                                label={`${key === "x" ? "Left" : key === "y" ? "Top" : key === "width" ? "Width" : "Height"} (%)`}
                                value={Math.round(layer[key] * 100)}
                                max={100}
                                step={1}
                                onChange={(v) =>
                                  patchLayer(layer.id, {
                                    [key]: (v ?? 0) / 100,
                                  })
                                }
                              />
                            ),
                          )}
                          <NumberField
                            label="Show from (s)"
                            value={layer.start}
                            onChange={(v) =>
                              patchLayer(layer.id, { start: v ?? 0 })
                            }
                          />
                          <NumberField
                            label="Show until (s)"
                            value={layer.end}
                            nullable
                            onChange={(v) => patchLayer(layer.id, { end: v })}
                          />
                          {layer.kind === "text" && (
                            <>
                              <NumberField
                                label="Font size"
                                value={layer.font_size}
                                min={12}
                                max={160}
                                step={1}
                                onChange={(v) =>
                                  patchLayer(layer.id, { font_size: v ?? 64 })
                                }
                              />
                              <Field label="Text color">
                                <input
                                  type="color"
                                  value={layer.color}
                                  onChange={(e) =>
                                    patchLayer(layer.id, {
                                      color: e.target.value,
                                    })
                                  }
                                />
                              </Field>
                            </>
                          )}
                        </div>
                        <Field label="Opacity">
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step=".01"
                            value={layer.opacity}
                            onChange={(e) =>
                              patchLayer(layer.id, { opacity: +e.target.value })
                            }
                          />
                        </Field>
                      </Section>
                    ))}
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="e-empty-inspector">
              <h3>Start your story</h3>
              <p>Add a scene to start creating.</p>
              <button className="e-btn e-primary" onClick={addScene}>
                <Icon name="plus" />
                Add scene
              </button>
            </div>
          )}
        </aside>
      </main>
      <section className="editor-timeline">
        <div className="editor-timeline-heading">
          <div>
            <strong>Your scenes</strong>
            <span>Drag to reorder</span>
          </div>
          <div>
            <span>{formatTime(total)} total</span>
            <button
              className="e-btn"
              disabled={project.scenes.length >= 50}
              onClick={addScene}
            >
              <Icon name="plus" size={15} />
              Add scene
            </button>
          </div>
        </div>
        <div className="editor-scene-strip">
          {timeline.map((entry) => {
            const scene = entry.scene;
            const image = assets.find((a) => a.id === scene.image_id);
            const video = assets.find((a) => a.id === scene.video_id);
            const active = playing
              ? time >= entry.start && time < entry.end
              : scene.id === selectedScene?.id;
            return (
              <div
                key={scene.id}
                draggable
                className={`editor-scene-card ${active ? "active" : ""} ${dragged === scene.id ? "dragging" : ""}`}
                onDragStart={() => setDragged(scene.id)}
                onDragEnd={() => setDragged(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragged) reorder(dragged, scene.id);
                  setDragged(null);
                }}
              >
                <button
                  className="editor-scene-select"
                  onClick={() => chooseScene(scene.id)}
                  aria-label={`Select scene ${entry.index + 1}: ${scene.title}`}
                >
                  <div className="editor-scene-thumbnail">
                    {scene.visual === "video" && video ? (
                      <video src={video.url} preload="metadata" />
                    ) : image ? (
                      <img src={image.url} alt="" />
                    ) : (
                      <div className="editor-scene-placeholder">
                        <Icon name="image" size={30} />
                      </div>
                    )}
                    <span className="editor-scene-number">
                      {entry.index + 1}
                    </span>
                    <span className="editor-scene-duration">
                      {entry.duration.toFixed(1)}s
                    </span>
                    {scene.voice_id && (
                      <span className="editor-scene-voice">
                        <Icon name="voice" size={12} />
                      </span>
                    )}
                  </div>
                  <strong>{scene.title}</strong>
                  <small>{scene.script || "Add your narration"}</small>
                </button>
                <div className="editor-reorder">
                  <button
                    aria-label={`Move scene ${entry.index + 1} left`}
                    disabled={!entry.index}
                    onClick={() =>
                      reorder(scene.id, timeline[entry.index - 1].scene.id)
                    }
                  >
                    ‹
                  </button>
                  <span>
                    {scene.transition.type === "none"
                      ? "Cut"
                      : scene.transition.type.replace("_", " ")}
                  </span>
                  <button
                    aria-label={`Move scene ${entry.index + 1} right`}
                    disabled={entry.index === timeline.length - 1}
                    onClick={() =>
                      reorder(scene.id, timeline[entry.index + 1].scene.id)
                    }
                  >
                    ›
                  </button>
                </div>
              </div>
            );
          })}
          <button
            className="editor-add-scene"
            disabled={project.scenes.length >= 50}
            onClick={addScene}
          >
            <Icon name="plus" size={24} />
            <span>Add scene</span>
          </button>
        </div>
      </section>
      {modal === "characters" && (
        <Modal
          error={error}
          title="Your characters"
          onClose={() => setModal(null)}
          wide
        >
          <p className="e-modal-intro">
            Keep familiar faces throughout your story. Add a reference image and
            choose characters for each scene.
          </p>
          <div className="e-library-toolbar">
            <button
              className="e-btn"
              disabled={!!busy}
              onClick={openCharacterLibrary}
            >
              <Icon name="people" />
              Add from library
            </button>
            <span>Reuse a character from another project</span>
          </div>
          {characterLibrary && (
            <div className="e-library-browser">
              <div className="e-library-heading">
                <strong>Your character library</strong>
                <button
                  className="e-icon-button"
                  aria-label="Close character library"
                  onClick={() => setCharacterLibrary(null)}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
              {characterLibrary.filter(
                (c) => c.source_project_id !== project.id,
              ).length === 0 ? (
                <p className="e-muted">
                  Characters you save in other projects will appear here.
                </p>
              ) : (
                <div className="e-character-library-grid">
                  {characterLibrary
                    .filter((c) => c.source_project_id !== project.id)
                    .map((item) => (
                      <article className="e-library-character" key={item.id}>
                        {item.asset ? (
                          <img src={item.asset.url} alt={item.name} />
                        ) : (
                          <div className="e-library-no-picture">
                            <Icon name="people" />
                          </div>
                        )}
                        <div>
                          <strong>{item.name}</strong>
                          <small>{item.project_name}</small>
                          <p>{item.description}</p>
                          <button
                            className="e-btn"
                            disabled={!!busy}
                            onClick={() => importCharacter(item)}
                          >
                            Add to project
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
              )}
            </div>
          )}
          <div className="e-character-grid">
            {project.characters.map((character) => {
              const image = assets.find((a) => a.id === character.asset_id);
              const candidates = assets.filter(
                (a) =>
                  a.kind === "character" && a.character_id === character.id,
              );
              return (
                <div className="e-character-card" key={character.id}>
                  <div className="e-character-photo">
                    {image ? (
                      <img src={image.url} alt={character.name} />
                    ) : (
                      <Icon name="people" size={44} />
                    )}
                  </div>
                  <Field label="Name">
                    <input
                      value={character.name}
                      onChange={(e) =>
                        change((p) => ({
                          ...p,
                          characters: p.characters.map((c) =>
                            c.id === character.id
                              ? { ...c, name: e.target.value }
                              : c,
                          ),
                        }))
                      }
                    />
                  </Field>
                  <Field label="Appearance & personality">
                    <textarea
                      rows={3}
                      value={character.description}
                      onChange={(e) =>
                        change((p) => ({
                          ...p,
                          characters: p.characters.map((c) =>
                            c.id === character.id
                              ? { ...c, description: e.target.value }
                              : c,
                          ),
                        }))
                      }
                    />
                  </Field>
                  <div className="e-two-actions">
                    <UploadButton
                      kind="character"
                      character_id={character.id}
                    />
                    <button
                      className="e-btn e-primary"
                      disabled={
                        !!busy ||
                        !capabilities.providers.image ||
                        !character.description.trim()
                      }
                      onClick={() =>
                        generate(
                          "character",
                          {},
                          character.description,
                          character.id,
                        )
                      }
                    >
                      <Icon name="spark" />
                      Generate
                    </button>
                  </div>
                  {candidates.length > 0 && (
                    <Field label="Reference version">
                      <select
                        value={character.asset_id ?? ""}
                        onChange={(e) =>
                          change((p) => ({
                            ...p,
                            characters: p.characters.map((c) =>
                              c.id === character.id
                                ? { ...c, asset_id: e.target.value || null }
                                : c,
                            ),
                          }))
                        }
                      >
                        <option value="">Choose a version</option>
                        {candidates.map((a) => (
                          <option value={a.id} key={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <button
                    className="e-link"
                    onClick={() =>
                      change((p) => ({
                        ...p,
                        characters: p.characters.filter(
                          (c) => c.id !== character.id,
                        ),
                        scenes: p.scenes.map((s) => ({
                          ...s,
                          character_ids: s.character_ids.filter(
                            (id) => id !== character.id,
                          ),
                        })),
                      }))
                    }
                  >
                    Remove character
                  </button>
                </div>
              );
            })}
            <button
              className="e-add-character"
              onClick={() =>
                change((p) => ({
                  ...p,
                  characters: [
                    ...p.characters,
                    {
                      id: crypto.randomUUID(),
                      name: `Character ${p.characters.length + 1}`,
                      description: "",
                      asset_id: null,
                    },
                  ],
                }))
              }
            >
              <Icon name="plus" size={30} />
              <strong>Add a character</strong>
            </button>
          </div>
          <Jobs
            jobs={jobs.filter((j) => j.kind === "character").slice(0, 3)}
            onCancel={cancel}
          />
        </Modal>
      )}
      {modal === "music" && (
        <Modal
          error={error}
          title="Set the mood"
          onClose={() => setModal(null)}
        >
          <p className="e-modal-intro">
            Add a soundtrack that makes your story feel complete.
          </p>
          <div className="e-two-actions">
            <UploadButton kind="music" label="Upload music" />
            <button
              className="e-btn"
              disabled={!!busy}
              onClick={openMusicLibrary}
            >
              <Icon name="music" />
              Music library
            </button>
          </div>
          {musicLibrary && (
            <div className="e-library-browser">
              <div className="e-library-heading">
                <strong>Your music library</strong>
                <button
                  className="e-icon-button"
                  aria-label="Close music library"
                  onClick={() => setMusicLibrary(null)}
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
              {musicLibrary.length === 0 ? (
                <p className="e-muted">
                  Tracks you upload or generate will be available across your
                  projects.
                </p>
              ) : (
                musicLibrary.map((item) => (
                  <article className="e-library-track" key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>
                        {item.duration
                          ? formatTime(item.duration)
                          : "Audio track"}
                      </small>
                      <button
                        className="e-btn"
                        disabled={!!busy}
                        onClick={() => importMusic(item)}
                      >
                        Use track
                      </button>
                    </div>
                    <audio controls preload="none" src={item.url} />
                  </article>
                ))
              )}
            </div>
          )}
          <Section title="Your music">
            <Field label="Soundtrack">
              <select
                value={project.music.asset_id ?? ""}
                onChange={(e) =>
                  change((p) => ({
                    ...p,
                    music: { ...p.music, asset_id: e.target.value || null },
                  }))
                }
              >
                <option value="">No background music</option>
                {assets
                  .filter((a) => a.kind === "music")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            {project.music.asset_id && (
              <audio
                className="e-audio"
                controls
                src={assets.find((a) => a.id === project.music.asset_id)?.url}
              />
            )}
          </Section>
          <Section title="Generate music" open={false}>
            <Field label="Describe your soundtrack">
              <textarea
                rows={3}
                id="editor-music-prompt"
                placeholder="Gentle cinematic piano, warm strings, a feeling of adventure…"
              />
            </Field>
            <button
              className="e-btn e-primary"
              disabled={!!busy || !capabilities.providers.music}
              onClick={() => {
                const prompt = (
                  document.getElementById(
                    "editor-music-prompt",
                  ) as HTMLTextAreaElement
                )?.value;
                if (!prompt?.trim()) {
                  setError("Describe the soundtrack you want to create.");
                  return;
                }
                generate(
                  "music",
                  {
                    duration: Math.max(3, Math.min(120, total)),
                    instrumental: true,
                  },
                  prompt,
                );
              }}
            >
              <Icon name="spark" />
              Generate soundtrack
            </button>
            {!capabilities.providers.music && (
              <p className="e-muted">
                Music generation is not connected. Upload a soundtrack to
                continue.
              </p>
            )}
            <Jobs
              jobs={jobs.filter((j) => j.kind === "music").slice(0, 3)}
              onCancel={cancel}
            />
          </Section>
          <Section title="Music settings">
            <Field
              label={`Volume · ${Math.round(project.music.volume * 100)}%`}
            >
              <input
                type="range"
                min="0"
                max="1"
                step=".01"
                value={project.music.volume}
                onChange={(e) =>
                  change((p) => ({
                    ...p,
                    music: { ...p.music, volume: +e.target.value },
                  }))
                }
              />
            </Field>
            <div className="e-two">
              <NumberField
                label="Trim start (s)"
                value={project.music.trim_start}
                max={1200}
                onChange={(v) =>
                  change((p) => ({
                    ...p,
                    music: { ...p.music, trim_start: v ?? 0 },
                  }))
                }
              />
              <NumberField
                label="Trim end (s)"
                value={project.music.trim_end}
                max={1200}
                nullable
                onChange={(v) =>
                  change((p) => ({ ...p, music: { ...p.music, trim_end: v } }))
                }
              />
              <NumberField
                label="Fade in (s)"
                value={project.music.fade_in}
                max={30}
                onChange={(v) =>
                  change((p) => ({
                    ...p,
                    music: { ...p.music, fade_in: v ?? 0 },
                  }))
                }
              />
              <NumberField
                label="Fade out (s)"
                value={project.music.fade_out}
                max={30}
                onChange={(v) =>
                  change((p) => ({
                    ...p,
                    music: { ...p.music, fade_out: v ?? 0 },
                  }))
                }
              />
            </div>
            <Toggle
              label="Loop to fill video"
              value={project.music.loop}
              onChange={(loop) =>
                change((p) => ({ ...p, music: { ...p.music, loop } }))
              }
            />
            <Toggle
              label="Lower music during narration"
              value={project.music.ducking}
              onChange={(ducking) =>
                change((p) => ({ ...p, music: { ...p.music, ducking } }))
              }
            />
          </Section>
        </Modal>
      )}
      {modal === "export" && (
        <Modal
          error={error}
          title="Your story, ready to share"
          onClose={() => setModal(null)}
        >
          <p className="e-modal-intro">
            Export your current scenes, narration, captions and music as a
            private MP4.
          </p>
          <div className="e-export-summary">
            <span className="editor-brand-mark">
              <Icon name="video" size={26} />
            </span>
            <div>
              <strong>{project.name}</strong>
              <span>
                {project.scenes.length} scenes · {formatTime(total)} ·{" "}
                {project.ratio}
              </span>
            </div>
          </div>
          <div className="e-two">
            <Field label="Resolution">
              <select
                value={resolution}
                onChange={(e) => setResolution(+e.target.value)}
              >
                <option value="720">720p · HD</option>
                <option value="1080">1080p · Full HD</option>
                <option value="1440">1440p · 2K</option>
              </select>
            </Field>
            <Field label="Quality">
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
              >
                <option value="standard">Standard</option>
                <option value="high">High</option>
              </select>
            </Field>
          </div>
          <p className="e-muted">
            Uses your selected media. No new images, narration or video are
            generated.
          </p>
          {project.scenes.some((s) =>
            s.visual === "image" ? !s.image_id : !s.video_id,
          ) && (
            <p className="e-notice">
              Scenes without a visual use a black background. Captions and
              layers will still appear.
            </p>
          )}
          {total > 1200 && (
            <p className="e-notice">
              This video exceeds the 20 minute limit. Shorten it before
              exporting.
            </p>
          )}
          <button
            className="e-btn e-primary e-full"
            disabled={
              !!busy ||
              !project.scenes.length ||
              total > 1200 ||
              projectJobs.some(
                (j) => j.status === "queued" || j.status === "running",
              )
            }
            onClick={() => generate("export", { resolution, quality, fps: 30 })}
          >
            <Icon name="download" />
            Export video
          </button>
          <Jobs jobs={projectJobs.slice(0, 3)} onCancel={cancel} />
          <Section title="Export history">
            {exports.length === 0 ? (
              <p className="e-muted">
                Your finished videos will be ready to download here.
              </p>
            ) : (
              exports.map((item) => (
                <div className="e-export-row" key={item.id}>
                  <Icon name="video" />
                  <div>
                    <strong>{item.resolution}p MP4</strong>
                    <small>
                      {new Date(item.created_at).toLocaleString()} ·{" "}
                      {(item.byte_size / 1048576).toFixed(1)} MB
                    </small>
                    <small>
                      {item.revision === project.revision
                        ? "Current saved version"
                        : `Saved version ${item.revision}`}
                    </small>
                  </div>
                  <a
                    className="e-icon-button"
                    aria-label={`Download ${item.resolution}p export`}
                    href={item.url}
                    download
                  >
                    <Icon name="download" />
                  </a>
                  <button
                    className="e-icon-button"
                    aria-label="Delete this exported video"
                    onClick={() => {
                      if (
                        window.confirm(
                          "Delete this exported video? Your project and source media will be kept.",
                        )
                      )
                        void run("delete-export", async () => {
                          await api.deleteExport(item.id);
                          await refresh();
                        });
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              ))
            )}
          </Section>
        </Modal>
      )}
    </div>
  );
}
