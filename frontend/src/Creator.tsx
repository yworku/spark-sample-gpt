import { useState } from "react";
import { api } from "./api";
import type { Capabilities, Project, Ratio } from "./types";
interface Props {
  capabilities: Capabilities;
  onClose: () => void;
  onCreated: (
    p: Project,
    prompt: string,
    stage: number,
    editor?: boolean,
  ) => void;
}
export default function Creator({ capabilities, onClose, onCreated }: Props) {
  const [choosing, setChoosing] = useState(true),
    [creation, setCreation] = useState<"guide" | "editor">("guide");
  const [mode, setMode] = useState<"idea" | "paste" | "blank">("idea"),
    [name, setName] = useState(""),
    [script, setScript] = useState(""),
    [ratio, setRatio] = useState<Ratio>("16:9"),
    [style, setStyle] = useState(capabilities.styles[0]?.id ?? "custom"),
    [language, setLanguage] = useState("English"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [category, setCategory] = useState("All");
  const categories = [
    "All",
    ...new Set(capabilities.styles.map((s) => s.category)),
  ];
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const p = await api.createProject({
        name: name.trim() || "Untitled story",
        kind: "video",
        ratio,
        style,
        language,
        mode: mode === "paste" ? "paste" : "blank",
        ...(mode === "paste" ? { script } : {}),
      });
      onCreated(
        p,
        mode === "idea" ? script : "",
        mode === "idea" ? 0 : 1,
        creation === "editor",
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  if (choosing)
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <section
          className="creation-mode-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="creation-mode-title"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="icon-button mode-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
          <h2 id="creation-mode-title">Create New Project</h2>
          <p>Choose a creation mode to get started</p>
          <div className="creation-modes">
            <button
              className={creation === "guide" ? "selected" : ""}
              onClick={() => setCreation("guide")}
            >
              <span className="mode-graphic">✦</span>
              <strong>
                Spark<span>Guide</span>
              </strong>
              <small>AI-powered creation</small>
              <i>{creation === "guide" ? "✓" : ""}</i>
            </button>
            <button
              className={creation === "editor" ? "selected" : ""}
              onClick={() => setCreation("editor")}
            >
              <span className="mode-graphic">▤</span>
              <strong>
                Spark<span>Studio</span>
              </strong>
              <small>Full manual control</small>
              <i>{creation === "editor" ? "✓" : ""}</i>
            </button>
          </div>
          <div className="modal-actions">
            <button className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="button primary"
              onClick={() => {
                if (creation === "editor") setMode("blank");
                setChoosing(false);
              }}
            >
              Create Project
            </button>
          </div>
        </section>
      </div>
    );
  return (
    <div
      className="modal-backdrop creator-backdrop creator-fullscreen"
      onClick={() => !busy && onClose()}
    >
      <section
        className="creator-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="creator-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="creator-header">
          <div>
            <span className="eyebrow">
              {creation === "guide" ? "SPARK GUIDE" : "SPARK STUDIO"}
            </span>
            <h2 id="creator-title">
              {creation === "guide" ? (
                <>
                  Your <em>Story</em>
                </>
              ) : (
                "Create Your Project"
              )}
            </h2>
            <p>
              {creation === "guide"
                ? "Describe your idea or paste a script to get started."
                : "Choose a name, style and format for your blank canvas."}
            </p>
          </div>
          <button
            className="icon-button close-button"
            aria-label="Close new project"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </header>
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <div className="creator-content">
              <div className="creator-main">
                <label>
                  Project name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="A name for your big idea"
                    maxLength={120}
                    required
                    autoFocus
                  />
                </label>
                {creation === "guide" && (
                  <>
                    <label className="field-title">
                      How would you like to start?
                    </label>
                    <div className="start-options">
                      {(
                        [
                          {
                            id: "idea",
                            icon: "✦",
                            title: "From an idea",
                            description: "Shape your story with AI",
                          },
                          {
                            id: "paste",
                            icon: "≡",
                            title: "Use my script",
                            description: "Bring your own words",
                          },
                          {
                            id: "blank",
                            icon: "＋",
                            title: "Blank canvas",
                            description: "Build scene by scene",
                          },
                        ] as const
                      ).map((m) => (
                        <button
                          type="button"
                          className={mode === m.id ? "selected" : ""}
                          key={m.id}
                          onClick={() => setMode(m.id)}
                        >
                          <span>{m.icon}</span>
                          <strong>{m.title}</strong>
                          <small>{m.description}</small>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {mode !== "blank" && (
                  <label>
                    {mode === "idea"
                      ? "Tell us about your idea"
                      : "Paste your script"}
                    <textarea
                      value={script}
                      onChange={(e) => setScript(e.target.value)}
                      placeholder={
                        mode === "idea"
                          ? "A curious fox discovers a tiny world hidden inside an old oak tree…"
                          : "Paste your story here. Separate each scene with a blank line."
                      }
                      rows={5}
                      maxLength={30000}
                      required={mode === "paste"}
                    />
                    <span className="field-help">
                      {mode === "idea"
                        ? "Your idea opens in the guide. You choose when to generate a story."
                        : "Each paragraph becomes a scene. This step does not call an AI model."}
                    </span>
                  </label>
                )}
                <div className="field-title style-title">
                  <span>Choose your visual style</span>
                  <span className="optional-label">Make it feel like you</span>
                </div>
                <div className="style-categories">
                  {categories.map((c) => (
                    <button
                      type="button"
                      key={c}
                      className={c === category ? "active" : ""}
                      onClick={() => setCategory(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <div className="style-gallery">
                  {capabilities.styles
                    .filter(
                      (s) => category === "All" || s.category === category,
                    )
                    .map((s, i) => (
                      <button
                        type="button"
                        key={s.id}
                        className={
                          "style-card " + (style === s.id ? "selected" : "")
                        }
                        onClick={() => setStyle(s.id)}
                        aria-pressed={style === s.id}
                      >
                        <StyleArtwork id={s.id} index={i} />
                        <span>{s.name}</span>
                        {style === s.id && <b className="selection-check">✓</b>}
                      </button>
                    ))}
                </div>
              </div>
              <aside className="creator-settings">
                <h3>The little details</h3>
                <p>Set the stage for your story.</p>
                <label className="field-title">Video format</label>
                <div className="ratio-options">
                  {(["16:9", "9:16", "1:1"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={r === ratio ? "selected" : ""}
                      onClick={() => setRatio(r)}
                      aria-pressed={r === ratio}
                    >
                      <span
                        className={"ratio-shape ratio-" + r.replace(":", "-")}
                      />
                      <strong>{r}</strong>
                      <small>
                        {r === "16:9"
                          ? "Landscape"
                          : r === "9:16"
                            ? "Portrait"
                            : "Square"}
                      </small>
                    </button>
                  ))}
                </div>
                <label>
                  Story language
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  >
                    {[
                      "English",
                      "Spanish",
                      "French",
                      "German",
                      "Italian",
                      "Portuguese",
                      "Amharic",
                      "Japanese",
                      "Korean",
                      "Arabic",
                      "Hindi",
                      "Chinese",
                    ].map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                </label>
                <div className="creator-tip">
                  <span>✧</span>
                  <strong>One step at a time</strong>
                  <p>
                    Review your story, choose your cast, create visuals, and add
                    sound. You’re in control of every step.
                  </p>
                </div>
                <div className="provider-note">
                  <i
                    className={capabilities.providers.story ? "connected" : ""}
                  />
                  {capabilities.providers.story
                    ? "AI story generation connected"
                    : "You can start with your own story and media."}
                </div>
              </aside>
            </div>
            {error && (
              <div className="error-banner creator-error" role="alert">
                {error}
              </div>
            )}
            <footer className="creator-footer">
              <span>No media generation starts until you request it.</span>
              <div>
                <button
                  className="button secondary"
                  type="button"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button className="button primary" type="submit">
                  {busy ? "Creating…" : "Create project"} <span>→</span>
                </button>
              </div>
            </footer>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
export function StyleArtwork({
  id,
  index = 0,
}: {
  id: string;
  index?: number;
}) {
  const [failed, setFailed] = useState(false);
  const mapped =
    id === "3d-cartoon" ? "animated-3d" : id === "clay" ? "claymation" : id;
  const imageId = ["animated-3d", "watercolor", "anime", "claymation"].includes(
    mapped,
  )
    ? mapped
    : null;
  return (
    <div className={"style-art style-art-" + (index % 6)}>
      {imageId && !failed ? (
        <img
          src={"/styles/" + imageId + ".png"}
          alt=""
          onError={() => setFailed(true)}
        />
      ) : (
        <>
          <div className="style-art-sun" />
          <div className="style-art-hill hill-one" />
          <div className="style-art-hill hill-two" />
          <span>✦</span>
        </>
      )}
    </div>
  );
}
