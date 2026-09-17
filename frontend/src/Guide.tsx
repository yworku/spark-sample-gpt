import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { LibraryCharacter } from "./api";
import { newScene } from "./types";
import type {
  Asset,
  AssetKind,
  Capabilities,
  Character,
  Job,
  Project,
  ProjectDocument,
  Scene,
} from "./types";
interface Props {
  project: Project;
  capabilities: Capabilities;
  initialStage?: number;
  initialPrompt?: string;
  onBack: () => void;
  onProject: (p: Project) => void;
  onEditor: (p: Project) => void;
}
const stages = [
  { name: "Story", icon: "✧", caption: "It starts with an idea" },
  { name: "Review", icon: "≡", caption: "Make every word yours" },
  { name: "Characters", icon: "♙", caption: "Meet your cast" },
  { name: "Images", icon: "▧", caption: "Picture the possibilities" },
  { name: "Voice & music", icon: "♫", caption: "Find your story’s sound" },
  { name: "Video", icon: "▷", caption: "Bring it all together" },
];
const activeJob = (j: Job) => j.status === "queued" || j.status === "running";
type BatchKind = "character" | "image" | "voice" | "video";
interface BatchTarget {
  sceneId?: string;
  characterId?: string;
  prompt?: string;
}
function missingTargets(
  document: Project,
  kind: BatchKind,
  assets: Asset[],
  jobs: Job[],
): BatchTarget[] {
  const existing = (id: string, character = false) =>
    assets.some(
      (a) =>
        a.kind === kind &&
        (character ? a.character_id === id : a.scene_id === id),
    ) ||
    jobs.some(
      (j) =>
        (j.kind === kind || (kind === "image" && j.kind === "image_edit")) &&
        (character ? j.character_id === id : j.scene_id === id) &&
        ["queued", "running", "succeeded", "unknown"].includes(j.status),
    );
  if (kind === "character")
    return document.characters
      .filter(
        (c) => !c.asset_id && c.description.trim() && !existing(c.id, true),
      )
      .map((c) => ({ characterId: c.id, prompt: c.description }));
  return document.scenes
    .filter((scene) =>
      kind === "image"
        ? !scene.image_id && !!scene.image_prompt.trim() && !existing(scene.id)
        : kind === "voice"
          ? !scene.voice_id && !!scene.script.trim() && !existing(scene.id)
          : !scene.video_id &&
            !!scene.video_prompt.trim() &&
            !!scene.image_id &&
            assets.some((a) => a.id === scene.image_id && a.kind === "image") &&
            !existing(scene.id),
    )
    .map((scene) => ({
      sceneId: scene.id,
      ...(kind === "image"
        ? { prompt: scene.image_prompt }
        : kind === "video"
          ? { prompt: scene.video_prompt }
          : {}),
    }));
}

