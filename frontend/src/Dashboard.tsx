import { useEffect, useState } from "react";
import { api } from "./api";
import type { Capabilities, Project, Asset } from "./types";
interface Props {
  projects: Project[];
  capabilities: Capabilities | null;
  loading: boolean;
  onCreate: () => void;
  onOpen: (p: Project, editor?: boolean) => void;
  onRefresh: () => Promise<void>;
}
export default function Dashboard({
  projects,
  capabilities,
  loading,
  onCreate,
  onOpen,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("updated"),
    [menu, setMenu] = useState<string | null>(null),
    [deleting, setDeleting] = useState<Project | null>(null),
    [removed, setRemoved] = useState<Project | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const active = projects.filter((p) => !p.deleted_at),
    list = active
      .filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) &&
          (filter === "all" || p.kind === filter),
      )
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : b.updated_at.localeCompare(a.updated_at),
      );
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteProject(deleting.id);
      setRemoved(deleting);
      setDeleting(null);
      setMenu(null);
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="dashboard">
      <div className="dashboard-title">
        <div>
          <h1>
            Your <em>Projects</em>{" "}
            <span className="count-pill">{active.length}</span>
          </h1>
          <p className="page-subtitle">
            Manage your videos and stories all in one place.
          </p>
        </div>
        <button
          className="button primary create-project"
          onClick={onCreate}
          disabled={!capabilities}
        >
          <span>＋</span>New Project
        </button>
      </div>
      <div className="workspace-badges">
        <span>
          <i />
          Private projects
        </span>
        <span>✦ Your creative studio</span>
      </div>
      <div className="project-toolbar">
        <div className="filter-pills">
          <button
            className={filter === "all" ? "selected" : ""}
            onClick={() => setFilter("all")}
          >
            All projects <span>{active.length}</span>
          </button>
          {capabilities?.project_types
            .filter((t) => t.enabled)
            .map((t) => (
              <button
                key={t.id}
                className={filter === t.id ? "selected" : ""}
                onClick={() => setFilter(t.id)}
              >
                {t.label}
              </button>
            ))}
        </div>
        <div className="project-search">
          <label>
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
            />
          </label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label="Sort projects"
          >
            <option value="updated">Last edited</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {removed && (
        <div className="undo-banner" role="status">
          <span>“{removed.name}” moved to trash.</span>
          <button
            className="text-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.restoreProject(removed.id);
                setRemoved(null);
                await onRefresh();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Undo
          </button>
          <button
            className="icon-button"
            aria-label="Dismiss"
            onClick={() => setRemoved(null)}
          >
            ×
          </button>
        </div>
      )}
      <div className="project-grid">
        {list.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            capabilities={capabilities}
            onOpen={() => onOpen(p)}
            menuOpen={menu === p.id}
            onMenu={() => setMenu(menu === p.id ? null : p.id)}
            onDelete={() => setDeleting(p)}
            onEditor={() => onOpen(p, true)}
          />
        ))}
      </div>
      {loading && (
        <p className="muted loading-label" role="status">
          Loading your workspace…
        </p>
      )}
      {!loading && !active.length && (
        <div className="dashboard-empty">
          <div>✦</div>
          <h2>Your next story starts here</h2>
          <p>Create a project and turn your imagination into a video.</p>
          <button className="button primary" onClick={onCreate}>
            ＋ New Project
          </button>
        </div>
      )}
      {query && !list.length && (
        <p className="empty-search">No projects match “{query}”.</p>
      )}
      {projects.some((p) => p.deleted_at) && (
        <details className="trash-list">
          <summary>
            Recently deleted ({projects.filter((p) => p.deleted_at).length})
          </summary>
          {projects
            .filter((p) => p.deleted_at)
            .map((p) => (
              <div key={p.id}>
                <span>{p.name}</span>
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await api.restoreProject(p.id);
                      await onRefresh();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Restore project
                </button>
              </div>
            ))}
        </details>
      )}
      {deleting && (
        <div
          className="modal-backdrop"
          onClick={() => !busy && setDeleting(null)}
        >
          <section
            className="small-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-heading"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="modal-symbol">⌫</span>
            <h2 id="delete-heading">Move this project to trash?</h2>
            <p>
              “{deleting.name}” and its media will be retained. You can restore
              the project later.
            </p>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => setDeleting(null)}
                disabled={busy}
              >
                Keep project
              </button>
              <button
                className="button danger"
                onClick={() => void remove()}
                disabled={busy}
              >
                {busy ? "Moving…" : "Move to trash"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
function ProjectCard({
  project,
  capabilities,
  onOpen,
  menuOpen,
  onMenu,
  onDelete,
  onEditor,
}: {
  project: Project;
  capabilities: Capabilities | null;
  onOpen: () => void;
  menuOpen: boolean;
  onMenu: () => void;
  onDelete: () => void;
  onEditor: () => void;
}) {
  const [covers, setCovers] = useState<Asset[]>([]);
  useEffect(() => {
    let live = true;
    const ids = project.scenes
      .filter((s) => s.image_id)
      .slice(0, 4)
      .map((s) => s.image_id);
    if (ids.length)
      api
        .assets(project.id)
        .then((a) => {
          if (live)
            setCovers(
              ids
                .map((id) => a.find((x) => x.id === id))
                .filter((a): a is Asset => !!a),
            );
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [project.id, project.updated_at]);
  const ready = project.scenes.filter((s) => s.image_id || s.video_id).length,
    voices = project.scenes.filter((s) => s.voice_id).length;
  const style =
    capabilities?.styles.find((s) => s.id === project.style)?.name ??
    project.style;
  return (
    <article className="project-card">
      <button
        className={"project-cover " + (covers.length ? "has-cover" : "")}
        onClick={onOpen}
        aria-label={"Open " + project.name}
      >
        {covers.length ? (
          <div className={"cover-collage collage-" + covers.length}>
            {covers.map((a, i) => (
              <img key={a.id + "-" + i} src={a.url} alt="" />
            ))}
          </div>
        ) : (
          <div className="project-cover-empty">
            <span>✦</span>
            <i />
            <b />
          </div>
        )}
      </button>
      <div className="project-card-body">
        <div className="project-card-title">
          <button onClick={onOpen}>{project.name}</button>
          <button
            className="icon-button"
            aria-label={"Options for " + project.name}
            aria-expanded={menuOpen}
            onClick={onMenu}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="dropdown-menu">
              <button onClick={onOpen}>Open Spark Guide</button>
              <button onClick={onEditor}>Open editor</button>
              <button className="destructive" onClick={onDelete}>
                Move to trash
              </button>
            </div>
          )}
        </div>
        <time className="project-created" dateTime={project.created_at}>
          {new Date(project.created_at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </time>
        <div className="project-card-tags">
          <span>{project.ratio}</span>
          <span title={style}>{style}</span>
          <button onClick={onOpen}>✦ Guide</button>
        </div>
        <div className="project-card-bottom">
          <div className="scene-readiness">
            <span title={ready + " scenes with visuals"}>
              ▧ <b>{ready}</b>
            </span>
            <span title={voices + " scenes with narration"}>
              ♫ <b>{voices}</b>
            </span>
            <span title={project.characters.length + " characters"}>
              ♙ <b>{project.characters.length}</b>
            </span>
          </div>
          <button onClick={onEditor}>
            {project.scenes.length}{" "}
            {project.scenes.length === 1 ? "scene" : "scenes"} <span>↗</span>
          </button>
        </div>
      </div>
    </article>
  );
}
