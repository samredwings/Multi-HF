# Multi-HF — Batch Studio

A dependency-free, local-first web workbench for Hugging Face Spaces using Gradio. It discovers a Space's `/config`, builds a dynamic form from the discovered endpoint schema, saves reusable profiles, and runs a persistent queue with clear failure handling.

## Features

- Add a Space by `owner/name` or URL and discover its Gradio endpoints from `/config`.
- Detect the Space SDK from Hub metadata and its Gradio runtime version from config / Hub metadata. Gradio Spaces load the matching official `gradio-app` web component so the author's own controls, layout, and interactions are preserved; Streamlit, Docker, and static/custom Spaces open their hosted UI in an iframe. If version detection or component loading fails, fall back to the hosted iframe or standalone page.
- Build API-backed job forms from each Gradio Space endpoint schema, including prompt/settings controls, source images, image galleries/reference sets, video/audio, and multiple-file inputs. Non-Gradio Spaces remain hosted UI-only when no Gradio API is exposed; the embedded hosted UI cannot share its cross-origin form state with the Multi-HF queue.
- Store job metadata in localStorage and uploaded source/reference files in IndexedDB, so queued attachments survive reloads. Reusable profiles store non-file parameter values; job clones can reuse their saved attachments.
- Connect Hugging Face tokens for the current browser session. Tokens are held in memory only and are not included in exports or persisted storage. Tokens go to `huggingface.co` and private Spaces; public Spaces receive a token only after the user explicitly enables the per-Space Token: sent option and confirms that the owner can see it.
- Stage multiple jobs (or repeat a run up to 10 times), group pending work by Space and account, upload all attachments before inference starts, then submit prepared requests concurrently to the Space's own Gradio queue and monitor returned event IDs independently; the Space's server-side queue controls actual GPU execution. Submitted events can be resumed after a page reload without resubmitting them.
- Show live ZeroGPU GPU-seconds when the connected token has billing-usage read permission. The Free-account ZeroGPU allowance is 5 minutes of GPU time per day; unauthenticated use is 2 minutes. It is account-wide across ZeroGPU Spaces and resets 24 hours after first use. The personal account allowance applies only when the Space receives the token; for public Spaces this requires the explicit per-Space Token: sent opt-in. The queue checks known authenticated ZeroGPU Spaces before new submissions, pauses new work when no allowance remains, and still allows already-submitted events to be resumed. It does not guess quota reset timing or rotate accounts.
- Waking and transient failures retry automatically up to twice on the same Space and account (with backoff); after that the job pauses. Requests time out after 15 minutes, and a running job can be cancelled.
- Workspace import is validated: hosts must be `https://*.hf.space`, results must be `https`/`data:` media, and imported jobs left running are paused.
- Static build with Node.js only. GitHub Actions runs the same build and test commands.

## Run locally

Requires Node.js 20.11 or newer; no `npm install` is needed. This repo also includes an Android APK shell that hosts the same interface in a WebView; the interface logic is shared with the PWA.

```sh
npm run check
npm test
npm run build
npm run preview
```

`npm run preview` serves `dist/` at `http://localhost:4173` after you build. Use `npm run build:android-assets` to build the web app and copy it into the Android app assets. Then run `gradle assembleDebug` inside `android/` with Android SDK and Gradle installed. GitHub Actions builds the debug APK and uploads it as an artifact.

## Security and limits

- Workspace records are stored in this browser's localStorage; source/reference file attachments are stored in IndexedDB on the same origin. They survive reloads, but binary attachments are not included in JSON workspace exports. Keep using the same browser/site storage for queued media, or reattach files after importing elsewhere. Clear this site's browser data to remove them. Never use a shared browser for private prompts or personal data.
- Access tokens are session-only. On refresh, reconnect the account. The app does not send tokens to a backend. Workspace imports reset private-Space and public Token: sent trust flags; rediscover private Spaces and explicitly re-enable token sending for public Spaces only when trusted.
- Gradio Space CORS settings, private-space permissions, browser WebView support, and endpoint changes may prevent a Space from being reached from the browser. The native `gradio-app` component requires a detected Gradio version. Only one Gradio web-component version can be active in a browser session; if a different version is already loaded, Multi-HF uses the iframe fallback. The iframe and standalone links are fallbacks, not a guarantee that every Space permits embedding.
- Queue execution depends on the target Space's currently exposed API, server-side Gradio queue, and resource/quota policies. ZeroGPU allowance is measured in GPU-seconds, not elapsed wall-clock time. The quota panel requires a fine-grained token with Billing → Read billing usage and payment method status permission; inability to read quota does not block normal API jobs. Uploads are prepared before generation calls, but generation still consumes the Space/account's own quota. Legacy Gradio run endpoints are synchronous and cannot use the fast event-ID batching path.
- The Android APK is a WebView wrapper around the shared web UI, not a fully native Compose UI. Generation requests remain foreground browser requests; they are not scheduled as a native background WorkManager task. Android APK assembly requires an Android SDK and Gradle. Browser tokens remain session-only and workspace content uses localStorage.