function asDocument(p: Project): ProjectDocument {
  const { name, kind, ratio, style, language, scenes, characters, music } = p;
  return { name, kind, ratio, style, language, scenes, characters, music };
}
export default function Guide({
  project,
  capabilities,
  initialStage = 0,
  initialPrompt = "",
  onBack,
  onProject,
  onEditor,
}: Props) {
  const [draft, setDraft] = useState(project),
    draftRef = useRef(project),
    revision = useRef(project.revision),
    dirtyRef = useRef(false),
    [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [stage, setStage] = useState(initialStage),
    [prompt, setPrompt] = useState(initialPrompt),
    [sceneCount, setSceneCount] = useState(
      Math.min(8, project.scenes.length || 4),
    ),
    [selected, setSelected] = useState(project.scenes[0]?.id ?? ""),
    [assets, setAssets] = useState<Asset[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [voice, setVoice] = useState(capabilities.voices[0]?.id ?? ""),
    [musicPrompt, setMusicPrompt] = useState(""),
    [showActivity, setShowActivity] = useState(false),
    [applied, setApplied] = useState<string[]>([]),
    [storyReplace, setStoryReplace] = useState<Job | null>(null);
  const [productionLoaded, setProductionLoaded] = useState(false);
  const [library, setLibrary] = useState<LibraryCharacter[] | null>(null),
    [libraryLoading, setLibraryLoading] = useState(false);
  async function loadLibrary() {
    setLibraryLoading(true);
    setError("");
    try {
      setLibrary(
        (await api.libraryCharacters()).filter(
          (c) => c.source_project_id !== project.id,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLibraryLoading(false);
    }
  }
  async function importCharacter(c: LibraryCharacter) {
    setWorking(true);
    setError("");
    try {
      const saved = await save();
      const next = await api.importCharacter(project.id, {
        source_project_id: c.source_project_id,
        source_character_id: c.source_character_id,
        base_revision: saved.revision,
      });
      revision.current = next.revision;
      const changed = draftRef.current !== saved;
      const merged = changed
        ? {
            ...draftRef.current,
            revision: next.revision,
            characters: [
              ...draftRef.current.characters,
              ...next.characters.filter(
                (c) => !saved.characters.some((x) => x.id === c.id),
              ),
            ],
          }
        : next;
      draftRef.current = merged;
      setDraft(merged);
      dirtyRef.current = changed;
      setDirty(changed);
      onProject(next);
      setAssets(await api.assets(project.id));
      setLibrary(null);
      setNotice("Character added from your library.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const scene = draft.scenes.find((s) => s.id === selected) ?? draft.scenes[0];
  const assetMap = new Map(assets.map((a) => [a.id, a]));
  function update(fn: (p: Project) => Project) {
    const p = fn(draftRef.current);
    draftRef.current = p;
    setDraft(p);
    dirtyRef.current = true;
    setDirty(true);
    setNotice("");
  }
  function updateScene(patch: Partial<Scene>) {
    if (scene)
      update((p) => ({
        ...p,
        scenes: p.scenes.map((s) =>
          s.id === scene.id ? { ...s, ...patch } : s,
        ),
      }));
  }
  function updateCharacter(id: string, patch: Partial<Character>) {
    update((p) => ({
      ...p,
      characters: p.characters.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    }));
  }
  async function refresh() {
    const j = await api.jobs(project.id);
    const a = await api.assets(project.id);
    setAssets(a);
    setJobs(j);
    setProductionLoaded(true);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [project.id]);
  const hasActive = jobs.some(activeJob);
  useEffect(() => {
    if (!hasActive) return;
    let cancelled = false;
    let fetching = false;
    const interval = window.setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try {
        const j = await api.jobs(project.id);
        const a = await api.assets(project.id);
        if (!cancelled) {
          setAssets(a);
          setJobs(j);
          setProductionLoaded(true);
        }
      } catch (e) {
        if (!cancelled)
          setError(
            "Could not refresh production status. Your edits are still here. " +
              (e as Error).message,
          );
      } finally {
        fetching = false;
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hasActive, project.id]);
  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    function navigate(e: Event) {
      if (
        dirtyRef.current &&
        !window.confirm("Leave this project and discard unsaved changes?")
      )
        e.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    window.addEventListener("spark-before-navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("spark-before-navigate", navigate);
    };
  }, []);
  async function save(): Promise<Project> {
    if (!dirtyRef.current)
      return { ...draftRef.current, revision: revision.current };
    const submitted = draftRef.current;
    setSaving(true);
    try {
      const saved = await api.saveProject(
        project.id,
        revision.current,
        asDocument(submitted),
      );
      revision.current = saved.revision;
      onProject(saved);
      if (draftRef.current === submitted) {
        draftRef.current = saved;
        setDraft(saved);
        dirtyRef.current = false;
        setDirty(false);
      }
      setNotice("Changes saved");
      return saved;
    } finally {
      setSaving(false);
    }
  }
  async function saveClick() {
    setError("");
    try {
      await save();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function runJob(
    kind: string,
    sceneId?: string,
    characterId?: string,
    customPrompt?: string,
  ) {
    setError("");
    setWorking(true);
    try {
      const saved = await save();
      const job = await api.job(project.id, {
        kind,
        base_revision: saved.revision,
        scene_id: sceneId,
        character_id: characterId,
        prompt: customPrompt,
        settings:
          kind === "story"
            ? { scene_count: sceneCount }
            : kind === "voice"
              ? { voice: voice }
              : {},
      });
      setJobs((list) => [job, ...list.filter((j) => j.id !== job.id)]);
      setShowActivity(true);
      setNotice("Production request queued. You can keep working.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function runBatch(kind: BatchKind, announced: BatchTarget[]) {
    if (!announced.length || working || saving) return;
    setWorking(true);
    setError("");
    setNotice("");
    let confirmed = 0;
    const total = announced.length;
    const frozenVoice = voice;
    try {
      const freshJobs = await api.jobs(project.id);
      const freshAssets = await api.assets(project.id);
      setJobs(freshJobs);
      setAssets(freshAssets);
      setProductionLoaded(true);
      const saved = await save();
      const eligible = missingTargets(saved, kind, freshAssets, freshJobs);
      const capacity = Math.min(
        8,
        Math.max(
          0,
          Math.floor(capabilities.limits.max_pending_jobs ?? 8) -
            freshJobs.filter(activeJob).length,
        ),
      );
      const targets = announced
        .map((target) =>
          eligible.find(
            (item) =>
              item.sceneId === target.sceneId &&
              item.characterId === target.characterId,
          ),
        )
        .filter((target): target is BatchTarget => !!target)
        .slice(0, capacity);
      if (!targets.length) {
        setNotice(
          "No requests started. Existing results or active production already cover these targets.",
        );
        return;
      }
      for (const target of targets) {
        const job = await api.job(project.id, {
          kind,
          base_revision: saved.revision,
          scene_id: target.sceneId,
          character_id: target.characterId,
          prompt: target.prompt,
          settings:
            kind === "voice"
              ? { voice: frozenVoice }
              : kind === "video"
                ? { duration: 5 }
                : {},
        });
        confirmed++;
        setJobs((list) => [job, ...list.filter((j) => j.id !== job.id)]);
        setNotice(`${confirmed} of ${total} requests confirmed queued.`);
      }
      setShowActivity(true);
      setNotice(
        `${confirmed} of ${total} requests confirmed queued.${confirmed < total ? " The other targets already have results or no longer have queue capacity." : ""} Choose each result when it is ready.`,
      );
    } catch (e) {
      setShowActivity(true);
      setError(
        `${confirmed} of ${total} requests confirmed queued. Submission stopped: ${(e as Error).message} Check Activity before trying again; an unconfirmed request may still be running.`,
      );
    } finally {
      try {
        await refresh();
      } catch (e) {
        setError(
          (current) =>
            (current ? current + " " : "") +
            "Production status could not be refreshed: " +
            (e as Error).message,
        );
      }
      setWorking(false);
    }
  }
  async function upload(
    file: File,
    kind: AssetKind,
    sceneId?: string,
    characterId?: string,
  ) {
    setWorking(true);
    setError("");
    try {
      await save();
      const asset = await api.upload(
        project.id,
        file,
        kind,
        sceneId,
        characterId,
      );
      setAssets((list) => [asset, ...list]);
      setNotice("Upload ready. Choose it below to use it in your story.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function openEditor() {
    setWorking(true);
    setError("");
    try {
      const saved = await save();
      if (dirtyRef.current) {
        setError(
          "You made more edits while saving. Save these changes before opening the editor.",
        );
        return;
      }
      onEditor(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  function addScene() {
    const s = newScene("Scene " + (draft.scenes.length + 1));
    update((p) => ({ ...p, scenes: [...p.scenes, s] }));
    setSelected(s.id);
  }
  function applyStory(job: Job) {
    const result = job.result as {
      scenes?: Partial<Scene>[];
      characters?: Partial<Character>[];
    } | null;
    if (!Array.isArray(result?.scenes) || !result.scenes.length) {
      setError(
        "This story result contains no scenes. Your project has not changed.",
      );
      return;
    }
    const characters = (result.characters ?? []).map((c) => ({
      id: c.id ?? crypto.randomUUID(),
      name: c.name ?? "Character",
      description: c.description ?? "",
      asset_id: null,
    }));
    const scenes = result.scenes.map((s, i) => ({
      ...newScene(s.title ?? "Scene " + (i + 1), s.script ?? ""),
      ...(s.id ? { id: s.id } : {}),
      image_prompt: s.image_prompt ?? "",
      video_prompt: s.video_prompt ?? "",
      character_ids: (s.character_ids ?? []).filter((id) =>
        characters.some((c) => c.id === id),
      ),
      duration: Math.max(0.1, Math.min(120, Number(s.duration) || 6)),
    }));
    update((p) => ({ ...p, scenes, characters }));
    setSelected(scenes[0].id);
    setApplied((list) => [...list, job.id]);
    setStage(1);
    setStoryReplace(null);
    setNotice("Story applied to your draft. Review and save your changes.");
  }
  const batchKind: BatchKind =
    stage === 2
      ? "character"
      : stage === 3
        ? "image"
        : stage === 4
          ? "voice"
          : "video";
  const allMissing = missingTargets(draft, batchKind, assets, jobs);
  const batchCapacity = Math.min(
    8,
    Math.max(
      0,
      Math.floor(capabilities.limits.max_pending_jobs ?? 8) -
        jobs.filter(activeJob).length,
    ),
  );
  const batchTargets = allMissing.slice(0, batchCapacity);
  const batchLabel =
    batchKind === "character"
      ? "references"
      : batchKind === "voice"
        ? "narrations"
        : batchKind === "image"
          ? "images"
          : "videos";
  const batchEnabled =
    capabilities.providers[batchKind === "character" ? "image" : batchKind] &&
    (batchKind !== "voice" || !!voice);
  const batchControl = (
    <div className="manual-story-option">
      <div>
        <strong style={{ fontSize: 12, color: "#96774f" }}>
          Prepare missing {batchLabel}
        </strong>
        <p className="field-help" style={{ margin: "5px 0 0" }}>
          {" "}
          {batchTargets.length} separate requests
          {batchKind === "voice" && voice
            ? ` using ${capabilities.voices.find((v) => v.id === voice)?.name ?? voice}`
            : ""}
          . Results are kept for review.
          {allMissing.length > batchTargets.length
            ? ` ${allMissing.length - batchTargets.length} more eligible targets remain for a later batch.`
            : allMissing.length === 0
              ? " Existing media, completed alternatives and active requests are skipped."
              : ""}
          {batchKind === "video"
            ? " Video requests use a selected scene image and motion direction."
            : ""}
        </p>
      </div>
      <button
        className="button primary"
        disabled={
          !productionLoaded ||
          saving ||
          working ||
          !batchEnabled ||
          !batchTargets.length
        }
        onClick={() => void runBatch(batchKind, batchTargets)}
      >
        ✦ Generate {batchTargets.length} missing{" "}
        {batchTargets.length === 1 ? batchLabel.slice(0, -1) : batchLabel}
      </button>
    </div>
  );
  const visualReady = draft.scenes.filter(
      (s) => s.image_id || s.video_id,
    ).length,
    voiceReady = draft.scenes.filter((s) => s.voice_id).length,
    busy = saving || working;
  return (
    <div className="production-page">
      <header className="production-header">
        <div className="production-brand">
          <button
            className="icon-button back-button"
            onClick={() => {
              if (
                !dirtyRef.current ||
                window.confirm(
                  "Leave this project and discard unsaved changes?",
                )
              )
                onBack();
            }}
            aria-label="Back to projects"
          >
            ←
          </button>
          <span className="brand-mark">✦</span>
          <div>
            <input
              aria-label="Project name"
              value={draft.name}
              maxLength={120}
              onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
            />
            <span className="save-status">
              {saving
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : notice === "Changes saved"
                    ? "All changes saved"
                    : "Private video project"}
            </span>
          </div>
        </div>
        <div className="production-header-actions">
          <button
            className={"button subtle " + (showActivity ? "selected" : "")}
            onClick={() => setShowActivity(!showActivity)}
          >
            {hasActive ? <span className="spinner" /> : "◷"}
            <span>Activity</span>
            {jobs.length > 0 && <b>{jobs.length}</b>}
          </button>
          <button
            className="button secondary"
            onClick={() => void saveClick()}
            disabled={!dirty || busy}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            className="button primary"
            onClick={() => void openEditor()}
            disabled={busy || !draft.scenes.length}
          >
            Open editor <span>↗</span>
          </button>
        </div>
      </header>
      <nav className="stage-navigation" aria-label="Production stages">
        {stages.map((s, i) => (
          <button
            key={s.name}
            onClick={() => setStage(i)}
            className={
              "stage-button tone-" + i + " " + (stage === i ? "active" : "")
            }
            aria-current={stage === i ? "step" : undefined}
          >
            <span className="stage-icon">{s.icon}</span>
            <span>
              <small>STEP {i + 1}</small>
              <strong>{s.name}</strong>
            </span>
            <b>→</b>
          </button>
        ))}
      </nav>
      <main className="guide-main">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="notice-banner" role="status">
            <span>✓</span>
            {notice}
          </div>
        )}
        <div className="guide-heading">
          <div>
            <span className="eyebrow">STEP {stage + 1} OF 6</span>
            <h1>
              {stage === 0
                ? "Every great story starts somewhere."
                : stage === 1
                  ? "Let’s shape your story."
                  : stage === 2
                    ? "Meet the stars of your story."
                    : stage === 3
                      ? "A picture for every moment."
                      : stage === 4
                        ? "Give your story a voice."
                        : "It’s all coming together."}
            </h1>
            <p>
              {stages[stage].caption}.{" "}
              {stage === 0
                ? "What will yours be about?"
                : stage === 1
                  ? "Review your scenes and make them your own."
                  : stage === 2
                    ? "Add the details that make your characters memorable."
                    : stage === 3
                      ? "Create or upload visuals, then choose your favorites."
                      : stage === 4
                        ? "Choose narration takes and set the mood with music."
                        : "Add motion or head to the editor to finish your video."}
            </p>
          </div>
          <span className="guide-format">
            {draft.ratio} <span>·</span> {draft.language}
          </span>
        </div>
        <div className="guide-columns">
          <section className="guide-workspace">
            {stage === 0 && (
              <>
                <div className="panel story-panel">
                  <div className="panel-title">
                    <span className="section-icon peach">✧</span>
                    <h2>Tell us your idea</h2>
                  </div>
                  <label>
                    Your story idea
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={8}
                      maxLength={30000}
                      placeholder="A brave little astronaut sets off to find the last star in the universe…\n\nAdd your characters, audience, mood, or any details you have in mind."
                    />
                  </label>
                  <div className="story-controls">
                    <label>
                      Number of scenes
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={sceneCount}
                        onChange={(e) =>
                          setSceneCount(
                            Math.max(
                              1,
                              Math.min(50, Number(e.target.value) || 1),
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      Visual style
                      <select
                        value={draft.style}
                        onChange={(e) =>
                          update((p) => ({ ...p, style: e.target.value }))
                        }
                      >
                        {capabilities.styles.map((s) => (
                          <option value={s.id} key={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Language
                      <input
                        value={draft.language}
                        onChange={(e) =>
                          update((p) => ({ ...p, language: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="panel-actions">
                    <span className="field-help">
                      One story request. Review the result before applying it.
                    </span>
                    <button
                      className="button primary"
                      disabled={
                        busy || !prompt.trim() || !capabilities.providers.story
                      }
                      onClick={() =>
                        void runJob("story", undefined, undefined, prompt)
                      }
                    >
                      ✦ Generate story
                    </button>
                  </div>
                  {!capabilities.providers.story && (
                    <ProviderNote kind="Story" />
                  )}
                </div>
                <div className="manual-story-option">
                  <span>Already have the words?</span>
                  <button
                    className="text-button"
                    onClick={() => {
                      if (!draft.scenes.length) addScene();
                      setStage(1);
                    }}
                  >
                    Write your own story <span>→</span>
                  </button>
                </div>
                {jobs
                  .filter((j) => j.kind === "story")
                  .slice(0, 3)
                  .map((j) => (
                    <StoryCandidate
                      job={j}
                      key={j.id}
                      applied={applied.includes(j.id)}
                      onApply={() =>
                        draft.scenes.length ? setStoryReplace(j) : applyStory(j)
                      }
                    />
                  ))}
              </>
            )}
            {stage === 1 && (
              <>
                <div className="scene-review-header">
                  <h2>
                    Your story <span>{draft.scenes.length} scenes</span>
                  </h2>
                  <button
                    className="button secondary"
                    onClick={addScene}
                    disabled={draft.scenes.length >= 50}
                  >
                    ＋ Add scene
                  </button>
                </div>
                {!draft.scenes.length && (
                  <EmptyState
                    icon="≡"
                    title="Your story starts here"
                    text="Add a scene to write it yourself, or generate a story from your idea."
                    action="Add first scene"
                    onAction={addScene}
                  />
                )}
                <div className="review-scene-list">
                  {draft.scenes.map((s, i) => (
                    <article className="review-scene-card" key={s.id}>
                      <div className="review-scene-number">
                        {String(i + 1).padStart(2, "0")}
                      </div>
                      <div className="review-scene-fields">
                        <div className="review-scene-title">
                          <input
                            value={s.title}
                            aria-label={"Scene " + (i + 1) + " title"}
                            placeholder="Scene title"
                            maxLength={200}
                            onChange={(e) =>
                              update((p) => ({
                                ...p,
                                scenes: p.scenes.map((x) =>
                                  x.id === s.id
                                    ? { ...x, title: e.target.value }
                                    : x,
                                ),
                              }))
                            }
                          />
                          <button
                            className="icon-button"
                            aria-label={"Delete " + s.title}
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Remove this scene? Its uploaded and generated media will be retained.",
                                )
                              )
                                update((p) => ({
                                  ...p,
                                  scenes: p.scenes.filter((x) => x.id !== s.id),
                                }));
                            }}
                          >
                            ×
                          </button>
                        </div>
                        <label>
                          Narration
                          <textarea
                            value={s.script}
                            rows={3}
                            placeholder="What happens in this moment?"
                            onChange={(e) =>
                              update((p) => ({
                                ...p,
                                scenes: p.scenes.map((x) =>
                                  x.id === s.id
                                    ? { ...x, script: e.target.value }
                                    : x,
                                ),
                              }))
                            }
                          />
                        </label>
                        <label>
                          Visual direction
                          <textarea
                            value={s.image_prompt}
                            rows={2}
                            placeholder="Describe what the audience sees…"
                            onChange={(e) =>
                              update((p) => ({
                                ...p,
                                scenes: p.scenes.map((x) =>
                                  x.id === s.id
                                    ? { ...x, image_prompt: e.target.value }
                                    : x,
                                ),
                              }))
                            }
                          />
                        </label>
                        <div className="scene-meta">
                          <span>
                            {s.script.trim()
                              ? s.script.trim().split(/\s+/).length
                              : 0}{" "}
                            words
                          </span>
                          <label>
                            Duration
                            <input
                              type="number"
                              min={0.1}
                              max={120}
                              step={0.1}
                              value={s.duration}
                              onChange={(e) =>
                                update((p) => ({
                                  ...p,
                                  scenes: p.scenes.map((x) =>
                                    x.id === s.id
                                      ? {
                                          ...x,
                                          duration: Math.max(
                                            0.1,
                                            Math.min(
                                              120,
                                              Number(e.target.value) || 0.1,
                                            ),
                                          ),
                                        }
                                      : x,
                                  ),
                                }))
                              }
                            />
                            sec
                          </label>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
            {stage === 2 && (
              <>
                <div className="scene-review-header">
                  <h2>
                    Your cast <span>{draft.characters.length} characters</span>
                  </h2>
                  <button
                    className="button secondary library-open"
                    disabled={busy || libraryLoading}
                    onClick={() => void loadLibrary()}
                  >
                    {libraryLoading ? "Loading…" : "Add from library"}
                  </button>
                  <button
                    className="button secondary"
                    onClick={() =>
                      update((p) => ({
                        ...p,
                        characters: [
                          ...p.characters,
                          {
                            id: crypto.randomUUID(),
                            name: "New character",
                            description: "",
                            asset_id: null,
                          },
                        ],
                      }))
                    }
                  >
                    ＋ Add character
                  </button>
                </div>
                {batchControl}
                {!draft.characters.length && (
                  <EmptyState
                    icon="♙"
                    title="Every story needs a little character"
                    text="Add recurring characters and their visual references. A landscape or abstract story can skip this step."
                    action="Add a character"
                    onAction={() =>
                      update((p) => ({
                        ...p,
                        characters: [
                          ...p.characters,
                          {
                            id: crypto.randomUUID(),
                            name: "New character",
                            description: "",
                            asset_id: null,
                          },
                        ],
                      }))
                    }
                  />
                )}
                <div className="character-list">
                  {draft.characters.map((c) => (
                    <article className="panel character-card" key={c.id}>
                      <div className="character-portrait">
                        {c.asset_id && assetMap.get(c.asset_id) ? (
                          <img
                            src={assetMap.get(c.asset_id)!.url}
                            alt={c.name}
                          />
                        ) : (
                          <span>♙</span>
                        )}
                        <UploadButton
                          label="Upload reference"
                          kind="character"
                          disabled={busy}
                          onFile={(f) =>
                            void upload(f, "character", undefined, c.id)
                          }
                        />
                      </div>
                      <div className="character-details">
                        <div className="character-title">
                          <input
                            aria-label="Character name"
                            value={c.name}
                            onChange={(e) =>
                              updateCharacter(c.id, { name: e.target.value })
                            }
                          />
                          <button
                            className="icon-button"
                            aria-label={"Remove " + c.name}
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Remove this character from the cast and all scenes?",
                                )
                              )
                                update((p) => ({
                                  ...p,
                                  characters: p.characters.filter(
                                    (x) => x.id !== c.id,
                                  ),
                                  scenes: p.scenes.map((s) => ({
                                    ...s,
                                    character_ids: s.character_ids.filter(
                                      (id) => id !== c.id,
                                    ),
                                  })),
                                }));
                            }}
                          >
                            ×
                          </button>
                        </div>
                        <label>
                          Character description
                          <textarea
                            rows={3}
                            value={c.description}
                            placeholder="Appearance, clothing, personality, and the little things that make them unique…"
                            onChange={(e) =>
                              updateCharacter(c.id, {
                                description: e.target.value,
                              })
                            }
                          />
                        </label>
                        <button
                          className="button secondary"
                          disabled={
                            busy ||
                            !capabilities.providers.image ||
                            !c.description.trim()
                          }
                          onClick={() =>
                            void runJob(
                              "character",
                              undefined,
                              c.id,
                              c.description,
                            )
                          }
                        >
                          ✦ Generate reference
                        </button>
                        <div className="character-alternatives">
                          {assets
                            .filter(
                              (a) =>
                                a.kind === "character" &&
                                a.character_id === c.id,
                            )
                            .map((a) => (
                              <button
                                className={
                                  c.asset_id === a.id ? "selected" : ""
                                }
                                key={a.id}
                                onClick={() =>
                                  updateCharacter(c.id, { asset_id: a.id })
                                }
                                aria-label={"Use " + a.name}
                              >
                                <img src={a.url} alt={a.name} />
                                {c.asset_id === a.id && <span>✓</span>}
                              </button>
                            ))}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
                {draft.characters.length > 0 &&
                  !capabilities.providers.image && (
                    <ProviderNote kind="Image" />
                  )}
              </>
            )}
            {(stage === 3 || stage === 4 || stage === 5) && (
              <>
                {batchControl}
                <ScenePicker
                  scenes={draft.scenes}
                  selected={scene?.id}
                  assets={assetMap}
                  onSelect={setSelected}
                />
                {!scene ? (
                  <EmptyState
                    icon="▧"
                    title="Add your first scene"
                    text="Start with the story, then give it pictures and sound."
                    action="Write your story"
                    onAction={() => setStage(1)}
                  />
                ) : (
                  <div className="panel scene-media-panel">
                    <div className="panel-title">
                      <span
                        className={
                          "section-icon " +
                          (stage === 3
                            ? "lavender"
                            : stage === 4
                              ? "pink"
                              : "mint")
                        }
                      >
                        {stages[stage].icon}
                      </span>
                      <h2>{scene.title}</h2>
                      <span className="scene-order">
                        Scene {draft.scenes.indexOf(scene) + 1} of{" "}
                        {draft.scenes.length}
                      </span>
                    </div>
                    {stage === 3 && (
                      <>
                        <div
                          className="scene-visual-preview"
                          style={{ aspectRatio: draft.ratio.replace(":", "/") }}
                        >
                          {scene.image_id && assetMap.get(scene.image_id) ? (
                            <img
                              src={assetMap.get(scene.image_id)!.url}
                              alt={scene.title}
                            />
                          ) : (
                            <div>
                              <span>▧</span>
                              <strong>Picture this moment</strong>
                              <p>
                                Your selected illustration will appear here.
                              </p>
                            </div>
                          )}
                        </div>
                        <label>
                          Visual direction
                          <textarea
                            rows={4}
                            value={scene.image_prompt}
                            placeholder="Describe the setting, action, mood, and details for this scene…"
                            onChange={(e) =>
                              updateScene({ image_prompt: e.target.value })
                            }
                          />
                        </label>
                        {draft.characters.length > 0 && (
                          <div className="scene-cast">
                            <span>Characters in this scene</span>
                            {draft.characters.map((c) => (
                              <button
                                key={c.id}
                                className={
                                  scene.character_ids.includes(c.id)
                                    ? "selected"
                                    : ""
                                }
                                onClick={() =>
                                  updateScene({
                                    character_ids: scene.character_ids.includes(
                                      c.id,
                                    )
                                      ? scene.character_ids.filter(
                                          (id) => id !== c.id,
                                        )
                                      : [...scene.character_ids, c.id],
                                  })
                                }
                              >
                                {scene.character_ids.includes(c.id)
                                  ? "✓ "
                                  : "＋ "}
                                {c.name}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="media-actions">
                          <UploadButton
                            label="Upload image"
                            kind="image"
                            disabled={busy}
                            onFile={(f) => void upload(f, "image", scene.id)}
                          />
                          <button
                            className="button primary"
                            disabled={
                              busy ||
                              !capabilities.providers.image ||
                              !scene.image_prompt.trim()
                            }
                            onClick={() =>
                              void runJob(
                                "image",
                                scene.id,
                                undefined,
                                scene.image_prompt,
                              )
                            }
                          >
                            ✦ Generate image
                          </button>
                        </div>
                        {!capabilities.providers.image && (
                          <ProviderNote kind="Image" />
                        )}
                        <AssetChoices
                          kind="image"
                          assets={assets.filter(
                            (a) =>
                              a.kind === "image" &&
                              (a.scene_id === scene.id || !a.scene_id),
                          )}
                          selected={scene.image_id}
                          onSelect={(id) =>
                            updateScene({ image_id: id, visual: "image" })
                          }
                        />
                      </>
                    )}
                    {stage === 4 && (
                      <>
                        <label>
                          Narration
                          <textarea
                            rows={5}
                            value={scene.script}
                            placeholder="The words that bring this moment to life…"
                            onChange={(e) =>
                              updateScene({ script: e.target.value })
                            }
                          />
                        </label>
                        <div className="voice-selection">
                          <label>
                            Voice
                            <select
                              value={voice}
                              onChange={(e) => setVoice(e.target.value)}
                              disabled={!capabilities.voices.length}
                            >
                              {!capabilities.voices.length && (
                                <option value="">
                                  No generated voices configured
                                </option>
                              )}
                              {capabilities.voices.map((v) => (
                                <option value={v.id} key={v.id}>
                                  {v.name}
                                  {v.description ? " · " + v.description : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="button primary"
                            disabled={
                              busy ||
                              !capabilities.providers.voice ||
                              !voice ||
                              !scene.script.trim()
                            }
                            onClick={() => void runJob("voice", scene.id)}
                          >
                            ✦ Generate narration
                          </button>
                        </div>
                        <div className="media-actions">
                          <UploadButton
                            label="Upload narration"
                            kind="voice"
                            disabled={busy}
                            onFile={(f) => void upload(f, "voice", scene.id)}
                          />
                          <span className="field-help">
                            Use your own recording or choose a generated take.
                          </span>
                        </div>
                        {!capabilities.providers.voice && (
                          <ProviderNote kind="Voice" />
                        )}
                        <AssetChoices
                          kind="voice"
                          assets={assets.filter(
                            (a) =>
                              a.kind === "voice" &&
                              (a.scene_id === scene.id || !a.scene_id),
                          )}
                          selected={scene.voice_id}
                          onSelect={(id) =>
                            updateScene({
                              voice_id: id,
                              duration_mode: id ? "voice" : "manual",
                            })
                          }
                        />
                        {scene.voice_id && (
                          <div className="selected-media-note">
                            ✓ Selected narration sets this scene’s duration.
                            Fine-tune it in the editor.
                          </div>
                        )}
                      </>
                    )}
                    {stage === 5 && (
                      <>
                        <div
                          className="scene-visual-preview"
                          style={{ aspectRatio: draft.ratio.replace(":", "/") }}
                        >
                          {scene.visual === "video" &&
                          scene.video_id &&
                          assetMap.get(scene.video_id) ? (
                            <video
                              controls
                              src={assetMap.get(scene.video_id)!.url}
                            />
                          ) : scene.image_id && assetMap.get(scene.image_id) ? (
                            <img
                              src={assetMap.get(scene.image_id)!.url}
                              alt={scene.title}
                            />
                          ) : (
                            <div>
                              <span>▷</span>
                              <strong>A little movement, a little magic</strong>
                              <p>
                                Use your selected illustration or choose a video
                                clip.
                              </p>
                            </div>
                          )}
                        </div>
                        <div className="segmented-control">
                          <button
                            className={
                              scene.visual === "image" ? "selected" : ""
                            }
                            onClick={() =>
                              updateScene({
                                visual: "image",
                                duration_mode: scene.voice_id
                                  ? "voice"
                                  : "manual",
                              })
                            }
                          >
                            Still illustration
                          </button>
                          <button
                            className={
                              scene.visual === "video" ? "selected" : ""
                            }
                            disabled={!scene.video_id}
                            onClick={() =>
                              updateScene({
                                visual: "video",
                                duration_mode: "video",
                              })
                            }
                          >
                            Video clip
                          </button>
                        </div>
                        <label>
                          Motion direction
                          <textarea
                            rows={3}
                            value={scene.video_prompt}
                            placeholder="A slow camera move through the trees as the leaves drift gently…"
                            onChange={(e) =>
                              updateScene({ video_prompt: e.target.value })
                            }
                          />
                        </label>
                        <div className="media-actions">
                          <UploadButton
                            label="Upload video"
                            kind="video"
                            disabled={busy}
                            onFile={(f) => void upload(f, "video", scene.id)}
                          />
                          <button
                            className="button primary"
                            disabled={
                              busy ||
                              !capabilities.providers.video ||
                              !scene.video_prompt.trim()
                            }
                            onClick={() =>
                              void runJob(
                                "video",
                                scene.id,
                                undefined,
                                scene.video_prompt,
                              )
                            }
                          >
                            ✦ Generate video
                          </button>
                        </div>
                        {!capabilities.providers.video && (
                          <ProviderNote kind="Video" />
                        )}
                        <AssetChoices
                          kind="video"
                          assets={assets.filter(
                            (a) =>
                              a.kind === "video" &&
                              (a.scene_id === scene.id || !a.scene_id),
                          )}
                          selected={scene.video_id}
                          onSelect={(id) =>
                            updateScene({
                              video_id: id,
                              visual: id ? "video" : "image",
                              duration_mode: id
                                ? "video"
                                : scene.voice_id
                                  ? "voice"
                                  : "manual",
                            })
                          }
                        />
                      </>
                    )}
                  </div>
                )}
                {stage === 4 && (
                  <div className="panel music-panel">
                    <div className="panel-title">
                      <span className="section-icon mint">♫</span>
                      <h2>Set the mood</h2>
                      <span className="optional-label">
                        Optional soundtrack
                      </span>
                    </div>
                    <p className="muted">
                      Choose one track for your whole story. Mix it with
                      narration in the editor.
                    </p>
                    <div className="media-actions">
                      <UploadButton
                        label="Upload music"
                        kind="music"
                        disabled={busy}
                        onFile={(f) => void upload(f, "music")}
                      />
                    </div>
                    {capabilities.providers.music && (
                      <>
                        <label>
                          Describe your soundtrack
                          <textarea
                            value={musicPrompt}
                            rows={2}
                            onChange={(e) => setMusicPrompt(e.target.value)}
                            placeholder="Warm acoustic instrumental, gentle and uplifting…"
                          />
                        </label>
                        <button
                          className="button secondary"
                          disabled={busy || !musicPrompt.trim()}
                          onClick={() =>
                            void runJob(
                              "music",
                              undefined,
                              undefined,
                              musicPrompt,
                            )
                          }
                        >
                          ✦ Generate music
                        </button>
                      </>
                    )}
                    <AssetChoices
                      kind="music"
                      assets={assets.filter((a) => a.kind === "music")}
                      selected={draft.music.asset_id}
                      onSelect={(id) =>
                        update((p) => ({
                          ...p,
                          music: { ...p.music, asset_id: id },
                        }))
                      }
                    />
                  </div>
                )}
              </>
            )}
          </section>
          <aside className="guide-sidebar">
            <div className={"tip-card tip-" + stage}>
              <span className="tip-illustration">{stages[stage].icon}</span>
              <h3>
                {
                  [
                    "Big ideas love a little detail.",
                    "Your story, your way.",
                    "Consistency starts with character.",
                    "Make every scene a world.",
                    "Sound makes the moment.",
                    "The finishing touches.",
                  ][stage]
                }
              </h3>
              <p>
                {
                  [
                    "Who is it for? Where does it happen? What should your audience feel? A few details help shape a story that is yours.",
                    "Read your narration out loud. Give each scene one clear moment, and leave room for the images to do some storytelling.",
                    "Describe the same distinctive features for each appearance. Add reference images to help communicate your cast’s look.",
                    "Your project style and character references travel with image requests. Keep alternatives and choose the one that feels right.",
                    "A warm voice or a subtle soundtrack can change everything. Try a few takes and choose your favorites.",
                    "Open the editor to arrange scenes, adjust timing, add captions and layers, then download a private MP4.",
                  ][stage]
                }
              </p>
            </div>
            <div className="project-progress-card">
              <h3>Your story at a glance</h3>
              <div>
                <span>Scenes</span>
                <strong>{draft.scenes.length}</strong>
              </div>
              <div>
                <span>Characters</span>
                <strong>{draft.characters.length}</strong>
              </div>
              <div>
                <span>Visuals selected</span>
                <strong>
                  {visualReady} / {draft.scenes.length}
                </strong>
              </div>
              <div>
                <span>Narration selected</span>
                <strong>
                  {voiceReady} / {draft.scenes.length}
                </strong>
              </div>
              <div className="readiness-track">
                <i
                  style={{
                    width: `${draft.scenes.length ? (visualReady / draft.scenes.length) * 100 : 0}%`,
                  }}
                />
              </div>
              <small>Scenes with selected visuals</small>
            </div>
            {hasActive && (
              <div className="production-running">
                <span className="spinner" />
                <div>
                  <strong>Creating in the background</strong>
                  <p>
                    {jobs.filter(activeJob).length} active{" "}
                    {jobs.filter(activeJob).length === 1
                      ? "request"
                      : "requests"}
                  </p>
                </div>
                <button
                  className="text-button"
                  onClick={() => setShowActivity(true)}
                >
                  View
                </button>
              </div>
            )}
            <button
              className="editor-shortcut"
              onClick={() => void openEditor()}
              disabled={busy || !draft.scenes.length}
            >
              <span>Ready to see it together?</span>
              <strong>
                Open the video editor <b>↗</b>
              </strong>
            </button>
          </aside>
        </div>
        <footer className="guide-footer">
          <button
            className="button secondary"
            disabled={stage === 0}
            onClick={() => setStage((s) => Math.max(0, s - 1))}
          >
            ← Previous step
          </button>
          <span>Make it yours. There’s no rush.</span>
          {stage < 5 ? (
            <button
              className="button primary"
              onClick={() => setStage((s) => Math.min(5, s + 1))}
            >
              Next: {stages[stage + 1].name} →
            </button>
          ) : (
            <button
              className="button primary"
              onClick={() => void openEditor()}
              disabled={busy || !draft.scenes.length}
            >
              Finish in the editor →
            </button>
          )}
        </footer>
      </main>
      {showActivity && (
        <div
          className="activity-backdrop"
          onClick={() => setShowActivity(false)}
        >
          <aside
            className="activity-drawer"
            aria-label="Production activity"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="activity-header">
              <div>
                <span className="eyebrow">YOUR PRODUCTION</span>
                <h2>Activity</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setShowActivity(false)}
                aria-label="Close activity"
              >
                ×
              </button>
            </div>
            <p className="muted">
              Each request keeps its result for you to review and select.
            </p>
            <button
              className="text-button"
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              ↻ Refresh activity
            </button>
            {!jobs.length && (
              <EmptyState
                icon="◷"
                title="A quiet moment"
                text="Generation and export requests will appear here."
              />
            )}
            {jobs.map((j) => (
              <article key={j.id} className={"job-card job-" + j.status}>
                <header>
                  <strong>
                    {j.kind.replaceAll("_", " ")}
                    <span className="job-status">{j.status}</span>
                  </strong>
                  <time>
                    {new Date(j.created_at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </header>
                {activeJob(j) && (
                  <>
                    <progress
                      max={1}
                      value={j.progress > 1 ? j.progress / 100 : j.progress}
                    />
                    <button
                      className="text-button"
                      onClick={async () => {
                        try {
                          const next = await api.cancelJob(j.id);
                          setJobs((list) =>
                            list.map((x) => (x.id === next.id ? next : x)),
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Cancel request
                    </button>
                  </>
                )}
                {j.error && <p className="job-error">{j.error}</p>}
                {j.status === "unknown" && (
                  <p>
                    The provider outcome is uncertain. Check the provider before
                    making another request.
                  </p>
                )}
                {j.status === "succeeded" && (
                  <p>
                    {j.kind === "story"
                      ? "Your story candidate is ready to review."
                      : "Your result is ready in the media alternatives."}
                  </p>
                )}
                {j.kind === "story" && j.status === "succeeded" && (
                  <button
                    className="button secondary"
                    disabled={applied.includes(j.id)}
                    onClick={() => {
                      setShowActivity(false);
                      setStage(0);
                    }}
                  >
                    {applied.includes(j.id)
                      ? "Applied to draft"
                      : "Review story"}
                  </button>
                )}
              </article>
            ))}
          </aside>
        </div>
      )}
      {library && (
        <div
          className="modal-backdrop"
          onClick={() => !working && setLibrary(null)}
        >
          <section
            className="character-library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="character-library-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="activity-header">
              <div>
                <span className="eyebrow">YOUR CHARACTERS</span>
                <h2 id="character-library-title">Add from library</h2>
              </div>
              <button
                className="icon-button"
                disabled={working}
                onClick={() => setLibrary(null)}
                aria-label="Close character library"
              >
                ×
              </button>
            </div>
            <p className="muted">
              Bring a character from another project into this story.
            </p>
            {library.length ? (
              <div className="character-library-grid">
                {library.map((c) => (
                  <article key={c.id}>
                    {c.asset ? (
                      <img src={c.asset.url} alt={c.name} />
                    ) : (
                      <div className="library-avatar">♙</div>
                    )}
                    <h3>{c.name}</h3>
                    <small>{c.project_name}</small>
                    <p>{c.description}</p>
                    <button
                      className="button primary"
                      disabled={working}
                      onClick={() => void importCharacter(c)}
                    >
                      {working ? "Adding…" : "Add character"}
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                icon="♙"
                title="Your cast will grow with you"
                text="Characters from your other projects will appear here. Create a character in this project to start building your library."
              />
            )}
          </section>
        </div>
      )}
      {storyReplace && (
        <div className="modal-backdrop">
          <div
            className="small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="replace-title"
          >
            <h2 id="replace-title">Use this new story?</h2>
            <p>
              This replaces the scenes and characters in your current draft.
              Existing media alternatives remain saved in the project.
            </p>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => setStoryReplace(null)}
              >
                Keep current story
              </button>
              <button
                className="button primary"
                onClick={() => applyStory(storyReplace)}
              >
                Use new story
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function ProviderNote({ kind }: { kind: string }) {
  return (
    <p className="provider-unavailable">
      {kind} generation isn’t connected yet.{" "}
      {kind === "Story"
        ? "Write your own scenes to get started."
        : "Upload your own media to continue."}
    </p>
  );
}
function UploadButton({
  label,
  kind,
  disabled,
  onFile,
}: {
  label: string;
  kind: AssetKind;
  disabled: boolean;
  onFile: (f: File) => void;
}) {
  return (
    <label
      className={
        "button secondary upload-button " + (disabled ? "disabled" : "")
      }
    >
      <span>↑</span>
      {label}
      <input
        type="file"
        accept={
          kind === "image" || kind === "character"
            ? "image/png,image/jpeg,image/webp"
            : kind === "video"
              ? "video/mp4,video/webm,video/quicktime"
              : "audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/flac"
        }
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </label>
  );
}
function ScenePicker({
  scenes,
  selected,
  assets,
  onSelect,
}: {
  scenes: Scene[];
  selected?: string;
  assets: Map<string, Asset>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="guide-scene-picker" aria-label="Choose scene">
      {scenes.map((s, i) => (
        <button
          key={s.id}
          className={s.id === selected ? "selected" : ""}
          onClick={() => onSelect(s.id)}
        >
          <span className="scene-picker-thumb">
            {s.image_id && assets.get(s.image_id) ? (
              <img src={assets.get(s.image_id)!.url} alt="" />
            ) : (
              <b>▧</b>
            )}
            <small>{i + 1}</small>
          </span>
          <strong>{s.title}</strong>
        </button>
      ))}
    </div>
  );
}
function AssetChoices({
  kind,
  assets,
  selected,
  onSelect,
}: {
  kind: AssetKind;
  assets: Asset[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (!assets.length)
    return (
      <div className="empty-alternatives">
        Your{" "}
        {kind === "voice"
          ? "narration takes"
          : kind === "music"
            ? "soundtracks"
            : "alternatives"}{" "}
        will appear here.
      </div>
    );
  return (
    <section
      className={
        "asset-alternatives " +
        (kind === "voice" || kind === "music" ? "audio-alternatives" : "")
      }
    >
      <div className="alternatives-heading">
        <h3>
          {kind === "voice"
            ? "Narration takes"
            : kind === "music"
              ? "Your soundtracks"
              : "Your alternatives"}{" "}
          <span>{assets.length}</span>
        </h3>
        {selected && (
          <button className="text-button" onClick={() => onSelect(null)}>
            Clear selection
          </button>
        )}
      </div>
      <div className="alternatives-grid">
        {assets.map((a) => (
          <article
            key={a.id}
            className={"asset-choice " + (selected === a.id ? "selected" : "")}
          >
            {kind === "voice" || kind === "music" ? (
              <>
                <div className="audio-choice-name">
                  <span>♫</span>
                  <strong title={a.name}>{a.name}</strong>
                </div>
                <audio controls src={a.url} preload="metadata" />
              </>
            ) : kind === "video" ? (
              <video controls src={a.url} preload="metadata" />
            ) : (
              <img src={a.url} alt={a.name} />
            )}
            <div className="asset-choice-footer">
              <span>
                {a.source === "upload" ? "Uploaded" : "Generated"}
                {a.duration ? " · " + Math.round(a.duration) + "s" : ""}
              </span>
              <button
                className={selected === a.id ? "chosen" : "text-button"}
                onClick={() => onSelect(a.id)}
              >
                {selected === a.id ? "✓ Selected" : "Use this"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
function EmptyState({
  icon,
  title,
  text,
  action,
  onAction,
}: {
  icon: string;
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="guide-empty">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button className="button secondary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}
function StoryCandidate({
  job,
  applied,
  onApply,
}: {
  job: Job;
  applied: boolean;
  onApply: () => void;
}) {
  const result = job.result as { scenes?: Partial<Scene>[] } | null;
  return (
    <article className="panel story-candidate">
      <div className="panel-title">
        <span className="section-icon peach">✦</span>
        <h2>Story candidate</h2>
        <span className="job-status">{job.status}</span>
      </div>
      {activeJob(job) ? (
        <p className="muted">
          Your story is taking shape. You can keep exploring the guide.
        </p>
      ) : job.status === "succeeded" && Array.isArray(result?.scenes) ? (
        <>
          <div className="candidate-scenes">
            {result.scenes.map((s, i) => (
              <div key={i}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{s.title ?? "Scene " + (i + 1)}</h3>
                  <p>{s.script}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="panel-actions">
            <span className="field-help">
              Your current story changes only when you apply this result.
            </span>
            <button
              className="button primary"
              disabled={applied}
              onClick={onApply}
            >
              {applied ? "✓ Applied" : "Use this story"}
            </button>
          </div>
        </>
      ) : (
        <p className="job-error">
          {job.error ??
            (job.status === "cancelled"
              ? "This request was cancelled."
              : "No story result is available.")}
        </p>
      )}
    </article>
  );
}
