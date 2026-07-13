# LogRadar Packaging + CI Plan (④b)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Make LogRadar shippable + continuously verified: Tauri bundle config (real app icon + .dmg/.msi targets), `dirs` crate for the workspace config dir, + a GitHub Actions CI matrix (macOS + Windows) running cargo test + npm test + tauri build.

**Architecture:** Config-heavy (tauri.conf.json bundle block + a CI YAML), one small Rust change (swap the `~/.config` fallback in `src-tauri/src/workspace.rs` for the `dirs` crate's platform-correct config dir), + a real app icon set (replacing the 1×1 placeholder from ②). No frontend logic changes.

**Tech Stack:** Tauri 2.x bundler, `dirs` crate (Rust), GitHub Actions (macOS + Windows runners).

## Global Constraints

- Tauri 2.x; macOS + Windows targets (Linux product-supported but v1 CI = macOS + Windows per spec F1).
- Don't break the 162 frontend tests or 67 Rust tests.
- TDD where there's logic (the `dirs` swap is testable); config changes verified by `cargo tauri build`/CI.
- Out of scope (post-v1): ExportDialog real progress (needs a ② export-progress event), variable-height virtualizer (inline JSON overlay is v1), proper SplitView core-normalized time-matching, level-distribution IPC, rayon parallelism, gz resync/zran.

---

## Task 1: Tauri bundle config + real app icon + `dirs` crate

**Files:**
- Modify: `src-tauri/tauri.conf.json` (add `bundle` block: productName, identifier, app icon, targets dmg/nsis)
- Create: `src-tauri/icons/` — real icon set (1024×1024 PNG + .ico for Windows + .icns for macOS — generate from a LogRadar radar-glyph source; or use `tauri icon` on a 1024 PNG)
- Modify: `src-tauri/Cargo.toml` (add `dirs = "5"`), `src-tauri/src/workspace.rs` (use `dirs::config_dir()` instead of the `~/.config`/temp fallback)

**Interfaces:**
- Produces: `cargo tauri build` produces a `.app`/`.dmg` (macOS) + `.msi`/`.exe` (Windows) with the real LogRadar icon + productName; `workspace.rs` config_dir uses the platform-correct dir (`~/Library/Application Support/` on macOS, `%APPDATA%` on Windows, `~/.config` on Linux).

- [ ] **Step 1**: Test — `workspace.rs` `config_dir()` returns the `dirs`-based path (mock `dirs::config_dir`); the `~/.config` fallback is gone. RED (still uses fallback) → GREEN (uses dirs). 
- [ ] **Step 2**: Run → FAIL. - [ ] **Step 3**: Add `dirs = "5"` to `src-tauri/Cargo.toml`; `workspace.rs` `config_dir()` → `dirs::config_dir().unwrap_or_else(|| std::env::temp_dir()).join("logradar").join("workspaces")`. Generate the real icon set (a 1024×1024 PNG of the radar glyph → `npx @tauri-apps/cli icon` or `tauri icon` produces the full set; replace the 1×1 placeholder). `tauri.conf.json` `bundle`: `{ "productName": "LogRadar", "identifier": "com.logradar.app", "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.icns", "icons/icon.ico"], "targets": "all" }` (web-verify the Tauri 2 bundle schema). - [ ] **Step 4**: `cargo test -p logradar-tauri --lib workspace::tests` PASS + `cargo build -p logradar-tauri` compiles. - [ ] **Step 5**: Commit `feat(pkg): Tauri bundle config + real app icon + dirs config dir`.

---

## Task 2: GitHub Actions CI (macOS + Windows matrix)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a CI workflow: on push/PR → matrix (macos-latest, windows-latest) → install Rust + Node → `cargo test --workspace` + `npm test` + `cargo tauri build` (smoke — produces artifacts; cache cargo + npm).

- [ ] **Step 1**: Write `.github/workflows/ci.yml`:
```yaml
name: CI
on: { push: {}, pull_request: {} }
jobs:
  build-test:
    strategy: { matrix: { os: [macos-latest, windows-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - uses: Swatinem/rust-cache@v2
      - run: npm ci
      - run: npm test
      - run: cargo test --workspace
      - run: cargo tauri build  # smoke: produces app artifact
```
(No local test — CI runs on push. Verify the YAML is valid + the steps match the repo's actual commands: `npm ci` requires package-lock.json committed — it is, on main from ③a.)
- [ ] **Step 2**: `npm test` + `cargo test --workspace` locally green (the CI just runs these). - [ ] **Step 3**: Commit `ci: GitHub Actions macOS + Windows matrix (cargo test + npm test + tauri build)`.

---

## Task 3: Release build smoke + README

**Files:**
- Create: `README.md` (project overview + dev/build instructions)

- [ ] **Step 1**: Write `README.md` — what LogRadar is, the 4-sub-project structure, dev (`cargo tauri dev`), build (`cargo tauri build`), test (`cargo test --workspace && npm test`), the v1 scope/deferrals summary (link to the spec). - [ ] **Step 2**: `cargo tauri build` locally (produces the app artifact — smoke; if it fails locally due to signing, the CI handles it). - [ ] **Step 3**: Commit `docs: README + release build smoke`.

---

## Self-Review

**Coverage:** Tauri bundle (T1), CI (T2), README + build smoke (T3). All ④b scope. ✓
**Deferred (post-v1, documented in README):** ExportDialog real progress, variable-height virtualizer, SplitView core-normalized time-matching, level-distribution IPC, rayon, gz resync/zran.
**Type consistency:** `dirs::config_dir` swap doesn't change `workspace.rs`'s public API (config_dir returns PathBuf). ✓

## Execution Handoff
Saved to `docs/superpowers/plans/2026-07-13-logradar-packaging-ci.md`. Execute via superpowers:subagent-driven-development (per the user's loop — this is the final sub-project).
