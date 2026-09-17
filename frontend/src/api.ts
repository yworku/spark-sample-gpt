import type {
  Asset,
  AssetKind,
  Capabilities,
  Job,
  Project,
  ProjectDocument,
  Ratio,
  VideoExport,
} from "./types";

export interface LibraryCharacter {
  id: string;
  source_project_id: string;
  source_character_id: string;
  project_name: string;
  name: string;
  description: string;
  asset: Asset | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail =
      typeof body?.detail === "string"
        ? body.detail
        : typeof body?.message === "string"
          ? body.message
          : "The request could not be completed.";
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

type JobInput = {
  kind: string;
  base_revision: number;
  scene_id?: string;
  character_id?: string;
  prompt?: string;
  settings?: Record<string, unknown>;
  idempotency_key?: string;
};
const pendingKeys = new Map<string, string>();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
async function submitJob(id: string, input: JobInput): Promise<Job> {
  // Retain one key after an ambiguous network failure, including across a reload.
  // Acknowledged requests clear it, so a deliberate new take gets a new version.
  const bytes = new TextEncoder().encode(canonical({ id, ...input }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const storageKey =
    "spark:pending:" +
    Array.from(new Uint8Array(digest), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
  let key = input.idempotency_key ?? pendingKeys.get(storageKey);
  if (!key) {
    try {
      key = sessionStorage.getItem(storageKey) ?? undefined;
    } catch {
      throw new Error(
        "Enable session storage in your browser before submitting a generation or export.",
      );
    }
  }
  key ??= crypto.randomUUID();
  pendingKeys.set(storageKey, key);
  try {
    sessionStorage.setItem(storageKey, key);
  } catch {
    throw new Error(
      "The request was not sent because its recovery key could not be saved. Enable browser session storage and try again.",
    );
  }
  const clear = () => {
    pendingKeys.delete(storageKey);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* unavailable */
    }
  };
  const job = await request<Job>(`/projects/${id}/jobs`, {
    method: "POST",
    body: JSON.stringify({ ...input, idempotency_key: key }),
  });
  clear();
  return job;
}

export const api = {
  session: () => request<{ authenticated: boolean }>("/session"),
  login: (password: string) =>
    request("/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request("/logout", { method: "POST" }),
  capabilities: () => request<Capabilities>("/capabilities"),
  projects: (deleted = false) =>
    request<Project[]>(deleted ? "/projects?deleted=true" : "/projects"),
  project: (id: string) => request<Project>(`/projects/${id}`),
  createProject: (input: {
    name: string;
    kind: "video";
    ratio: Ratio;
    style: string;
    language: string;
    script?: string;
    scene_count?: number;
    mode: "blank" | "paste";
  }) =>
    request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  saveProject: (id: string, base_revision: number, document: ProjectDocument) =>
    request<Project>(`/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify({ base_revision, document }),
    }),
  deleteProject: (id: string) =>
    request(`/projects/${id}`, { method: "DELETE" }),
  restoreProject: (id: string) =>
    request<Project>(`/projects/${id}/restore`, { method: "POST" }),
  assets: (id: string) => request<Asset[]>(`/projects/${id}/assets`),
  libraryAssets: (kind: AssetKind) =>
    request<Asset[]>(`/library/assets?kind=${kind}`),
  importAsset: (
    id: string,
    input: {
      source_asset_id: string;
      scene_id?: string;
      character_id?: string;
    },
  ) =>
    request<Asset>(`/projects/${id}/assets/import`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  libraryCharacters: () => request<LibraryCharacter[]>("/library/characters"),
  importCharacter: (
    id: string,
    input: {
      source_project_id: string;
      source_character_id: string;
      base_revision: number;
    },
  ) =>
    request<Project>(`/projects/${id}/characters/import`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  upload: (
    id: string,
    file: File,
    kind: AssetKind,
    scene_id?: string,
    character_id?: string,
  ) => {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    if (scene_id) form.append("scene_id", scene_id);
    if (character_id) form.append("character_id", character_id);
    return request<Asset>(`/projects/${id}/assets`, {
      method: "POST",
      body: form,
    });
  },
  jobs: (id: string) => request<Job[]>(`/projects/${id}/jobs`),
  job: submitJob,
  cancelJob: (id: string) =>
    request<Job>(`/jobs/${id}/cancel`, { method: "POST" }),
  exports: (id: string) => request<VideoExport[]>(`/projects/${id}/exports`),
  deleteExport: (id: string) => request(`/exports/${id}`, { method: "DELETE" }),
};
