# Multi-HF — Batch Studio

A dependency-free, local-first web workbench for Hugging Face Spaces using Gradio. It discovers a Space's `/config`, builds a dynamic form from the discovered endpoint schema, saves reusable profiles, and runs a persistent queue with clear failure handling.

## Features

- Add a Space by `owner/name` or URL and discover its Gradio endpoints from `/config`.
- Open each Space's original hosted interface inside Multi-HF. Different Spaces keep their own native controls and layout; use the standalone link when a Space disables embedding.
- Render text, number, slider, checkbox, choice, and file inputs from the live schema.
- Store profiles and jobs in browser storage; export/import the workspace as JSON. Profiles store API parameter values; the embedded native UI runs independently and does not share form state with the queue.
- Connect Hugging Face tokens for the current browser session. Tokens are held in memory only and are not included in exports or persisted storage. A token is only sent to `huggingface.co`, and to a `*.hf.space` host only when the Hub reports that Space as private; public Spaces never receive it.
- Run queued generation jobs, show returned image/video/audio/file outputs, and download results.
- Classify auth, waking, transient, quota, policy, and fatal failures. Quota failures pause that job and do not invent a reset time or automatically rotate accounts to work around limits.
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

- Workspace records are stored in this browser's `localStorage`; clear browser data to remove them. Never use a shared browser for private prompts or personal data.
- Access tokens are session-only. On refresh, reconnect the account. The app does not send tokens to a backend.
- Gradio Space CORS settings, private-space permissions, and endpoint changes may prevent a Space from being reached from the browser.
- Queue execution depends on the target Space's currently exposed API and its own resource/quota policies. A quota failure leaves the job paused for a manual retry or resource/account selection; the app never guesses quota reset timing.
- The Android APK is a WebView wrapper around the shared web UI, not a fully native Compose UI. Generation requests remain foreground browser requests; they are not scheduled as a native background WorkManager task. Android APK assembly requires an Android SDK and Gradle. Browser tokens remain session-only and workspace content uses localStorage.
