# Functional comparison

Reference: authenticated, read-only inspection of [app.toonbee.ai](https://app.toonbee.ai/) in September 2026. This implementation reproduces the observed creative workflow with Spark branding and new code. It does not claim access to Toonbee's source code or internal architecture.

| Observed workflow | Spark Studio implementation |
| --- | --- |
| Project dashboard | Warm neutral layout, orange controls, media collage cards, search, saved dates, project options, trash and restore |
| Guided or manual creation | Mode chooser, guided setup, manual blank editor |
| Story setup | Idea/pasted script, language, three aspect ratios, 26 visual style prompts |
| Story generation | Explicit background request; structured scenes and recurring characters; candidate reviewed before replacing content |
| Script review | Editable scene scripts and image directions, scene addition/removal, character descriptions |
| Recurring characters | Generated/uploaded references, scene assignments, retained alternatives, private cross-project character library |
| Scene images | Generation, selected-image editing, uploads, versions, character reference conditioning |
| Narration | Voice selection, generated/uploaded takes, trimming, playback speed, volume, start offset and looping |
| Music | Generation, upload, private music library, selection, trim, loop, fades and narration ducking |
| Scene video | Runway generation from a selected image, uploaded clips, versions, trim/speed/volume, loop or end-frame/image behavior |
| Timeline editing | Scene selection, rearrangement, add/duplicate/remove, undo, total timing and playback |
| Captions | Fonts, color/background, style, position, explicit narration alignment, editable/hidden timed words |
| Layers | Positioned text and private-image overlays with timing and opacity |
| Image effects | Zoom, four pan directions, Ken Burns, drift, pulse, rotate, tilt and bounce |
| Transitions | Cut, fade/crossfade, dissolve, four slide directions, four wipe directions and zoom |
| Export | Real private H.264/AAC MP4 at 720/1080/1440, 30 fps, quality choice, history, download and deletion |
| Background production | Saved progress and errors, bounded explicit batches, cancellation, immutable input revisions, recoverable task identity and retained alternatives |
| Project navigation | Deep links and refresh, browser history, protected unsaved edits and revision conflicts |

## Deliberate product differences

- Spark uses its own brand and original artwork. Four style illustrations are supplied; other style cards use abstract artwork. The 26 prompt presets are functional.
- Models, available voices, and generated results depend on the configured OpenAI, Runway and ElevenLabs accounts. They are not represented as identical to Toonbee's undisclosed choices.
- Private library entries are your own projects' assets and characters. No third-party music catalog, stock media catalog, subscription billing or credit storefront is copied.
- Image motion is deterministic 2D motion. This does not recreate proprietary depth-estimation or parallax algorithms.
- This is a single-owner private workspace. Collaboration, subscription plans and public sharing are outside this build.
- Video is implemented. Music and books are future project types, not inactive controls pretending to work.

## Verification and remaining gates

The source includes Python API/worker/render tests, frontend request-identity/timeline tests, and a Playwright browser workflow for CI. Real renderer tests produce and inspect local video/audio, including a complete HTTP-to-worker-to-private-download flow. Provider tests use mocked HTTP responses and do not incur charges.

The production frontend has been type-checked and built. Live paid generation has **not** been run with your accounts. Local PostgreSQL concurrency tests require a disposable PostgreSQL service and are skipped when it is absent; CI provisions one. The Docker configuration is supplied, but Docker is unavailable in the authoring environment.

The browser available for reference inspection cannot open this workspace's local server. Accordingly, the new UI has **not** received a deployed screenshot comparison or executed browser acceptance test in this environment. An exact pixel-for-pixel clone is not a verified claim.

Historical archive note: the original `yworku/spark-studio` connection returned GitHub 404 during implementation. This source has now been imported into the separate `yworku/spark-sample-gpt` repository for independent evaluation; the original repository is not part of this import.

The next review should run the included browser checks on the deployed build, compare the dashboard/creator/editor against the reference, exercise one request with each configured provider, and then use the confirmed behavior to write the broader architecture plan.
