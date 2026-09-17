import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Capabilities, Project } from "./types";
import Dashboard from "./Dashboard";
import Creator from "./Creator";
import Guide from "./Guide";
import Editor from "./Editor";
import "./styles.css";

type View = "projects" | "guide" | "tutorials" | "production" | "editor";
function locationRoute(): { view: View; id?: string } {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if ((parts[0] === "guide" || parts[0] === "editor") && parts[1])
    return {
      view: parts[0] === "editor" ? "editor" : "production",
      id: parts[1],
    };
  return {
    view:
      parts[0] === "guide"
        ? "guide"
        : parts[0] === "learn"
          ? "tutorials"
          : "projects",
  };
}
function viewPath(view: View, id?: string) {
  return view === "production"
    ? "/guide/" + id
    : view === "editor"
      ? "/editor/" + id
      : view === "tutorials"
        ? "/learn"
        : view === "guide"
          ? "/guide"
          : "/projects";
}
export default function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null),
    [projects, setProjects] = useState<Project[]>([]),
    [view, setView] = useState<View>("projects"),
    [project, setProject] = useState<Project | null>(null),
    [create, setCreate] = useState(false),
    [initialPrompt, setInitialPrompt] = useState(""),
    [initialStage, setInitialStage] = useState(0);
  const lastPath = useRef(window.location.pathname);
  function navigate(next: View, id?: string) {
    const path = viewPath(next, id);
    if (path !== window.location.pathname)
      window.history.pushState({}, "", path);
    lastPath.current = path;
    setView(next);
  }
  const updateProject = (p: Project) => {
    setProject(p);
    setProjects((list) =>
      list.some((x) => x.id === p.id)
        ? list.map((x) => (x.id === p.id ? p : x))
        : [p, ...list],
    );
  };
  async function refresh() {
    try {
      const [c, p, deleted] = await Promise.all([
        api.capabilities(),
        api.projects(),
        api.projects(true),
      ]);
      setCapabilities(c);
      setProjects([...p, ...deleted]);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    api
      .session()
      .then((s) => setAuth(s.authenticated))
      .catch((e) => {
        setError(e.message);
        setAuth(false);
      });
  }, []);
  useEffect(() => {
    if (!auth) return;
    void refresh();
    let live = true;
    async function syncLocation() {
      const requestedPath = window.location.pathname;
      const route = locationRoute();
      if (route.id) {
        setBusy(true);
        try {
          const p = await api.project(route.id);
          if (live && window.location.pathname === requestedPath) {
            setProject(p);
            setInitialStage(p.scenes.length ? 1 : 0);
            setInitialPrompt("");
            setView(route.view);
          }
        } catch (e) {
          if (live && window.location.pathname === requestedPath) {
            setError((e as Error).message);
            navigate("projects");
          }
        } finally {
          if (live) setBusy(false);
        }
      } else setView(route.view);
      lastPath.current = window.location.pathname;
    }
    function pop() {
      const event = new Event("spark-before-navigate", { cancelable: true });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        window.history.pushState({}, "", lastPath.current);
        return;
      }
      void syncLocation();
    }
    void syncLocation();
    window.addEventListener("popstate", pop);
    return () => {
      live = false;
      window.removeEventListener("popstate", pop);
    };
  }, [auth]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      setPassword("");
      setAuth(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(p: Project, editor = false) {
    setBusy(true);
    setError("");
    try {
      const fresh = await api.project(p.id);
      setProject(fresh);
      setInitialPrompt("");
      setInitialStage(fresh.scenes.length ? 1 : 0);
      navigate(editor ? "editor" : "production", fresh.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (auth === null)
    return (
      <div className="boot-screen">
        <span className="brand-mark">✦</span>
        <p>Opening your studio…</p>
      </div>
    );
  if (!auth)
    return (
      <main className="login-page">
        <div className="login-art">
          <div className="login-orbit orbit-one" />
          <div className="login-orbit orbit-two" />
          <div className="login-art-copy">
            <span className="eyebrow">A LITTLE IDEA. A WHOLE NEW WORLD.</span>
            <h1>
              Your imagination,
              <br />
              in motion.
            </h1>
            <p>Bring your stories to life, one scene at a time.</p>
            <div className="login-illustration">
              <span>✦</span>
              <i />
              <b />
            </div>
          </div>
        </div>
        <div className="login-panel">
          <form onSubmit={login} className="login-form">
            <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
              <span className="brand-mark">✦</span>
              <span>
                spark<span className="brand-light">studio</span>
              </span>
            </a>
            <h2>Welcome to your studio</h2>
            <p className="muted">
              Sign in to start creating something wonderful.
            </p>
            <label>
              Studio password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus
                placeholder="Enter your password"
              />
            </label>
            {error && (
              <div role="alert" className="error-banner">
                {error}
              </div>
            )}
            <button className="button primary wide" disabled={busy}>
              {busy ? "Signing in…" : "Enter studio →"}
            </button>
            <p className="login-note">
              Your projects and media stay in your private workspace.
            </p>
          </form>
        </div>
      </main>
    );
  if (view === "editor" && project && capabilities)
    return (
      <Editor
        key={project.id}
        project={project}
        capabilities={capabilities}
        onProject={updateProject}
        onBack={() => {
          navigate("production", project.id);
          setInitialStage(5);
        }}
      />
    );
  if (view === "production" && project && capabilities)
    return (
      <Guide
        key={project.id}
        project={project}
        capabilities={capabilities}
        initialStage={initialStage}
        initialPrompt={initialPrompt}
        onBack={() => {
          navigate("projects");
          void refresh();
        }}
        onProject={updateProject}
        onEditor={(p) => {
          updateProject(p);
          navigate("editor", p.id);
        }}
      />
    );
  return (
    <div className="studio-app">
      <header className="site-header">
        <button
          className="brand bare"
          onClick={() => navigate("projects")}
          aria-label="Spark Studio home"
        >
          <span className="brand-mark">✦</span>
          <span>
            spark<span className="brand-light">studio</span>
          </span>
        </button>
        <nav className="pill-navigation" aria-label="Main navigation">
          {(["projects", "guide", "tutorials"] as const).map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => navigate(v)}
            >
              <span>{v === "projects" ? "▦" : v === "guide" ? "✧" : "▷"}</span>
              {v === "projects"
                ? "Projects"
                : v === "guide"
                  ? "Spark Guide"
                  : "Tutorials & Help"}
            </button>
          ))}
        </nav>
        <div className="header-account">
          <span className="private-pill">
            <i />
            Private workspace
          </span>
          <button
            className="avatar-button"
            title="Sign out"
            aria-label="Sign out"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.logout();
                setAuth(false);
                setProjects([]);
                setProject(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            S
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className="error-banner page-error">
          {error}
          <button className="text-button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
      {view === "projects" ? (
        <Dashboard
          projects={projects}
          capabilities={capabilities}
          loading={busy || !capabilities}
          onCreate={() => setCreate(true)}
          onOpen={open}
          onRefresh={refresh}
        />
      ) : (
        <ResourcePage
          type={view === "guide" ? "guide" : "tutorials"}
          onCreate={() => setCreate(true)}
        />
      )}
      <footer className="site-footer">
        <span>✦ Spark Studio</span>
        <span>Made for your imagination.</span>
      </footer>
      {create && capabilities && (
        <Creator
          capabilities={capabilities}
          onClose={() => setCreate(false)}
          onCreated={(p, prompt, stage, editor) => {
            updateProject(p);
            setInitialPrompt(prompt);
            setInitialStage(stage);
            setCreate(false);
            navigate(editor ? "editor" : "production", p.id);
          }}
        />
      )}
    </div>
  );
}
function ResourcePage({
  type,
  onCreate,
}: {
  type: "guide" | "tutorials";
  onCreate: () => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(0);
  const lessons = [
    [
      "Start with your story",
      "Choose an idea, paste an existing script, or start with a blank scene. Pasted paragraphs become scenes without a model request. AI story generation is a separate action in your project.",
    ],
    [
      "Build a cast and visual style",
      "Choose a project style and add descriptions and reference images for your characters. Review the cast before preparing images. Your retained alternatives remain available when you change a selection.",
    ],
    [
      "Give every scene a voice",
      "Upload narration or generate it using a configured voice provider. Choose the take you want for each scene. Upload a soundtrack and adjust its volume in the editor.",
    ],
    [
      "Make it yours in the editor",
      "Adjust timing, trim clips, add text layers, edit captions, and arrange scenes. Preview the composition, then create a private MP4 export. The export uses your selected media.",
    ],
  ];
  return (
    <main className="dashboard resource-page">
      <span className="eyebrow">THE CREATIVE POSSIBILITIES START HERE</span>
      <h1>
        {type === "guide"
          ? "From a spark to a story."
          : "A little help. A lot of possibility."}
      </h1>
      <p className="page-subtitle">
        {type === "guide"
          ? "A simple path from your first idea to your finished video."
          : "Practical walkthroughs for your next creation."}
      </p>
      <div className="resource-layout">
        <section className="lesson-list">
          {lessons.map(([title, body], i) => (
            <article
              className={"lesson-card " + (expanded === i ? "expanded" : "")}
              key={title}
            >
              <button
                onClick={() => setExpanded(expanded === i ? null : i)}
                aria-expanded={expanded === i}
              >
                <span className={"step-badge tone-" + i}>{i + 1}</span>
                <h2>{title}</h2>
                <span>{expanded === i ? "−" : "+"}</span>
              </button>
              {expanded === i && <p>{body}</p>}
            </article>
          ))}
        </section>
        <aside className="resource-aside">
          <div className="big-spark">✦</div>
          <h2>
            Your next story
            <br />
            starts with an idea.
          </h2>
          <p>
            Choose a style, build your scenes, and make something that feels
            like you.
          </p>
          <button className="button primary" onClick={onCreate}>
            Create a project <span>→</span>
          </button>
        </aside>
      </div>
    </main>
  );
}
