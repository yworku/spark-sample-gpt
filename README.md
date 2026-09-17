# Spark Studio

A fresh, private creative studio built from the observed Toonbee project, guided creation, and video editing workflows. All application code is new. Branding and generated style illustrations belong to this implementation; no reference-account projects or media are bundled.

The frontend uses **React, TypeScript, and Vite**. The backend uses **FastAPI, SQLAlchemy, and PostgreSQL**, with a separate durable job worker and **FFmpeg** for MP4 composition. Video is the first workspace; project documents, media, and jobs provide extension points for future music and book project types. Those types are not enabled yet.

## Start locally

Install [Docker with Compose](https://docs.docker.com/compose/install/) and [uv](https://docs.astral.sh/uv/getting-started/installation/). From this directory:

```bash
uv sync --locked
uv run python scripts/configure.py
docker compose up --build -d
```

Open **http://localhost:8000** and use the studio password you chose. The configuration command generates a fresh database password and an Argon2 password hash without printing either secret. It refuses to overwrite an existing `.env`.

PostgreSQL and private media persist in separate Docker volumes. The `migrate` service initializes only an empty database or verifies the existing v1 schema. It refuses an unversioned, nonempty database or an unsupported version. The API and worker start after initialization succeeds.

```bash
docker compose logs -f api worker
docker compose stop
docker compose start
```

## Make a first video

1. Create a project through Spark Guide or the manual studio.
2. Paste a script with blank lines between scenes, or request an AI story from an idea.
3. Review scenes and characters. Upload or generate media, then select the versions to use.
4. Open the editor to arrange scenes, adjust timing, add captions and layers, and choose a soundtrack.
5. Choose **Export**, then download the completed private MP4 from its history.

Upload-based editing and MP4 export work without any generation provider. A scene with no visual renders a black canvas, so text-only compositions work too. Browser preview and exports share a 30 fps timeline; exports capture the saved revision when queued, so later editing does not alter an in-progress export.

## Connect generation

Add the provider keys you want to your private `.env`, then run `docker compose up -d --force-recreate api worker`.

| Variable | Enables |
| --- | --- |
| `OPENAI_API_KEY` | Structured stories, images and image edits, narration, explicit caption alignment |
| `RUNWAY_API_KEY` | Image-to-video generation |
| `ELEVENLABS_API_KEY` | Instrumental background music generation |

Requests start from explicit generation buttons. Results remain alternatives until selected or applied. No automatic paid generation runs during project creation, ordinary editing, or export. Providers charge their own accounts; this application does not simulate credits or subscriptions.

Model defaults are `gpt-4.1-mini`, `gpt-image-1`, `gpt-4o-mini-tts`, Runway `gen4.5`, and ElevenLabs `music_v1`. Caption alignment uses `whisper-1` word timestamps. See `.env.example` and `backend/studio/config.py` for overrides. Reference images are included in supported image requests, but a model cannot guarantee identical characters across generations.

Live provider calls must be verified using your configured accounts. Automated tests mock the paid HTTP services; they exercise request formats and error handling without spending credits.

### Interrupted requests

The browser preserves a request identity after an uncertain response. The worker records submission before contacting a paid provider and does not automatically repeat ambiguous submissions. Such jobs display `unknown` rather than a false success or a blind retry.

A Runway job with a stored task ID can resume polling without creating a new paid task:

```bash
docker compose exec worker python -m studio.worker --reconcile JOB_ID
```

Use the job ID returned by the projects/jobs API. The default exact Runway download host is `dnznrvs05pmza.cloudfront.net`, matching the provider's [output documentation](https://docs.dev.runwayml.com/assets/outputs/). If the provider changes its CDN, set the operator-controlled `STUDIO_RUNWAY_OUTPUT_HOSTS` comma-separated allowlist to its verified output hosts before reconciling. Private-network URLs and redirects are rejected.

## Develop

Use Python 3.12 or 3.13, Node.js 24, PostgreSQL, FFmpeg/ffprobe, Linux `prlimit`, and DejaVu fonts. The container installs the rendering dependencies; direct development on Linux needs them too.

```bash
uv sync --locked
uv run python scripts/configure.py
docker compose -f compose.yaml -f compose.dev.yaml up -d db
uv run --env-file .env python -m studio.db init
uv run --env-file .env uvicorn studio.api:app --host 127.0.0.1 --port 8000
```

In two additional terminals:

```bash
uv run --env-file .env python -m studio.worker
```

```bash
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173. Vite forwards `/api` to the Python server. To serve the production frontend through FastAPI, run `npm run build` in `frontend`; the generated `.env` already points `STUDIO_FRONTEND_DIST` to that output.

## Verify

```bash
uv run ruff check backend tests scripts
uv run pytest -q
cd frontend
npm ci
npm test
npm run build
```

Tests cover private downloads, project revision conflicts, library imports, rejected uploads, job identity and cancellation, worker recovery, and real FFmpeg rendering. The export integration test follows HTTP admission through the worker to a downloadable MP4 and checks that an exported revision stays fixed while the project changes.

Set `TEST_POSTGRES_URL` to a dedicated disposable PostgreSQL database to run the multiworker locking tests; otherwise those tests are explicitly skipped. Never point test configuration at a working studio database. CI provisions its own PostgreSQL service.

Browser tests, when installed, run with `npm run test:e2e`. They use a disposable local fixture server and no paid providers. They are separate from the unit tests and production build.

## Serve privately over HTTPS

The Compose port binds to the host's loopback address. Put your HTTPS reverse proxy in front of port 8000, set `STUDIO_ALLOWED_ORIGINS` to the exact public origin, and set `STUDIO_SECURE_COOKIES=true`. Use a request-size limit at the proxy as well as the API's streamed-body limit. The application currently provides a single owner workspace, not multiuser billing or collaboration.

Assets and exports are outside the frontend directory and require an authenticated owner session. Back up both the PostgreSQL database and the media volume together. Keep `.env`, generated media, and database backups out of source control.

The functional comparison and remaining verification limits are recorded in `docs/REFERENCE_PARITY.md`. A broader architecture design can follow review of the implemented workflows.
