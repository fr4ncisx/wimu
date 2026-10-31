<div align="center">

<p><img src="logo.png" alt="WIMU" width="320"/></p>

<p><img src="wordmark.png" alt="Where Is My Usage" width="240" /></p>

</div>

<div align="center">

**See your Codex usage limits at a glance**
A compact Windows panel for Codex CLI's five-hour and weekly usage windows.
<br>

[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)](https://www.microsoft.com/windows) [![Stack: Rust and Tauri](https://img.shields.io/badge/stack-Rust%20%2B%20Tauri-DEA584?style=flat-square)](https://v2.tauri.app/) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)

</div>

---

## Contents

- [Contents](#contents)
- [Features](#features)
- [Requirements](#requirements)
- [Run and build](#run-and-build)
- [How updates work](#how-updates-work)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Releases](#releases)
- [Feedback](#feedback)
- [Disclaimer](#disclaimer)

---

## Features

- Remaining usage and reset times for the five-hour and weekly windows.
- Independent warning thresholds, starting at 20%. Bars turn orange five percentage points above each threshold, then red at the threshold, intensifying toward zero. Tiny bubbles appear in the red zone and respect reduced motion.
- English by default, with Spanish available in Settings.
- Optional sound alerts, off by default, for usage-window resets and threshold crossings. The header bell saves this preference. The bundled [New Notification 017](https://pixabay.com/es/sound-effects/pel%C3%ADculas-y-efectos-especiales-new-notification-017-352293/) by Universfield plays on resets; [low_battery](https://pixabay.com/es/sound-effects/pel%C3%ADculas-y-efectos-especiales-low-battery-329310/) by u_edtmwfwu7c plays when remaining usage crosses its threshold. Both are included under Pixabay's [Content License](https://pixabay.com/service/license-summary/).
- Remembers the panel's screen position and normal and ultra-compact widths; panel heights stay fixed and Settings fits its visible content. A first launch opens centered.
- Two tray indicators show `5H` or `7D` above a bold, color-matched percentage enlarged to use the icon area; clicking either restores the full window. Tooltips show remaining usage and reset times.
- Drag the panel from its name or open header space, including in ultra-compact mode.
- Remembered close behavior and an always-on-top option in Settings. When minimized, decorative meter animations pause and the panel stops repainting; usage updates and tray indicators remain active.
- One running instance; launching it again restores the open panel.

---

## Requirements

### To run

- Windows 10+ with WebView2 Runtime.
- Codex CLI compatible with WIMU's `app-server` protocol, discoverable on `PATH` or in its standard npm installation under `%APPDATA%`. Verified with Codex CLI `0.162.1` and `0.166.0`.
- Codex CLI already signed in under the same Windows account.

### To build

- Windows 10+.
- Rust with the `x86_64-pc-windows-msvc` target and Microsoft C++ Build Tools with the **Desktop development with C++** workload.
- Tauri CLI `2.12.2` to build the executable.

See the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/) for platform setup. Node.js is not required to build the app.

### To run UI tests

- Node.js 24.
- Chromium managed by Playwright. Install it once with `npm run install-browsers`.

---

## Run and build

Clone the repository and run from source:

```powershell
git clone https://github.com/fr4ncisx/codex-mystats.git
Set-Location codex-mystats
cargo run
```

Build a standalone executable without an installer:

```powershell
cargo install tauri-cli --version "=2.12.2" --locked
cargo tauri build --no-bundle
```

The executable is written to `target\release\wimu.exe`.

Run the frontend UI checks with Node.js 24 and Playwright:

```powershell
npm ci
npm run install-browsers
npm test
```

`npm test` runs the checks in the console. Run `npm run test-ui` to open Playwright's interactive test runner.

These tools are only needed for frontend UI tests; they are not required to build the app.

---

## How updates work

WIMU reads limits from Codex CLI over local standard input and output and validates the `app-server` protocol instead of requiring an exact CLI version. It applies limit-change events as they arrive, coalesces concurrent read requests, and reconciles the values every 15 seconds while connected. If a connection is lost, the panel marks the data stale and reconnects with exponential backoff that resets only after a verified successful read. Event delivery has no documented maximum latency.

The app identifies the five-hour and weekly windows from their durations, giving precedence to the primary `codex` bucket when duplicate durations occur, respects ordinary usage permission so that active quota is never prematurely reported as exhausted, and uses the percentage and reset time returned by Codex. Tray indicators preserve non-zero remaining values so that 0% strictly represents complete quota exhaustion. It preserves the source percentage precision and does not estimate a missing window. If Codex CLI is missing, install it and restart WIMU.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| Codex CLI is not found | Add `codex.exe` to `PATH` or install the Codex CLI npm package, then restart the app. |
| WIMU cannot read the Codex CLI protocol | Update WIMU and/or Codex CLI, then restart the app. |
| No usage is available | Sign in through Codex CLI under the same Windows account, then restart the app. |
| Data is stale | Restore Codex CLI availability; the app reconnects when the connection returns. |
| A usage window is unavailable | Check that Codex returned that period. The app does not estimate missing data. |
| Settings file is corrupt | WIMU backs up the damaged file to `settings.json.corrupt` and restores safe defaults automatically. |
| Startup or connection issues | Inspect diagnostic messages on standard error (`[WIMU] ...`); child process stderr is captured and sensitive tokens are automatically redacted. |
| `cargo tauri` is not recognized | Install the pinned Tauri CLI command above, then reopen PowerShell. |

---

## Security

Usage is not fetched anonymously: the app relies on the existing authenticated Codex CLI session for the same Windows account. Codex CLI handles its normal communication with Codex and returns usage data to the app over local standard input and output.

WIMU does not prompt for, copy, or store passwords or tokens. Its local `settings.json` stores app preferences only. The app opens no network listener and adds no telemetry of its own. The interface uses local files and narrowly scoped Tauri permissions.

---

## Releases

CI validates version metadata, Rust formatting and tests, JavaScript syntax, Playwright UI tests, and the Windows build on pull requests and pushes to `main`. The release workflow enforces the same test suite before drafting release assets and supports manual dry-run runs via `workflow_dispatch`. CI and release builds cache Tauri CLI `2.12.2`, Cargo dependencies, and Rust build outputs; CI also caches npm downloads. The first successful run populates the caches.

After CI passes for the intended commit, push an annotated version tag that matches `Cargo.toml` and `tauri.conf.json` to start the Windows release workflow. It creates a draft containing the executable and its SHA-256 checksum; a maintainer reviews and publishes the draft manually.

---

## Feedback

Report bugs and request improvements through [GitHub Issues](https://github.com/fr4ncisx/codex-mystats/issues).

---

## Disclaimer

WIMU is an independent project. It is not affiliated with or endorsed by OpenAI.

---

<div align="center">

**Include your Windows and Codex CLI versions when reporting an issue.**

</div>
