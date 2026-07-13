# LogRadar

**Offline, high-performance, cross-platform log query tool.** Open GB-scale logs, search across files, jump to the line that explains the incident. Think "Notepad++ experience, built for log forensics."

LogRadar is for backend / SRE / engineers doing **post-mortem analysis on already-downloaded log files** — drag a handful of logs in, cross-file search, filter by level/time, split-compare two files on normalized time, and land on the root-cause line. It is *not* a real-time tail / streaming ingest; the scenario is offline analysis of logs you already have on disk.

Built from scratch on **Tauri + Rust core + React/TypeScript frontend**, using the system webview for a small, native bundle.

---

## Architecture — four sub-projects

LogRadar is a single workspace composed of four layers. Each was designed and built against its own spec'd plan (`docs/superpowers/plans/`):

| # | Sub-project | Directory | Owns |
|---|---|---|---|
| ① | **Rust core** | `crates/logradar-core/` | All performance-sensitive logic: mmap + line indexing, gz/zip streaming decompression, multi-condition query engine, format/level/timestamp detection, encoding (UTF-8/GBK). Exports `LineIndexer`, `Session`, `QueryEngine`, `Query`, `LineFormat`. |
| ② | **Tauri shell (IPC)** | `src-tauri/` | The native app process: exposes Rust-core commands to the webview (`open_file`, `get_lines`, `search`, `cancel_search`, `export`, `workspace_*`), owns `FileSession` state, streams batched results via Tauri events, persists workspaces via `dirs::config_dir()`. |
| ③ | **Frontend** | `src/` | All UI (React + TS + Vite). Split into ③a **infra** (`lib/ipc`, `hooks/useSessions`, `router`, `theme`) and ③b **pages/components** (`MainWindow`, `WelcomePage`, `SplitView`, `ExportDialog`, `WorkspaceManager`, `VirtualLogView`, `SearchPanel`, `FileTree`, `TabStrip`, `JsonInspector`, `Minimap`, `SyntaxHighlighter`). |
| ④ | **Packaging & CI** | `src-tauri/tauri.conf.json`, `src-tauri/icons/`, `.github/workflows/ci.yml` | Tauri bundle config (productName, identifier, real icon set, `.app`/`.dmg`/`.msi`/`.exe` targets), platform-correct config dir, GitHub Actions matrix (macOS + Windows) running tests + a release-build smoke. |

The two load-bearing design rules (see the [design spec](docs/superpowers/specs/2026-07-12-logradar-design.md)):

1. **The UI never receives the whole file.** `open_file` returns only metadata (encoding, format, line-count estimate); `VirtualLogView` requests small line windows on scroll; Rust decodes just that slice. A GB file keeps only "the few dozen visible lines" resident in the webview.
2. **Filtering is a projection, not in-place hiding.** A multi-condition query produces a matched-row-number result list; the virtualizer runs over *that* list and maps back to original offsets. Search / filter / cross-file aggregation all reuse the one line index — no parallel big lists.

---

## Quick start

### Prerequisites

- **Rust** stable (≥ 1.75) — `rustup`
- **Node.js** 20 + npm (frontend dev + build)
- **Tauri 2** system prerequisites — the OS webview toolchains:
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Microsoft WebView2 runtime + MSVC build tools
  - (Linux product-supported; v1 CI is macOS + Windows.)

### Install frontend deps

```bash
npm ci
```

### Dev (hot-reload app + webview)

```bash
npx tauri dev
```

This boots the Rust app process and points the webview at the Vite dev server (`http://localhost:5173`); edits to `src/` or the Rust crates hot-reload.

> `tauri-cli` is pinned as a dev dependency (`@tauri-apps/cli` in `package.json`) — `npm ci` installs the OS-correct prebuilt binary into `node_modules`, so no global `cargo install cargo-tauri` is needed. Call it via `npx tauri …` (or `npm run tauri …`).

### Build a release bundle (smoke)

```bash
npx tauri build
```

Runs `npm run build` (`tsc && vite build`) as `beforeBuildCommand`, then compiles the Rust app in release mode and bundles a native artifact with the real LogRadar icon:

- macOS → `.app` + `.dmg` under `src-tauri/target/release/bundle/`
- Windows → `.exe` (NSIS) + `.msi` under `src-tauri/target/release/bundle/`

Unsigned local builds may be blocked by macOS Gatekeeper / Windows SmartScreen — that's expected locally; see the build-smoke note below.

### Test

```bash
# Rust core + Tauri shell (unit + integration + proptest)
cargo test --workspace

# Frontend (Vitest + Testing Library, jsdom)
npm test
```

Both must stay green. CI runs the same two commands across the macOS + Windows matrix.

### Benchmarks (optional, Rust core only)

```bash
cargo bench -p logradar-core
```

Criterion benches for indexing/search throughput live in `crates/logradar-core/benches/`. They guard against perf regressions but are too slow for per-PR CI — run on demand or nightly.

---

## v1 scope & deferrals

**In v1** (locked in the [design spec](docs/superpowers/specs/2026-07-12-logradar-design.md), §2):

- Open GB-scale logs via mmap + virtual scrolling (never full-load into memory)
- Sidebar directory tree + top tab strip to organize many files
- `.gz` / `.zip` drag-in with streaming decompression (search-without-decompress for large gz)
- Multi-condition query: keyword (text/regex) AND/OR + level + time-range + exclusion
- Cross-file aggregated search (bottom panel, flat per-file-path rows)
- Time filtering with internal timestamp normalization across log formats (ISO8601 / syslog / epoch / `YYYY/MM/DD HH:MM:SS`)
- Level / timestamp / JSON syntax highlighting
- Bookmarks + split-compare two files on normalized time (with user-set tolerance)
- Auto-wrap toggle
- Inline JSON field inspector (expand/collapse field tree in place)
- Session-level search history (full query per entry; click to re-run)
- Export filtered results (range / format / columns / target / live preview)
- Workspace save/restore (open files + full query conditions)
- Dark / light one-toggle theme

**Deferred past v1** (explicitly out of scope; tracked in the packaging plan's self-review and the spec):

- Real-time `tail -f` follow — *removed* (offline scenario)
- Statistics panel (level distribution / top patterns) — v1 doesn't build it
- spill-to-disk for very wide filter results — v1 truncates + warns
- Live data-source ingest (SFTP / Kafka / object storage) — not the scenario
- Auto-diagnosis rule engine, plugin/scripting, alerting — not the scenario
- A handful of hardening items acknowledged in-plan, deferred post-v1: `ExportDialog` real streaming progress (needs a ② `export_progress` event), variable-height virtualizer (inline JSON overlay is the v1 approach), proper `SplitView` core-normalized time-matching, level-distribution IPC, `rayon` parallel search wiring, and gz mid-stream resync / `zran` random-access index.

Full design rationale, the locked feature list, UI/UX direction, and the component/data-flow breakdown live in the spec:
[`docs/superpowers/specs/2026-07-12-logradar-design.md`](docs/superpowers/specs/2026-07-12-logradar-design.md).

---

## CI

`.github/workflows/ci.yml` — runs on every push and pull request across a `macos-latest` × `windows-latest` matrix:

1. `npm ci` → `npm test` (frontend)
2. `cargo test --workspace` (Rust, cached via `Swatinem/rust-cache`)
3. `npx tauri build` — release-build smoke; produces the native app artifact per OS.

Linux is product-supported but deferred from the v1 CI matrix per spec §F1.

---

## Status

**v1** — the four sub-projects are complete on this branch; merge to `main` ships LogRadar v1.
