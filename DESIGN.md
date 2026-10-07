# wasmedge-agent 設計方案

**文件定位**：本文件承接《REPORT.md》（2026-08-06 可行性研究）的結論，依其建議路線——**Phase 0 以 extension 掛載 PoC（不 fork）→ Phase 1 fork prime-agent 置換 runtime 層 → Phase 2 功能對齊與 T2 runner**——給出可直接開工的完整工程設計。分析性內容（耦合面、實測數據、路線比較）不在此重複，見 REPORT.md 對應章節。

- 基準上游：`PrimeIntellect-ai/prime-agent` v0.7.0（HEAD `c22549a3`）
- 工作名稱：**wasmedge-agent**（模型可見工具名：`rust`）
- 目標平台：macOS / Linux（Windows 列 Phase 2 評估）
- 撰寫日期：2026-08-06
- **狀態：已定稿**——同日完成六輪逐節審閱，23 項決策（D1–D23）全數定案；審閱軌跡見 §11

**閱讀方式**：定稿表示設計決策已確認，不表示全部完成。各節實作註記記錄後續落地範圍；歷史量測不代表目前版本性能。現況見 [runtime 文件](packages/coding-agent/docs/rlm-runtime.md)；引用量測時須保留 revision／環境標註。

---

## 目錄

1. [總體架構](#1-總體架構)
2. [核心元件設計](#2-核心元件設計)
3. [Prompt 設計（RUST_CONTROL_PROMPT 草案全文）](#3-prompt-設計)
4. [Skills 與自我改進](#4-skills-與自我改進)
5. [遞迴 subagent 與長任務功能](#5-遞迴-subagent-與長任務功能)
6. [Phase 0：PoC 詳細設計](#6-phase-0poc-詳細設計)
7. [Phase 1：Fork 手術計畫](#7-phase-1fork-手術計畫)
8. [Phase 2：概要設計](#8-phase-2概要設計)
9. [測試與驗證策略](#9-測試與驗證策略)
10. [組態與部署](#10-組態與部署)
11. [決策記錄（D1–D10）](#11-決策記錄)
12. [里程碑與時程](#12-里程碑與時程)
13. [附錄：協議範例與模板全文](#13-附錄)

---

## 1. 總體架構

### 1.1 系統圖（Phase 1 架構，含 2026-10-02 bridge 更新）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 保留並調整的 TypeScript host                                        │
│  TUI / Print / JSON / RPC / ACP clients                              │
│  Daemon supervisor ── Session worker（一棵 session tree 一進程）      │
│    └ AgentSession                                                    │
│        ├ providers（packages/ai：9 API × 32 providers）              │
│        ├ session JSONL 樹 / lease / compaction / goals / autonomous  │
│        ├ HostRequestHandlers registry（rlm.run、goal.*、msg.*、mcp.*）│
│        └ tools registry ──┬── "rust"（新）                           │
│                           └── "bash"（啟用既有 tools/bash.ts）        │
├──────────────────────────────────────────────────────────────────────┤
│ 新增：core/rust-cell/（取代 core/kernel/ 3.3K 行）                    │
│                                                                      │
│  RustCellManager                                                     │
│    ├ WorkspaceManager     session cargo workspace 的建立/守護/git 化  │
│    ├ CompilePipeline      cargo build（offline、診斷解析、暖快取）     │
│    ├ ExecPipeline         wasmedge 子進程（preopen、env、串流、逾時）  │
│    └ BridgeServer         private stdio + JSON-lines（host bridge）   │
│         └→ 分派到既有 HostRequestHandlers（原封重用）                  │
├──────────────────────────────────────────────────────────────────────┤
│ Guest（Wasm 沙箱內，wasm32-wasip1）                                   │
│                                                                      │
│  cell.wasm（每回合重編譯的完整程式）                                   │
│    ├ use agent_lib::prelude::*   ← 持久函式庫（skills + 自建 helpers）│
│    └ rlm crate                   ← guest shim（≈prime-agent-runtime） │
│         ├ rlm::state             /agent/state serde KV               │
│         ├ rlm::spawn / msg / goal / display / harness / mcp          │
│         └ bridge client（stdin/stdout → BridgeServer）                │
│                                                                      │
│  Preopens：/workspace（專案）、/agent（lib+state）、/scratch          │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 進程模型與生命週期

| 進程 | 生命週期 | 對應現制 |
|---|---|---|
| Session worker（TS） | 同現制（daemon 管理） | 不變 |
| `cargo build` | 每 cell 一次，短命 | —（新） |
| `wasmedge` | 每 cell 一次，短命（**無長命 kernel 進程**） | 取代長命 `ipykernel` |
| BridgeServer（TS，worker 內 dispatcher） | 每 session 一個；每 cell 綁定 private stdio pipes，結束即斷開 | 取代 ZMQ 三通道 |

關鍵差異：現制的「持久性」載體是 kernel 進程的記憶體；新制的持久性載體是**磁碟上的 workspace**（git 版本化）。已成功寫入的 state／library 可跨 worker 重啟保留，未落盤狀態與進行中的副作用沒有無損或交易式恢復保證。Cell 短命，逾時直接 kill。

**已確認取捨（D11）**：無長命進程意味著 cell 之間不能在記憶體保留大型資料結構，每個 cell 對大輸入需重讀重解析。正式接受此語意；緩解模式為「解析一次、以 `rlm::state`/blobs（bincode 等序列化）存中間形式、後續 cell 載入預處理結果」。若 PoC/實運行顯示為真瓶頸，再評估 resident data service（不預先設計）。

### 1.3 設計原則

1. **Host 權威不變**：credentials、provider 呼叫、child 生命週期、transcript、政策全在 TS host；guest 只有 thin shim（與現制同構，見 REPORT §1.2）。
2. **程式碼即記憶**：跨回合資產只有三種形態——`agent_lib` 原始碼、`/agent/state` 資料、`/workspace` 專案檔案。全部可 diff、可版本化、可重放。
3. **誠實的沙箱邊界**：wasm 沙箱涵蓋 agent 自身計算；`bash` 與 host bridge 是有名有姓的顯式越權通道（REPORT §3.5 邊界圖）。文件與 README 不得宣稱「全沙箱」。
4. **決定性優先**：所有 side effect 過可記錄邊界（preopen FS + bridge），為 Phase 3 的 trajectory replay 留基礎；guest 不直接持有網路能力（stdio bridge + import 白名單，見 §2.7）。
5. **對上游的最小侵入**：改動集中在整塊替換目錄；散改點維護於 `SYNC.md` 清單（§7.3）。

---

## 2. 核心元件設計

### 2.1 Session Workspace

每個 persisted session 在 artifacts 目錄下有一個 host 管理的 cargo workspace（對映現制 `kernel-state.dill` 的位置語意）：

```
<session-artifacts>/<session-id>/workspace/
├── .git/                    # host 管理的版本化（見下）
├── Cargo.toml               # [workspace] members = ["agent_lib", "cell"]
├── .cargo/config.toml       # target=wasm32-wasip1、vendored registry、offline
├── agent_lib/
│   ├── Cargo.toml           # deps = 固定 prelude 集（serde、serde_json、regex、anyhow、…）+ rlm
│   └── src/
│       ├── lib.rs           # pub mod prelude; pub mod skills; pub mod helpers;
│       ├── prelude.rs       # re-exports + 常用 helpers（read_lines/grep/walk/edit_exact/…）
│       ├── skills/          # skills-as-crates 的 re-export 掛載點（§4.1）
│       └── helpers/         # ★ 模型自建函式的家（可自由新增檔案）
├── cell/
│   ├── Cargo.toml           # deps = agent_lib（間接取得全部 prelude）
│   └── src/main.rs          # ★ 每回合由 host 用工具參數覆寫
├── rlm/                     # guest shim crate（模板攜帶；host 於升級時覆寫，
│                            #  模型不應修改——scaffold 版本 marker 涵蓋其 hash）
├── state/                   # ★ guest 掛載為 /agent/state
│   ├── state.json           # rlm::state 的 KV 檔
│   └── blobs/               # 大物件（rlm::state::put_blob）
└── target/                  # 增量編譯快取（不進 git）
```

**Scaffold 流程**（`WorkspaceManager.ensure()`，對映 `ensureKernelPython`）：

1. 若 workspace 不存在：從預建的**模板**複製，嘗試重用 prelude 的 target 快取。Cache 可重用時可避免 REPORT §2.4 曾量到的 4.8s 冷依賴編譯；toolchain、依賴、library 或快取狀態改變仍可能重編，沒有固定首 cell 延遲保證。
2. `git init` + 初始 commit（`.gitignore`: `target/`）。
3. 版本 marker `.workspace-version`（對映 `.bootstrap-version` schema 8 的機制）：記錄模板版本、prelude crate 集 hash、rustc/wasmedge 版本；不符時重建 scaffold 但**保留 `agent_lib/src/helpers`、`skills` 掛載與 `state/`**（使用者資產不可因升級消失——優於現制 venv 整個 rm -rf 的做法）。

**Lib 變更與防磚（D14 定案：宣告式）**：`/agent/lib` 對 guest 是**唯讀** preopen；模型經工具呼叫的選配 `lib` 參數擴充函式庫（§2.5）。host 在編譯前寫入宣告的檔案，lib 與 cell **同次編譯**；失敗或中斷的 build 回復先前 cell source、提供的 lib edits 與 generated helper index，不執行本次 cell。這是還原先前來源的保證，不是「workspace 永遠可編譯」：外部修改、可編輯 skill source 或依賴變動仍可破壞下次 build。編譯成功後的 panic、timeout 或 import-policy 拒絕不回滾來源，runtime 副作用也不交易式回滾。

- Persisted workspace 每次 cell 成功執行後，host commit 指定範圍的來源與狀態（訊息含 cell 序號與 tool call id）；這是歷史快照，不等於完整 trajectory replay。
- `lib` 路徑驗證：僅接受 `src/**`（相對 `agent_lib/`）、拒絕 `..` 與絕對路徑；`Cargo.toml` 不可經此改動（依賴政策走 D15）。
- 非 persisted session（`--no-session`）：workspace 放 OS temp、不 git；lib 回滾改用編譯前記憶體備份。

**D5 實作註記（2026-10-01）**：persisted workspace 已有獨立 Git repo、初始快照與成功 cell 的 commit（含序號及 tool call id）。僅納入 scaffold source/manifests、`agent_lib`、skill 掛載與 `state/`；排除 `target/`、`vendor/`、scratch，外部 skill symlink 只版本化連結。專案目錄與 harness stores 不在此 repo。Git 失敗獨立回報，不重跑已成功的 cell；失敗 cell 不 commit、不回滾 runtime 副作用。

Workspace history 的 Git 命令將自動 maintenance／GC 留在前景，正常返回前完成維護，避免背景程序修改 `.git` 的 objects／lock 與隨後的 scaffold 升級複製重疊。這不協調使用者另行啟動的 Git 操作或排程維護。

**Git 快照取消（2026-10-07）**：初始化、成功 cell 與 dependency snapshots 的 Git 改為非同步 subprocess；每次完整操作共用最多 30 秒，並受 startup／cell 剩餘預算與取消訊號約束。同一 history instance 內序列化，排隊計入預算。取消先向 process group 發 SIGTERM，最多一秒後 SIGKILL，等 subprocess 與 pipes 關閉才釋放 workspace。成功 cell 保留 `ok`，快照錯誤獨立回報；已發布的 dependency 不因 Git 失敗回滾。取消可能發生在 commit 已發布或 maintenance 期間，因此錯誤不代表沒有 commit，不自動重跑。強制終止／host crash 可能留下 lock；不自動刪 lock，操作人須確認沒有活躍 Git 後才修復。這不是交易式快照或跨進程鎖。

**Scaffold 升級實作註記（2026-10-01）**：`.workspace-version` 已記錄 template content hash、dependency hash、rustc/WasmEdge 版本與 library 預設檔案 hash。Provision 時版本不符，先在旁邊的 workspace 更新 host scaffold，保留 helpers、skills、state、cell source、Git history 與 library overrides；重新掛載 skills 並以 release/offline 編譯既有 cell，通過才切換。失敗保留原 workspace，切換中斷可由 upgrade journal 復原；前提是一個 session workspace 由一個 active runtime 擁有。沒有舊 marker 的 workspace 保守保留全部既有 library source。Marker 隨 child seed 複製並納入 Git；skill manifest 偵測繼續使用 `.skills-hash`。此 gate 只驗證 scaffold 升級的編譯相容性，D19 的 skill 登錄測試另見 §4.2，並非此 scaffold gate 的一部分。

### 2.2 RustCellManager（TS API）

取代 `KernelManager`，但介面刻意模仿其形狀以縮小 `AgentSession` 的改動面（對映 REPORT §1.12 的 85 處耦合點中多數只需改型別名）：

```ts
// core/rust-cell/index.ts
export interface RustCellManagerOptions {
  cwd: string;                          // 專案目錄（/workspace 掛載源）
  workspaceDir?: string;                // session workspace；undefined = temp（--no-session）
  env?: Record<string, string>;         // RLM_DEPTH 等（沿用 _rlmKernelEnv 的鍵）
  hostHandlers?: HostRequestHandlers;   // ★ 原封重用現有 registry 型別
  rustSkills?: RustSkillRuntimeInfo[];  // §4.1
  settings?: RustCellSettings;          // timeout、writePolicy、preludeExtra…
  onEmit?: (e: CellEmitEvent) => void;  // diff / attachment / agent-message（§2.9）
}

export class RustCellManager {
  static async ensureToolchain(onProgress?): Promise<ToolchainInfo>;
                                        // 對映 ensureKernelPython：檢查 rustup target
                                        // + wasmedge 可執行檔 + 模板 workspace
  async start(): Promise<void>;         // scaffold workspace + 啟動 BridgeServer（lazy）
  async execute(cell: CellInput, opts: ExecuteOptions): Promise<CellResult>;
                                        // 串行化（promise chain，同現制 executionQueue）
  async listPersistentState(): Promise<PersistentStateListing>;
                                        // state keys + agent_lib pub API（compaction 通知用）
  async interrupt(): Promise<void>;     // kill 當前 cell 子進程（cargo 或 wasmedge）
  async dispose(): Promise<void>;       // 取消 cells/tests，等待來源回復與 bridge 清理
}

export interface CellInput {
  code: string;                         // cell/src/main.rs 內容
  lib?: { path: string; content: string }[];
                                        // 編譯前寫入 agent_lib/（D14；路徑限 src/**）
}

export interface CellResult {
  status: "ok" | "compile_error" | "error" | "timeout" | "aborted";
  stdout: string; stderr: string;       // 各截斷 65_536 字元（沿用 DEFAULT_MAX_OUTPUT_CHARS）
  compileDiagnostics?: string;          // rustc rendered 診斷（截斷 65_536）
  exitCode?: number;
  durationMs: number; compileMs: number; runMs: number;
  libApplied: boolean;                  // lib 參數已寫入且編譯通過（隨 cell 成功而 commit）
  libReverted?: boolean;                // compile_error 且宣告了 lib → 檔案已回滾
  diffs: KernelDiffDisplay[];           // 沿用現有型別；host 對 applied lib 檔自動合成 diff
  attachments: KernelAttachment[];      // 沿用（含 10MB 上限）
  sentAgentMessages: KernelSentAgentMessage[];
}
```

執行狀態機：`idle → compiling → running → committing → idle`；`interrupt()` 在 compiling/running 態 kill 對應子進程（process group SIGKILL，參照 sandbox 範例 `detached: true` 模式）。**無 busy-reuse 流程**——cell 短命，這整類複雜度（`KernelBusyAfterInterruptError`、restart notice、5 秒等待）刪除。

**Runtime 關閉實作註記（2026-10-06）**：`RustCellProvisioner.dispose()` 取消進行中與排隊的 cells、skill tests，等待失敗／中斷 build 的來源回復及 bridge 清理；舊 runner 後續呼叫回報 `aborted`，不再修改來源。啟動中的 runner 不會在關閉後重新掛回；同一 provisioner 關閉完成後可透過 `ensure()` 建立新 runner。`AgentSession.dispose()` 發起取消，`disposeAsync()` 等待清理；reload／runtime 重建須等前一 runtime 釋放 workspace 才開始 provision。關閉不刪 workspace、不額外 Git snapshot，也不回滾已發生的 runtime 副作用。Runtime toolchain probes 與初始化 Cargo 已支援取消及獨立 startup budget（見下段）；不合作的 host handlers 沿用 bridge 的有限等待，不保證其外部副作用已停止。

**初始化取消（2026-10-07）**：runtime toolchain probes、template vendoring／warm build、configured deps vendoring、scaffold validation 與 skill compile probes 改為非同步 subprocess，共用預設五分鐘 startup budget（SDK `provisionTimeoutMs`，與 `cellTimeoutMs` 分開）。`rust` tool abort、`ensure(onProgress, signal)` 或 runtime disposal 取消進行中的初始化；等 subprocess 結束才清理 staged tree，取消 scaffold build 保留原 workspace，取消 skill probe 不當成壞 skill／不快取半套 probe。初始化 build 共用既有 Cargo concurrency gate，排隊可取消且計入 startup budget。相同 provisioner（含 prewarm）共用一次啟動，任一等待者取消會取消整次；下一次可重試。同 host 的 template 準備序列化，等待者取消不影響其他 provisioner 的 owner；vendor 使用獨立暫存目錄、成功才發布。Git 初始化亦走上述可取消路徑。Workspace 初次 clone／scaffold upgrade 的遞迴複製、來源 hashing 與 staging cleanup 亦改為非同步：逐項檢查取消，hash 串流可中止，等進行中的 filesystem call／file close 後才清理。初次 clone 同樣先暫存、完成才發布，取消或失敗不留下半套 workspace。單次 copy syscall 與清理不可立即中斷；systemd group setup、少量 metadata、skill／rustdoc fingerprints 與 dependency recovery 仍有同步操作，因此不是整段初始化的硬即時上限；doctor／installer 維持同步 maintenance API。

Session 關閉路徑共用一次 runtime teardown：先 `dispose()` 再 `disposeAsync()`，或同步關閉插入非同步 refinement drain 期間，後續等待仍涵蓋該 session 的 runtime 與 disposal callbacks，不會因 session 已標示 disposed 而提前完成。

關閉也等待已進入 host cleanup 的 retained／passive child 刪除；失敗時先等 retained child 的 fallback disposal，再保留原始刪除錯誤。Parent 進入 disposing／disposed 後拒絕新的 child 刪除；尚在非同步 selector preflight 的請求返回後也須重新檢查，不能在關閉後啟動 host cleanup。經 root 刪除 nested child 時同時受 root 與 owner 的關閉狀態約束。Parent disposal 維持 best-effort，晚到的刪除結果不會重新建立已關閉 parent 的 child tombstones。

Process 錯誤路徑：已取得 child process handle 後，即使 bridge attachment 或 child process 回報錯誤，也先終止 process group 並等到 `close`，才回報原始錯誤、釋放編譯許可或回復來源；同步 spawn throw 尚未取得 child handle，則直接回報。

併發治理：cargo build 吃 CPU。沿用 `boot-gate.ts` 的許可證模式做 **compile gate**：全 worker 進程內同時編譯數 `min(4, cpus/2)`，可用 `WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS` 覆寫（對映 `PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS`）。

**Template 跨程序協調（2026-10-08）**：runtime、installer／doctor 與同步 warm／vendor APIs 共用 canonical template 路徑的本機 ownership lock；取得後重查 caches，runtime 等待可取消且計入 startup budget，取消等待者不影響 owner。Owner record 原子發布，僅確認同 host／PID namespace 的 owner PID 已不存在才接手；PID reuse／權限不明保守視為存活，不因 build 過久搶鎖。短期 metadata guard 與長期 build ownership 分離；同步 maintenance 最多等待五分鐘，同程序重入拒絕。鎖位於 template 旁、排除於 clone／release assets；冷準備需 parent 可寫，已完成且 idle 的 template 可唯讀使用。Host crash 的 orphan Cargo／暫存目錄不由接手者清除，Cargo 自有 build lock 保留；不是跨主機／container 或手動 Cargo 操作的協調機制。詳見 runtime 文件。

### 2.3 編譯管線

```
cargo build --release --target wasm32-wasip1 \
      --offline --message-format=json-diagnostic-rendered-ansi \
      -p cell
```

- **offline + vendored**：安裝時 `cargo vendor` 把 prelude 依賴鎖進 `~/.wasmedge-agent/vendor/`（全域共享、唯讀）；workspace 的 `.cargo/config.toml` 指向它。cell 編譯**永不碰網路**（供應鏈與決定性雙重理由）。
- **依賴政策（D15 定案）**：Phase 1 prelude 集**鎖死**；使用者可經 settings `preludeExtra` 追加（session 啟動時 host 重新 vendor）。`rlm::deps::add` 在 Phase 1 回明確的 not-supported 錯誤（指示改請使用者調 settings）；動態新增延至 Phase 2 以 curated 白名單實作（host 抓取 → re-vendor → 改 Cargo.toml → commit）。

**使用者追加依賴已落實（2026-10-02）**：`rustCell.preludeExtra` 接受 `{ name, version, features?, defaultFeatures? }`；version 限精確 `x.y.z` crates.io release，拒絕 Git/path、保留名稱、重複名稱及 skill crate 衝突。Host 在 workspace upgrade 的暫存樹中加入 workspace／agent_lib dependencies、生成 `agent_lib::prelude::extra` re-exports、vendor，再以 release/offline build 驗證保留的 cell 與 library，成功才發布。設定納入 workspace identity；相同設定的 resume／child seed 重用既有 vendor／lock，設定變動或 scaffold 更新走 staging，失敗保留原 workspace。共享模板不修改；`prelude_extra.rs` 由 host 管理。這是使用者設定的可信 host build inputs（包含 build scripts／proc macros），不是沙箱內動態安裝；curated `rlm::deps::add` 初版見下方實作註記。
- **診斷處理**：解析 message-format JSON 流，取 `rendered` 欄位串接（strip ANSI 後截斷 65,536）。編譯失敗 → `status: "compile_error"`、`isError: true`、**不執行**；診斷全文就是 tool result（REPORT §2.2 的一等回饋原則）。
- **profile**：release（REPORT 的 0.28s 是特定小程式、暖快取下的 release 量測，不是固定 build 延遲）。`[profile.release] debug = false, incremental = true`；`codegen-units` 預設。不做 wasm-opt/strip。
- 快取：per-session `target/`（模板預熱）。不跨 session 共享 target（鎖競爭與污染風險 > 收益；模板複製已解決冷啟動）。

**Curated deps.add（2026-10-02）**：`rlm::deps::add(name)` 已接上 host handler，catalog 擴至 30 個精確版本 crates.io crate（default features；版本見 `dependency-catalog.ts`），全部有代表性 API 的 WASI build／WasmEdge execution 測試。模型不能指定版本、features 或來源。Host 先在暫存 workspace 離線解析，缺少來源才以 `cargo vendor` 抓取／re-vendor；此時尚未掛載 skills，保留僅供 skills 使用的既有 vendor sources，再掛回 skills 並離線 release-build。解析、抓取與 build 共用 cell timeout／abort。成功後原地發布依賴檔與 vendor directory，記錄 `chore(deps)` snapshot，不替換執行中 cell 的 state directory／preopen。更新有中斷 recovery journal，能回復初版八檔 journal；fetch／build 失敗或取消不發布。新增記錄隨 resume／child seed 保留，下一個 cell 以 `extra::<crate>` 使用；使用者 `preludeExtra` 同名設定優先，重複新增是 no-op。已成功新增的依賴不因後續 cell panic 回滾；Git 失敗回報「已新增但 snapshot 失敗」。未 vendor 的 crate 需要 registry access 或已有 Cargo cache；既有 vendor 與相同設定的 resume／child 可在空 Cargo cache 下離線使用。不開放 guest removal 或任意來源。

### 2.4 執行管線

```
wasmedge run --force-interpreter \
  --dir /workspace:<cwd> \
  --dir /agent/lib:<workspace>/agent_lib:readonly \
  --dir /agent/state:<workspace>/state \
  --dir /scratch:<session-temp> \
  --env RLM_BRIDGE_STDIO=1 --env RLM_BRIDGE_TOKEN=<token> \
  --env RLM_CELL_ID=<tool-call-id> --env RLM_CELL_TIMEOUT_MS=<cell-budget-ms> \
  --env RLM_DEPTH=<n> --env RLM_SESSION_DIR=/agent \
  <workspace>/target/wasm32-wasip1/release/cell.wasm
```

上述為 `CellRunner` 組裝的命令形狀；host 必須同時處理 stdout protocol frames 並向 stdin 回覆，不能只在 shell 設 env 就取得 bridge。Readonly preopen 由專用 inert module 探測；runtime 不支援時省略 library 掛載。Standalone 純計算 cell 可省略 bridge env，但直接呼叫 WasmEdge CLI 不含 agent 的 import 政策。

- **執行前 import gate**：cargo 成功後 validate Wasm 並檢查全部 imports，只允許明列的非網路 WASI Preview 1 functions；失敗或取消不啟動 cell（§2.7）。強制 interpreter 避免 embedded AOT native code 繞過檢查。
- `/agent/lib` 與 `/agent/state` 為**兩個獨立 preopen**（定案：不做合成 `/agent` 掛載，避免依賴 preopen 對 symlink 的行為；guest 路徑穩定為 `/agent/lib/src/...`、`/agent/state/...`）。`/agent/lib` 唯讀（D14——lib 變更只經 `lib` 參數）。
- **stdout/stderr 串流**：host 先從 stdout 分離 bridge frames，普通輸出逐 chunk 經 `onUpdate` 送 TUI；host 累積並截斷。stdin 專供 bridge 回覆。
- **逾時**：單一 cell 總預算 `cellTimeoutMs`（預設 120,000；compile 與 run 共享）。逾時/使用者 abort → process group SIGKILL → `status: "timeout" | "aborted"`。
- 執行後守護（§2.1）：lib guard → git commit。
- 退出碼語意：`0` = ok；非 0（含 panic）= `status: "error"`，stderr 為主要回饋。

### 2.5 `rust` 工具定義

對映 `createIpythonToolDefinition`（保持單參數、sequential 的形狀）：

```ts
name: "rust",
label: "rust",
executionMode: "sequential",
description:
  "Execute a complete Rust program (a 'cell') compiled to wasm32-wasip1 and run in a " +
  "WasmEdge sandbox. Cells are not REPL fragments: variables do not persist between cells. " +
  "Persistent layers instead: rlm::state (key-value), the agent_lib crate (extend it by " +
  "passing lib files alongside your code), and files. Project imports, tests, scripts, CLIs, " +
  "and dependency checks must run through the project's own environment via the bash tool.",
parameters: Type.Object({
  code: Type.String({
    description:
      "A complete Rust program: `use agent_lib::prelude::*;` then `fn main() -> Result<()>`. " +
      "Compile errors are returned as feedback; fix and resubmit the full program.",
  }),
  lib: Type.Optional(Type.Array(Type.Object({
    path: Type.String({ description: "File path inside agent_lib/, e.g. src/helpers/log_parse.rs" }),
    content: Type.String({ description: "Full file content (Rust source)" }),
  }), {
    description:
      "Optional: files to write into your persistent agent_lib crate before compiling. " +
      "Compiled together with the cell; if the library fails to build, the files are " +
      "reverted and the cell does not run.",
  })),
}),
```

**Tool result 組裝規格**（對映 ipython.ts:667-696 的串接順序）：

```
[compile_error 時]  compileDiagnostics
                    ＋若宣告了 lib："\n[your lib files were reverted; the cell did not run]"
[執行後]            stdout ⧺ stderr
[exitCode ≠ 0 時]   "\n[cell exited with code {n}]"
content = [{type:"text", text}, ...imageBlocks]     // attachment → image block，沿用 mime.ts 白名單
isError = status !== "ok"
details  = CellResult                                // 供 renderer / ACP（§7 WP4）
```

Lib 檔套用成功時，host 對每個 lib 檔自動合成 `KernelDiffDisplay`（前值 vs 新值）進 `details.diffs`——使用者在 TUI 看到函式庫演化，零 guest 端成本。

### 2.6 Guest `rlm` crate

對映 `prime-agent-runtime`（Python 1,205 行 → 估 Rust 1–2K 行）。**全同步 API**（wasip1 無原生 async；bridge 呼叫延遲為 pipe 往返／poll + handler 時間，且 `spawn` 語意本就 admission-only 立即返回——REPORT §2.2 第 10 項）。

```rust
// 模組佈局
rlm::error       // pub struct Error { kind: Bridge|Host|State|Io, message } + Result<T>
rlm::bridge      // (內部) stdio client、JSON-lines framing、token、握手更新
rlm::state       // get<T: DeserializeOwned>(key) -> Result<Option<T>>
                 // set<T: Serialize>(key, &T) / remove(key) / keys() -> Vec<String>
                 // put_blob(name, &[u8]) / get_blob(name)      → /agent/state（原子寫：tmp+rename）
rlm              // spawn(prompt) -> Result<SpawnHandle>
                 // spawn_named(prompt, name) / spawn_with(prompt, SpawnOpts{name, model})
                 // find_models(query, limit) -> Result<Vec<Model>>
                 // list_subagents() / delete_subagent(selector)
                 // host_request(type: &str, payload: serde_json::Value) -> Result<Value>  // 泛用門
rlm::msg         // send_to_parent(text) / send_to_child(name, text) / send_to_sibling(...)
                 // list_agents() -> Result<Vec<AgentInfo>>
rlm::goal        // get() / create(objective, GoalOpts) / complete()
rlm::compact     // status() / run(instructions)
rlm::refine      // status() / run(instructions, global)
rlm::heartbeat   // create / list / update / delete
rlm::observe     // list_agents / get_agent / recent_messages
rlm::display     // diff(path, old, new) / attach_image(path)   → emit 事件（§2.9）
rlm::harness     // 經 harness.request 由 host 讀寫 harness_state.json，沿用 schema v1
                 // host 驗證與測試 skill 後保存；guest 不掛載 harness stores
rlm::mcp         // list_tools(server) / call_tool(server, tool, json)
rlm::deps        // add(crate_name) -> Result<()>  // host-curated catalog（D15 後續已落實）
rlm::prelude     // pub use 上述常用項 + anyhow::{Result, Context, bail}
```

`SpawnHandle { rlm_child_id, name, session_dir, model }`——欄位名與現制 payload 完全一致（`rlm-runtime.ts` 的驗證邏輯零修改）。

### 2.7 Host Bridge 協議規格 v1（CLI + stdio）

**傳輸更新（2026-10-02）**：原 T1 TCP bridge 的 crate 約束無法阻止 unsafe／自帶 socket imports。現改用每 cell 的 private stdin/stdout pipes，保留 stock WasmEdge CLI、協議 v1、同步 guest API 與 host handlers；不啟動 TCP listener，WASI guest 不再依賴 `wasmedge_wasi_socket`。Runner 傳入 `RLM_BRIDGE_STDIO=1`、session token、active cell ID 與 cell 時間預算。Native Rust protocol tests 保留 TCP backend 與 `RLM_BRIDGE_ADDR`。這是 T2 native host-functions runner 前的過渡實作，不代表 §8.1 全部完成。

**Guest 網路政策**：所有 cell（有無 bridge 皆同）與 skill tests 共用非網路 WASI Preview 1 function import 白名單。執行前由 host JavaScript engine validate/compile Wasm 並讀取 imports，不 instantiate；socket／DNS、plugin、未知 module/function、非 function imports 及無法驗證的 Wasm features 均拒絕，未使用的 import 也不放行。WasmEdge 必須以 `--force-interpreter` 執行已檢查的 Wasm code，忽略 embedded AOT native payload。這是 agent runner 的 admission policy，不是 stock WasmEdge CLI 的全域網路限制；guest 對外能力仍由已註冊 host handlers 提供。Host bash、Cargo build scripts/proc macros、host handlers 的權限不受此政策限制。

**Cargo 環境（2026-10-02）**：runtime 發起的 Cargo（模板準備、workspace upgrade、cell、skill probe/tests、依賴解析／vendoring）及 Rust toolchain probes/repairs 共用環境變數白名單，只繼承工具鏈、系統路徑與離線設定；skill tests 的 target/build 目錄由 host 另行指定。未列入的 provider credentials、registry tokens、proxy、compiler flags/wrappers 不再從 host 環境繼承，完整名單見 [runtime 文件](packages/coding-agent/docs/rlm-runtime.md#trust-boundary)。這不是編譯沙箱：`include_str!`、build scripts、proc macros 仍可依主機權限存取檔案，Cargo config 也能另行提供環境／credentials；既有產物不會被清除，host bash 與 handlers 的權限不變，不能宣稱 credentials 全面隔離。

**Framing**：newline-delimited JSON（UTF-8，一行一訊息；換行以 `\n`，訊息內字串已由 JSON 轉義）。Guest 每個 stdout frame 加上 `\x1eRLM:<token>:` 前綴；host 分離 protocol 與普通輸出，回覆僅送 private stdin。普通輸出不需以換行結尾，跨 chunk 的 UTF-8 與前綴均保留。stdin 專供 bridge 使用；frame 上限 32 MiB。

```jsonc
// 1. 握手（guest → host，連線後第一則）
{"v": 1, "kind": "hello", "token": "<64-hex>", "cell": "<tool-call-id>"}
// host 回 {"v":1,"kind":"hello_ok"} 或關閉連線

// 2. Host request（guest → host；id 由 guest 遞增）
{"v":1, "kind":"req", "id": 3, "type": "rlm.run",
 "payload": {"prompt": "review the API", "kwargs": {"name": "api-reviewer"}}}
// host 回覆（順序不保證，依 id 對應）
{"v":1, "kind":"res", "id": 3, "status": "ok",
 "payload": {"rlm_child_id":"…","name":"api-reviewer","session_dir":"…","model":"…"}}
{"v":1, "kind":"res", "id": 3, "status": "error", "error": "depth limit reached"}

// 3. Emit（guest → host，fire-and-forget，host 回 ack 以背壓）
{"v":1, "kind":"emit", "id": 4, "type": "display.diff",
 "payload": {"path":"src/a.rs","oldStr":"…","newStr":"…"}}
{"v":1, "kind":"ack", "id": 4}
```

**分派**：`BridgeServer` 收到 `req` → 查 `HostRequestHandlers[type]`（**現有 registry 原封重用**，含 `rlm.run`/`goal.*`/`agent_message.*`/`mcp.*`/`model.info` 全部 handler）→ handler 回傳 JSON → 回 `res`。`cellSourceCode` 注入：BridgeServer 持有當前 cell 的 code（對映 `handleHostRequest` 注入 `activeExecution.code`），供 subagent spawn 顯示歸因。新增 handler：`websearch.run`（§4.1）與 `display.*`（emit 專用，不進 req 路徑）；`deps.add` 已由 runtime 提供上述初版 curated catalog（D15 後續）。

**時序語意**：guest 端 `req` 為同步阻塞（預設 30s 逾時，`rlm::Error::Bridge` 回報；skill tests 與 deps.add 改用 cell budget，見 §4.2／§2.3）。WASI `poll_oneoff` 檢查 stdin readiness，無回覆時每 5ms 重試至 deadline，host cell budget 為硬後盾。傳輸逾時後，下次呼叫重新握手；host 先 abort 舊 generation 的合作式工作並禁止晚到回覆，再回 hello_ok，guest 排除舊回覆後繼續。Request 絕不自動重送；host error 不重建連線。Cell 結束時取消合作式 handler，再等待其他 in-flight handler 收尾（`HOST_REQUEST_DISPOSE_TIMEOUT_MS = 5000`）。Host 持續讀 stdout、獨立處理 handler 並寫 stdin；已完成副作用不回滾。

**對映現制的差異聲明**：現制 comm 允許 cell 結束後的 detached asyncio task 繼續發訊（`onLateSentAgentMessage` LRU 機制）；新制 cell 進程結束即斷線，**無 late message**——這是簡化（一個 cell 的 side effect 隨 cell 終結），`agent_message` 要在 cell 存活期間送出。此語意差異需寫進 prompt（§3）。

**歷史實作註記（WP3，2026-08-06；socket 傳輸已由上述 stdio 取代）**：(1) guest 端 30s 逾時以 non-blocking socket + 5ms poll 迴圈實現（`wasmedge_wasi_socket` 無 read timeout API）；host 端 cellTimeout 為硬後盾。guest 收發 lockstep（每 req/emit 同步等回應），故無 frame 交錯。(2) 傳輸層錯誤丟棄連線、下次呼叫重連；`req` 絕不自動重試（副作用如 spawn 不可重放）；host 回報的錯誤（`status:"error"`）保留連線。(3) `sentAgentMessages` 收據由 host 在 `agent_message.send` 成功時直接合成進 CellResult（取代現制的 iopub MIME 回收）。(4) `rlm::mcp::{list_tools,call_tool}` API 已就位，對應 host handler（host 側 MCP client 代理）隨 WP6 skills 遷移落地。(5) `attach_image` 先不縮圖（WP6 移植），guest 端強制 350K base64 上限。(6) handler registry 於 `_buildRuntime` 建立——與上游 kernel provisioner 同一掛點，controller 後綁（如 headless heartbeat）觸發 rebuild 自動帶入。

- `state.json`：單一 JSON object `{ "<key>": <any JSON> }`；guest 寫入原子（tmp+rename）；單檔軟上限 8 MiB（超過時 `rlm::state::set` 回 `Error::State`，指示改用 blob）。
- `blobs/<name>`：任意 bytes；`keys()`/`list_blobs()` 供盤點。
- State／blob 寫入先在目的檔旁以 `create_dir` 排他建立暫存目錄，寫完後 rename；不覆用既有 `.tmp` 檔、目錄或 symlink。成功或回傳 I/O 錯誤後盡力清理本次暫存；進程被終止可能留下目錄，後續寫入略過，盤點不列出。這不是跨 key 交易或並行 read-modify-write 的保證。
- Host 只讀不寫（compaction 通知、TUI 檢視）；cell 串行執行保證無並發寫者。
- 通知盤點採 best-effort：不存在的 state／blob store 視為空；讀取失敗或 `state.json` 不是有效 JSON object 時明示警告，保留其他可讀項目，不阻斷 resume／compaction，也不修改原資料。Blob 清單與 guest `list_blobs()` 一致，列出所有 regular files（含合法 `.tmp` 名稱），略過目錄與 symlinks；原子寫入的暫存目錄不會列入。舊版殘留的 `.tmp` regular files 無法與合法 blob 區分，因此也會列出，不自動刪除。
- **無跨 session 還原邏輯**：檔案天然持久。取代 `<ipython_state_restored>` 的是 resume 首輪注入：

```
<rust_state_restored>
Your persistent workspace was restored. state keys: {keys}. state blobs: {blobs}. agent_lib functions (source scan): {fns}. agent_lib types (source scan): {types}.
</rust_state_restored>
```

（沒有有效 API cache 時，Host 從 `agent_lib/src/lib.rs` 沿公開模組宣告做來源掃描，列出相對於 `agent_lib` 的路徑。`{fns}` 包含公開自由函式（含 async／const／unsafe）；`{types}` 包含公開 struct／enum／union／type alias／trait（含 unsafe trait）。兩者都涵蓋巢狀、inline modules，標示 source scan；不解析 re-exports、macro 產物，以及帶 cfg／cfg_attr／path 屬性的項目。已有來源指紋相符的 rustdoc JSON cache 時，改列其公開函式／associated functions 與型別名稱、標示 cached rustdoc JSON 及產生時 toolchain；每類最多 64 個名稱並回報省略數。恢復／compaction 只讀 cache，不觸發 Cargo；缺失、失效或損壞時回退 source scan。按需宣告查詢見 §8.2。）

### 2.9 Rich output 與串流

Emit 事件 → `CellEmitEvent` → 直接餵進現有管線的三個型別（`KernelDiffDisplay`/`KernelAttachment`/`KernelSentAgentMessage`，型別沿用、來源從 iopub MIME 換成 bridge emit）：

| Guest API | emit type | 對映現制 MIME | 限制（沿用） |
|---|---|---|---|
| `rlm::display::diff(path, old, new)` | `display.diff` | `…diff+json` | — |
| `rlm::display::attach_image(path)` | `display.attachment` | `…attachment+json` | base64 ≤ 350K（guest 端縮圖至 1200px，移植 attach-image skill 邏輯）；host 硬上限 10M |
| `rlm::msg::send*` | （走 `req` 路徑 `agent_message.send`） | `…agent-message+json` | — |

**實作註記（WP6，2026-08-06）**：縮圖**改在 host 端**（偏離上表「guest 端縮圖」）——host 既有 photon（Rust/WASM）管線含 EXIF 校正與 PNG/JPEG 品質階梯，整組重用；免把影像解碼器連進每個 cell、模板編譯不膨脹。Guest 上限改為原始 20MB（wire 上限 28MB base64，在 32MiB 行守衛內），host 縮至 ≤1200px/≤350K base64 再入 sink。協議 v1 向後相容擴充：`ack` 可帶 `error` 欄（如附件不可解碼/縮不下去），guest 端 emit 回傳 Host 類錯誤且連線保留（與 res error 同語意）。SVG 直通不縮圖。

TUI 渲染：`rust-cell.ts` 元件（§7 WP4）顯示 code（syntax highlight）、串流輸出、diff 卡片、耗時（`compile 0.3s · run 0.01s`）。

### 2.10 `bash` 工具與信任邊界

- 啟用既有 `tools/bash.ts` 為第二個內建工具（`allToolNames = {"rust", "bash"}`）。
- 描述文字補一句分工聲明："Use bash for the project's own commands (tests, builds, package managers). Use rust cells for your own computation."
- 可疊加 OS sandbox：sandbox extension 範例原樣可用（它就是包 bash 的）。
- Approval 政策沿用 prime-agent 現制（bash 工具本身的確認機制）；不在本設計新造。

---

## 3. Prompt 設計

### 3.1 組裝結構（沿用，僅換件）

`buildSystemPrompt` 的組裝順序不動（REPORT §1.9）；`buildRlmPrompt` 換成 `buildRustRlmPrompt`，其餘（harness 區塊、`# Additional Guidance`、Project Context、skills XML）沿用。動態段落對照：

| 現制 | 新制 |
|---|---|
| `Pre-installed Python packages: …` | `Prelude crates: {serde, serde_json, regex, anyhow, chrono, walkdir, …}` |
| `Install additional packages with uv pip install` | `Add crates with rlm::deps::add("name") (host-mediated, wasm-compatible only)` |
| `Installed Python skill modules (pre-imported): …` | `Skills available under agent_lib::skills::{…}` |
| `<available_skills>` 的 `<python_import>` | `<rust_use>` |

### 3.2 `RUST_CONTROL_PROMPT` 草案全文（英文，模型可見）

對映 `IPYTHON_CONTROL_PROMPT`（4,157 字元）逐條重構；粗體標記與 Python 版的心智模型差異點：

```
The rust tool is your control environment: you submit one complete Rust program (a "cell")
per call. It is compiled to wasm32-wasip1 and runs in a WasmEdge sandbox that can see
/workspace (the project), /agent (your persistent library and state), and /scratch.

A cell is a complete program, not a REPL fragment. Start with
`use agent_lib::prelude::*;` and write `fn main() -> Result<()>`. Use `?` freely.
**Variables do not persist between cells.** Persistence has three explicit layers instead:

1. Small data (findings, parsed results, counters, notes, plans):
   `rlm::state::set("key", &value)?` and `let v: Option<T> = rlm::state::get("key")?`.
   State survives cells, turns, compaction, and session restarts. Before re-deriving
   anything, check `rlm::state::keys()?`.
2. Reusable logic: extend your persistent library (crate `agent_lib`, read-only mounted
   at /agent/lib) by passing `lib` files alongside your cell code — they compile together
   with the cell and the same call can already use them. Prefer growing the library over
   re-writing helpers inside cells: cells should read as glue over agent_lib calls.
   If a lib edit fails to build, the files are reverted and the cell does not run —
   extend the library in small, compiling steps.
3. Large data: files under /agent/state (yours) or /workspace (the project's).

Compile errors are normal feedback, not failures. The tool returns rustc diagnostics;
fix the program and resubmit the complete cell. Runtime output returns stdout and stderr
(each truncated at 65536 chars) — print what you need to observe.

Do not assume the sandbox is the native runtime of the thing you are working on.
A repository, package, service, or dataset has its own environment and normal interface.
Run project imports, tests, scripts, CLIs, builds, and dependency checks through the
project's own environment with the bash tool (e.g. `npm test`, `cargo test`,
`uv run ...`), and treat failures from that native environment as the relevant result.

Use rust cells — not bash — for reading, searching, and editing files: the prelude has
read_lines, grep, walk, and edit_exact, and results persisted into rlm::state can be
revisited without re-reading. Reserve bash for the project's own commands, not for file
exploration. Use rust cells to decide what to run and to analyze what comes back.

Example — one call that grows the library and uses it immediately:
  lib: src/helpers/logs.rs
      use crate::prelude::*;
      #[derive(Serialize, Deserialize)]
      pub struct ErrorStats { pub by_kind: BTreeMap<String, u64> }
      pub fn scan_errors(path: &str) -> Result<ErrorStats> { /* read + regex + count */ }
  code:
      use agent_lib::prelude::*;
      fn main() -> Result<()> {
          let stats = helpers::logs::scan_errors("/workspace/app.log")?;
          for (kind, n) in stats.by_kind.iter().take(5) { println!("{n:>6}  {kind}"); }
          rlm::state::set("log_error_stats", &stats)?;
          Ok(())
      }

Capabilities are ordinary Rust calls returning Result, composable into program logic:
- `let h = rlm::spawn("sub-task")?;` admits a child agent and returns immediately with
  a handle (rlm_child_id, name, session_dir, model). It NEVER waits for or returns the
  child's answer; results arrive later through agent messages or files. Name children
  with `rlm::spawn_named("task", "api-reviewer")?`. Spawn independent children in one
  cell, persist their handles into state, then end your turn instead of waiting.
- `rlm::msg::send_to_parent("…")?` replies to your parent when a task calls for an
  answer; `rlm::msg::list_agents()?` discovers family. Send messages before the cell
  ends — a cell's side effects end with the cell.
- `rlm::goal::*`, `rlm::compact::*`, `rlm::refine::*`, `rlm::heartbeat::*` manage
  long-running work (same contracts as the harness documents them).
- `rlm::display::diff(path, old, new)?` and `rlm::display::attach_image(path)?` show
  rich output to the user.
- Continual harness state: `rlm::harness::*` (memories, skills, prompt notes, subagent
  specs). Keep refinements small and evidence-backed; call `rlm::refine::run(None)?`
  when a repeated failure or reusable tactic emerges.

Prelude crates available: {PRELUDE_LABELS}. Use rlm::deps::add("name") for the
curated catalog, then extra::<crate> in a subsequent cell. For other crates, the user can
extend the prelude in settings. Do not work around this by making the sandbox
impersonate the project environment — the project's own tooling runs via bash.

Editing project files: for targeted edits prefer
`edit_exact("/workspace/src/a.rs", old, new)?` from the prelude (exact-match replace,
emits a diff to the user); write whole files with std::fs when generating them.
```

（`{PRELUDE_LABELS}` 由 `WorkspaceManager` 注入，對映 `DEFAULT_RLM_EXTRA_IMPORT_LABELS` 機制。）

### 3.3 遞迴/child/refine 段落

- `buildSubagentGuidance`、child doctrine（`[task from parent]` 標籤、回覆紀律）語意照抄，僅把 call form 換成 `rlm::spawn` / `rlm::msg::send_to_parent`。
- Refine 段落與 harness 區塊的三個 call-contract 變體（refinement.ts:457-461）新增第四變體 `includeRustExamples`，Phase 1 起取代 ipython 變體。

### 3.4 Prompt 尺寸預算

對映現制固定本體 ~10–11KB：`RUST_CONTROL_PROMPT` 草案 ~3.4KB + few-shot 範例 ~0.6KB（D17，PoC A/B 決定去留）+ 開頭段/working dir ~0.8KB + subagent ~0.8KB + harness header ~3.6KB ≈ **9.2KB（~2,350 tokens）**，仍略小於現制。原因：%%bash/%cd/%env、kernel restart、dill 回復等 Python 專屬教義消失；新增的 cell 模型教義較短。

---

## 4. Skills 與自我改進

### 4.1 Skills-as-crates 規格

**偵測**（對映 `detectPythonSkill`，`skills.ts:202-254`）：skill 根目錄含 `SKILL.md` + `Cargo.toml` + `src/lib.rs` → `SkillKind: "rust"`；crate 名 = skill name 的 `-`→`_`（沿用 importName 規則與驗證）。`pyproject.toml` 偵測留存（fork 後 Python skills 降為不支援、給明確診斷）。

**掛載**（取代 venv editable install）：`WorkspaceManager.syncRustSkills()`：

1. workspace `Cargo.toml` 的 members 加入 `[skills 目錄的 path dependency]`（path 指向 skill 原地，**不複製**——等價 editable 語意：改 skill 原始碼、下個 cell 重編譯；成本依程式與快取而定）。
2. `agent_lib/src/skills/mod.rs` 生成 `pub use <crate> as <name>;` re-export。
3. 變更偵測：skill `Cargo.toml` hash 進 `.workspace-version`（對映 `pyprojectHash` 機制）；skill 依賴需通過 vendored registry 或觸發一次 `deps.add` 流程。
4. 失敗策略沿用：單一 skill 編譯失敗 → 從 members 移除 + 警告診斷（不可拖垮整個 workspace——對映「install failure only warns」）。
   掛載前逐 skill 掃描來源指紋；失效 symlink、循環連結或讀取錯誤只卸載該 skill 並回報診斷，其餘 skills 繼續 probe。修復來源後 reload 可重新掛載。
   整體 probe 失敗後，逐 skill probe 的 members／agent_lib 依賴與 re-export 只保留當前候選；來源掛載保留，供 path dependencies 使用。損壞或缺失的 manifest、無法解析的依賴只淘汰該 skill 與依賴它的 skills，不誤卸載無關的健康 skills。
   Scaffold 升級也先在 staged workspace 執行 skill probe，再編譯保留的 cell／library；未被使用的壞 skill 可卸載，保留的程式若仍依賴它，升級仍失敗並保留原 workspace。卸載會移除 symlink 與 manifest／re-export 掛載；child 繼承的實體來源目錄保留，修復後可於 reload 重新掛載。
   掛載狀態以 `agent_lib/Cargo.toml` 的 host 管理區塊為準；保留的 child 來源目錄不代表仍掛載。未掛載的 crate 不參與自動重驗，也不能通過登錄測試；測試指紋、測試 snapshot 與依賴更新暫存樹只讀取當下掛載的 skills，不遍歷已卸載的待修復來源，原 workspace 仍保留它們。已掛載來源或管理區塊損壞時仍拒絕驗證。Child spawn 的完整快照仍複製全部 skill 來源，無法複製時拒絕，不靜默丟棄。
   `.skills-hash` 同時比對實際掛載的類型／symlink 目標、workspace 與 agent_lib manifests、skills re-export 檔；這些設定異動時，reload 重新同步掛載並執行 probe，不因 skill 來源未變就略過。完成同步後才保存新指紋。
5. 掛載範圍（定案）：發現到的 skills **全部掛載**（對映現制全裝進 venv + 全 pre-import）；bundled skills 預編譯進模板，user/project skills 首次進 session 時編譯一次。

**Prompt 呈現**：`<available_skills>` XML 沿用，`<type>rust</type>`、`<rust_use>agent_lib::skills::websearch</rust_use>`；SKILL.md 記載簽名（skill-creator 模板強制）。已配置 rustdoc toolchain 時，可透過 `rlm::api::list(rust_use)`／`describe(path)` 查詢 JSON 宣告（§8.2），prompt 指引按需查詢，不預先注入所有 skill API。

**Bundled skills 的處置**（REPORT §3.4 的表格落地）：

| 現制（13 個） | 新制 |
|---|---|
| goal / agent-message / agent-observe / rlm-heartbeat / compact / refine（host-bridge 薄殼 ×6） | **消失**——成為 `rlm` crate 內建模組（§2.6），零安裝零發現成本 |
| edit | prelude 函式 `edit_exact()`（≈40 行 Rust + diff emit） |
| attach-image | `rlm::display::attach_image`（縮圖邏輯移植 ≈120 行） |
| websearch | rust skill crate（經 `rlm::host_request("websearch.run", …)` 新 handler 走 host 的 Serper key——**key 不進沙箱**，優於現制 `SERPER_API_KEY` 直接注入 kernel env） |
| linear / notion（MCP-backed） | `rlm::mcp::call_tool`（host MCP manager 沿用） |
| prime-intellect / skill-creator（markdown） | skill-creator 全文改寫為 Rust skill 授權指南（§4.3）；prime-intellect 移除 |

**實作註記（WP6，2026-08-06）**：(1) 掛載機制——cargo 要求 members 在 workspace root 之下（站外絕對路徑會被拒），故以 `<workspace>/skills/<crate>` symlink 指向 skill 原地實現「不複製、可編輯」，members/agent_lib deps/`skills/mod.rs` 三面由 host 管理區塊再生；skill crate 以 `[workspace.dependencies]`（rlm＋prelude 五件）宣告 `{ workspace = true }`。(2) 變更偵測以 manifest 內容指紋（`.skills-hash`）；變更時逐 skill probe build，編譯失敗者卸載＋診斷（單一壞 skill 不得癱瘓全部 cell），健康集合重掛。(3) **偏離：bundled skills 不預編譯進模板**——warm 會改寫模板 Cargo.toml，污染 source/dist 的不可變模板；改為 session 首掛時編譯（warm target cache 下實測 ~1–2s，一次性）。(4) 六個 orchestration 薄殼（goal/compact/refine/agent-message/agent-observe/rlm-heartbeat）與 edit/attach-image/linear/notion/prime-intellect 全數刪除；能力閘控改為 controller-driven（`rlmCapabilities` tokens 進 prompt、handler 註冊不再看 skill 可見性）。(5) Python skills 偵測留存：pyproject.toml 無 Cargo.toml → 降級 markdown＋明確診斷。(6) `skills.package` scaffold host request 未實作（§4.2 品質閘 Phase 2 一併）。

### 4.2 agent_lib 自我擴充迴路

模型把重複邏輯升格為函式的完整循環（這是「自我改進」在語言層的形態；D14 宣告式）：

1. 工具呼叫附 `lib` 參數新增 `src/helpers/log_parse.rs`（host 自動維護 `helpers/mod.rs` 的 `pub mod` 宣告，或模型將 mod.rs 一併列入 lib 參數）；**同一呼叫的 cell 立即可 `use`**——lib 與 cell 同次編譯。
2. Guard 即編譯步驟：lib 編不過 → 回滾＋診斷、cell 不跑（§2.1）——迴路天然強制「小步、可編譯」。
3. 升格為正式 skill：skill-creator 指南教模型把成熟的 helpers 搬出成獨立 skill crate + SKILL.md + `#[cfg(test)]` 測試；`skills.package` host request 建立 project-local scaffold，reload 後由既有流程掛載與登錄（實作範圍見下）。
4. **品質閘（D19 定案：Phase 1 soft、Phase 2 強制）**：Phase 1 僅教義要求（refine prompt 與 skill-creator 指南要求先跑 `cargo test`）；Phase 2 以沙箱內測試（`cargo test --target wasm32-wasip1`、wasmedge 為 test runner）升級為 refine `create_skill` handler 的硬驗證。注意：host 在 native 跑模型寫的 test 等於繞沙箱執行任意代碼——**強制閘只能以沙箱內測試實作**，這是 D19 分期的根本原因。

**D19 登錄閘實作（2026-10-01）**：host `/refine`（含 auto-refine、global scope 與回滾重新登錄）對 skill create/update 強制測試當下掛載 crate：在 workspace 副本執行 `cargo test --release --offline --target wasm32-wasip1 --no-run --lib --tests`，再以 WasmEdge 執行產物。要求標準 Rust test harness、至少一個非 ignored 測試通過、所有測試 module 成功；無 runtime、未掛載、編譯／測試失敗、逾時均拒絕該 edit，取消則停止本次 apply。失敗 update 保留原 entry；非 skill edits 與 delete 不需此 gate。測試只有 disposable `/scratch` preopen，沒有 project、state、harness 或 bridge credentials；不跑 doctests，沒有測試覆蓋率／任務正確性保證。預算沿用 `rustCell.cellTimeoutMs`，計入排隊、編譯、執行；初次 runtime provisioning 仍沿原本 lifecycle。

**測試 import 政策（2026-10-01）**：skill 測試不需 bridge，現在於執行任何 test module 之前檢查所有編譯產物，只允許明列的非網路 WASI Preview 1 function imports。WASI socket／DNS、plugin、未知 module/function 或非 function imports 均拒絕，未使用的 import 也不放行。Host 以 JavaScript engine validate/compile module 並檢查 imports，不 instantiate 或執行 guest code；無法驗證（含 host engine 不支援的 Wasm features）同樣拒絕。實際測試仍只由 WasmEdge 以 `--force-interpreter` 執行已檢查的 Wasm code，避免 embedded AOT native payload 取代它；只有 disposable scratch，不傳入任何對外連線的 socket。檢查納入既有時間預算，取消／逾時後不執行測試。此政策於 2026-10-02 共用至一般 cells，bridge 改用 stdio（§2.7）。Host Cargo build scripts/proc macros 的信任邊界不變。

**Guest API 閘（2026-10-01）**：`rlm::harness::{local,global}` 的所有 CRUD、overview 與 refinement event 操作改走 `harness.request`；host 從 session/scope 決定 store，不接受 guest 指定路徑或整份 state。`create_skill`、`update_skill` 與 `update("skill", …)` 由 host 驗證 reference、共用 WasmEdge 測試器、再保存 entry；不接受 guest 自報的測試結果、version/source。一般 update 測試既有 reference，明確 update 測試新 reference。測試後 host 無條件重載 store；同一 entry 在等待期間被修改時拒絕更新，其他 entry 的修改會保留。Skill mutation request 使用 `RLM_CELL_TIMEOUT_MS`（runner 注入）的等待預算，仍受 parent cell 剩餘時間限制。Bridge 以獨立於 payload 的 context 傳遞 AbortSignal；cell deadline、abort、end 或連線關閉會取消此測試。Rust API signatures/schema 不變，但無 bridge 的 standalone guest 現在連非 skill CRUD 也會失敗。

**Harness 檔案邊界（2026-10-01）**：移除 `/agent/harness`、`/agent/harness-global` preopens。Runner 在編譯前與執行前，檢查 `/workspace`、`/agent/state`、`/scratch` 的實際路徑不得涵蓋或落在 local/global harness store 內；解析已存在的 symlink 與尚未建立 store 的祖先，也檢查既存 state-file symlink 目標。專案與 session/agent storage 必須分離；以 home 或包含 session storage 的專案為 cwd 可能被拒絕。此檢查不掃描 host 建立的 hard links，也不提供跨進程交易鎖或抵禦 host 同時更動檔案系統。

**來源重驗（2026-10-04）**：成功測試以 runtime 內的 content fingerprint 快取。每個 cell 套用來源修改前，已測試或 local/global harness 登錄且仍掛載的 skill，若來源、測試、fixtures、workspace manifests/lockfile/config、rlm 或 scaffold version 改變，必須重新通過沙箱測試；reload/resume 清空快取並重測登錄的 skills。Fingerprint 包含 symlink target 內容，排除 `.git` 與 crate-root `target`；不涵蓋任意外部 build inputs、vendor 內容或 host environment。Snapshot／測試期間偵測到來源異動即拒絕，但不提供跨進程檔案鎖。重驗共用 cell deadline，失敗或取消不執行 cell、不套用本次 cell/lib 修改、保留 harness entry；透過 host 檔案工具修復後重試。Mount fingerprint 同步涵蓋來源、tests、fixtures，reload 時可重做 compile probe 並卸載壞 skill；未 probe 的掛載不再被誤認為通過 probe。

**來源掃描取消（2026-10-08）**：skill 註冊／重驗、sandboxed skill／library tests 與 rustdoc query 的 fingerprints 改為非同步目錄遍歷與串流 SHA-256，逐項／逐 chunk 檢查取消，等開啟的檔案關閉後才回報失敗。掃描前後都計入原操作 deadline；取消不快取成功測試，也不當成 rustdoc cache miss 繼續啟動 Cargo。Hash 格式、symlink target、執行權限與排除規則保持相容，既有來源異動檢查保留。Rustdoc JSON 讀取同樣可取消，沿用 32 MiB 上限。Skill mount probes 的 fingerprint、state notices、JSON parse/index 與 dependency recovery 仍有同步工作；來源掃描不提供跨進程原子快照或硬即時取消。

Skill tests 可透過 dev-dependency 使用 `agent_lib`，因此測試指紋也包含 library 來源、fixtures 與 build script，排除其中的 `.git` 與 crate-root `target`。Library 內容改變後，下一個 cell 前會重驗已測試／已登錄且仍掛載的 skills；snapshot／測試期間的 library 異動同樣拒絕驗證。這項 skill 重驗本身不自動產生 library 測試，也不測試當次 cell 的宣告式 lib 修改；後者由下述可選 library 測試閘負責。

**可選 library 測試閘（2026-10-07）**：`rustCell.libraryTestGate` 預設 false；啟用後，含非空 `lib` 的 cell 先在 disposable workspace 套用宣告式修改與 helper index，對 `agent_lib` 執行 release/offline 的 WASI unit／integration tests，所有 module 成功且至少一個非 ignored 測試通過才套用到 live workspace，再走正常 cell build／run。測試共用既有 import 白名單、唯有 `/scratch` 的 preopen，以及 cell deadline／取消／gas／memory 上限；失敗或取消時本次來源修改未套用、cell 不執行、不產生 cell snapshot。測試前後比對原 workspace 與測試副本來源指紋，範圍沿用 skill tests，不提供跨進程檔案鎖或任意外部 build inputs 的驗證。設定經 session／child／SDK／runner 傳遞，reload／重啟生效；非法值拒絕，不默默關閉。Library tests 不快取、不自動產生測試、不跑 doctests，也不在此 gate 重跑所有依賴 library 的 skill tests。

**範圍限制**：未啟用 library 測試閘的一般 cell/lib 修改、沒有 `lib` 修改的 cell，以及未登錄且未測試的 installed skills 仍只有 compile gate；prompt、memory、subagent specs 是資料。host 手動改寫 harness 檔案不等於通過登錄閘；其中已掛載 Rust reference 會在下一個 cell 前重驗。Cargo build scripts/proc macros 仍依既有 host 信任邊界執行；guest 網路限制見 §2.7，不應把這個 gate 描述成全面的惡意程式隔離。

**Skill scaffold（2026-10-02）**：`rlm::skills::package(name, description, instructions, source)` 經 `skills.package` host request 在 project config 的 `skills/<name>/` 建立 SKILL.md、固定 workspace dependencies 的 Cargo.toml 與 src/lib.rs。只建立新 project-local skill；拒絕既有目標、已載入名稱／crate 名衝突、保留名稱與 symlink parents，不接受自訂路徑或 dependencies。回傳 guest path、crate name、use path 與 `requires_reload: true`。此操作不編譯、測試、掛載或登錄；`/reload`／新 session 掛載後，仍須通過上述 harness 測試閘。Global scaffold 與自動 reload 不在此實作範圍。

### 4.3 Harness / refine 修改

- Schema：`reference.type` 接受 `"rust"`；`reference` 欄位 `{type:"rust", use:"agent_lib::skills::x", callable:"run", call_pattern:"agent_lib::skills::x::run(…)?"}`。驗證雙點同步改：`refinement.ts:684-703` 與 guest `rlm::harness`（取代 `harness.py:128-138`）。既有 `"python"` entry 讀取相容（顯示為 legacy、不可新建）。
- `REFINEMENT_SYSTEM_PROMPT`：skill/subagent 段的 call form 換為 `agent_lib::skills::<x>` 與 `rlm::spawn("…")`；「Do not invent wrappers」條款保留原文精神。
- `/refine` 流程、快照/回滾、auto-refine 治理（25 turns / 20min cooldown / compact 觸發）**零修改**。

**歷史實作註記（WP7，2026-08-07；直接 I/O 已由上述 host API 取代）**：(1) `rlm::harness` 直接檔案移植（非 host request）：cells 經 `/agent/harness`（session-local）與 `/agent/harness-global` rw preopens 讀寫 `harness_state.json`，與 host `/refine` 同檔；mtime 再同步防跨進程覆寫（沿 harness.py 語意），存檔 tmp+rename 原子。(2) rust reference 雙點驗證定稿：`{type:"rust", use, callable|call_pattern}`；python reference 讀取相容、拒建（明確 legacy 錯誤，guest 與 refinement.ts 同文）。(3) §3.2 的 `rlm::harness::*` capability 行補進教義（WP4 留白處）；REFINEMENT_SYSTEM_PROMPT skill 段與 JSON 範例改 mounted-crate 契約。(4) wasm 陷阱教訓：`std::process::id()` 在 wasm32-wasip1 直接 trap——原子存檔暫名改以 SystemTime 導出。(5) 時戳無 chrono（固定依賴集），以 civil-from-days 演算法自 SystemTime 導出 ISO-8601。

---

## 5. 遞迴 subagent 與長任務功能

### 5.1 rlm.spawn 遞迴

Host 端 `AgentSession.runRlmChild()` 的 8 步流程（depth 檢查→model 解析→sub-xxxxxxxx 目錄→admission→child runtime→usage 歸帳）**零修改**——它只認 JSON payload。變更僅：

- Child 的 kernel env 鍵沿用（`RLM_DEPTH`、`RLM_MAX_DEPTH`、`RLM_SESSION_DIR`…），由 `RustCellManagerOptions.env` 傳遞。
- Child 是完整 `AgentSession` → 自帶自己的 workspace（`sub-xxxxxxxx/workspace/`）。**繼承策略（D18 定案：spawn 時快照複製）**——child workspace 從 parent 當下的 `agent_lib`（含 helpers 與 skills 掛載）clonefile/reflink 複製，target 快取一併複製（child 首 cell 仍熱）；之後各自演化互不干擾。fan-out 模式「parent 建工具、children 分段執行」因此成立；fan-in 仍走檔案/訊息。child 的 `state/` 從空開始（context 隔離不變）。

**D18 實作註記（2026-10-01）**：spawn admission 前已快照 `agent_lib`、skill sources、scaffold/deps 與 `target/`，放在 child session directory 的 `.rust-workspace-seed/`；child 首次 provision 使用此 seed，後續 reload 保留既有 workspace。Skill symlink 在快照時實體化，避免父子共享可寫來源；child 的 state、cell source、Git history 從新開始。繼承的 skill 目錄即使缺少 `Cargo.toml`，仍以 child 本地來源為準；reload 的 compile probe 會卸載並回報錯誤，保留來源供補回 manifest 後重掛。快取複製採 best-effort reflink，實際是否重編由 Cargo 判定，沒有固定首 cell 延遲保證。此實作取代下方 WP8 歷史註記中的「D18 尚未實作」。

**Snapshot 取消（2026-10-07）**：child seed、sandboxed crate tests、deps.add 與 rustdoc 共用非同步 snapshot；逐項檢查 caller signal，等進行中的檔案複製完成才清理暫存目錄。Child workspace 準備受 parent cell 取消、session disposal 與 `cellTimeoutMs`（預設兩分鐘）約束；取消或失敗不進入 admission，移除本次 child directory 並釋放名稱。`disposeAsync()` 等待 snapshot 與清理；已完成 admission 的 child 仍走原本獨立生命週期。Tests／rustdoc 沿既有 deadline，dependency snapshot 亦計入 handler 預算。一般暫存樹清理改為非同步；單次 copy syscall、同步來源 fingerprints、dependency crash recovery／rollback 仍可能延後取消。來源複製不是跨進程原子快照，guest 隔離與 host 權限界線不變。

- `spawnCode` 歸因：BridgeServer 注入當前 cell code（§2.7）。

### 5.2 Goals / heartbeat / autonomous / compaction

- Goals：`goals.ts` 核心零修改；兩處工具名檢查（`"ipython"` → `"rust"`，含 active-goal 強制啟用邏輯 `agent-session.ts:8610-8613`）。
- Heartbeat/cron/autonomous：零修改（探索確認 runtime-agnostic）。
- Compaction：演算法零修改；`KERNEL_PERSIST_SUMMARY_NOTE` 改寫為「rlm::state 與 agent_lib 在 compaction 後保留，把 state keys 與常用函式記進摘要」；`_notifyKernelStateAfterCompaction` 改呼叫 `listPersistentState()`（§2.2）注入：

```
<rust_state>
Your workspace persisted through compaction. state keys: {keys}. state blobs: {blobs}. agent_lib functions (source scan): {fns}. agent_lib types (source scan): {types}.
</rust_state>
```

Resume／reload 後即使尚未啟動 Rust runtime，compaction 也會直接讀取磁碟上已有 `Cargo.toml` 的 workspace，列出當下 state keys、blob 名稱與 library API；不把 state／blob 值加入通知，也不觸發 toolchain 初始化或 workspace upgrade。尚未建立 workspace 的 session 不發送此通知；child 的初始 seed 不視為已還原的 workspace。

**實作註記（WP5，2026-08-06）**：(1) late-message 機制（`ipython_sent_agent_message` 事件、持久化 entry 重播、TUI 收據補寫）全數刪除——收據於 cell 存活期間由 host 合成進 CellResult（§2.7 註記 3），無晚到路徑。(2) resume 通知 custom type 定名 `rust_state_restored`（WP1 起 AgentSession 已如此發送，本 WP 對齊 renderer 與常數）；compaction 摘要註記改述 rlm::state/blobs/agent_lib 存續。(3) 更名收尾：`Kernel*` 顯示型別→`Cell*`、`_createKernelHostHandlers`→`_createHostRequestHandlers`、`prewarmIpythonKernel`→`prewarmRustWorkspace`（實作自 WP1 即為 toolchain 檢查＋template clone 的 workspace ensure）。(4) goal 續跑/預算/改目標提示、daemon 與更新重啟提示、skills 前言等模型可見字串全面改 rust call form（`rlm::goal::complete()?` 等）。刻意保留：rust-cell/* 與 host-bridge 的世系註解、`includeIpythonExamples` 相容別名、`PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL` 環境變數名（D25 孵化期不動 user-facing env，WP8 一併處理）；`--tools` 對非內建名維持寬容（WP2 定調的 extension allowlist 契約）。

### 5.3 MCP

`mcp-manager.ts` 沿用；呈現層從「動態生成 Python skill」改為 `rlm::mcp` 模組 + skills XML 列出可用 server（`mcp.list_tools`/`mcp.call_tool` host request 型別不變）。

**實作註記（WP6，2026-08-06）**：host 端 MCP client 以官方 `@modelcontextprotocol/sdk`（streamable HTTP）實作，每 server 連線快取、auth 由 host 解析（bearer env var／靜態 headers／OAuth `getApiKey` 自動 refresh）；`mcp.refresh` 與 manager `refresh()` 會作廢快取連線。stdio server 不支援（明確錯誤）；未登入回 cell 可讀錯誤（提示 /mcp login）。呈現改為 prompt 段落列出已啟用 server 與 `rlm::mcp` call forms（非 skills XML 條目——linear/notion skill 目錄已刪，unauthed 覆蓋機制隨之移除）。

---

## 6. Phase 0：PoC 詳細設計

**目的**：在真 prime-agent（未 fork）上回答唯一的高風險問題——**模型能否以 cell=program 模式有效工作**（REPORT §6 風險 1）。範圍刻意砍到最小可量測。

### 6.1 載具與目錄

```
wasmedge-agent/
├── poc/
│   ├── extension/
│   │   ├── package.json         # {"pi":{"extensions":["./index.ts"]}} + 自帶 deps
│   │   ├── index.ts             # registerTool("rust") + registerTool("bash")
│   │   │                        # + before_agent_start（整段換 prompt）
│   │   │                        # + session_start/shutdown（起停 CellRunner）
│   │   └── runtime/
│   │       ├── cell-runner.ts   # §2.2 的極簡版：scaffold+compile+run+state 通知
│   │       └── workspace.ts     # 模板複製、lib 參數套用/回滾（D14）；git commit 可先砍
│   ├── guest/
│   │   ├── rlm/                 # 只含 state + display::diff stub + prelude
│   │   └── template/            # workspace 模板（Cargo.toml、agent_lib、cell）
│   └── bench/                   # §6.3
```

啟動：`prime-agent --no-builtin-tools -e …/poc/extension`（extension 以 `-e/--extension` 載入；註冊 `rust` 與 `bash`——bash 從 SDK 匯出的 `createBashTool` 取得，sandbox 範例已示範此用法）。

**PoC 範圍界定**（明確不做）：無 BridgeServer/spawn/msg/goal（單 agent 任務）、無 TUI 自訂渲染（吃預設文字渲染）、無 skills、無 deps.add（prelude 鎖死）。**做**：cell 編譯執行迴路、`rlm::state`、agent_lib 自我擴充 + guard、prompt v0、串流。

### 6.2 對照組

| 組 | 設定 |
|---|---|
| A（baseline） | 原版 prime-agent，ipython runtime，**預設全功能形態**（不做任何削弱——對照誠實） |
| B（treatment） | 同版本 + PoC extension（rust + bash，prompt 換裝） |

任務環境用**固定 fixture repos**（版本 pin、每 run 從乾淨副本開始）——可重現、兩組公平。

**實作更新（2026-10-04）**：driver 在啟動 agents 前為每個 run 保存完整 task 目錄快照，prompts、timeout、fixture 與驗收腳本均從快照取得；`taskHash` 記錄相對路徑、檔案內容與 executable bits 的 SHA-256 指紋。執行前及驗收前後發現快照異動時記錄 driver error。Analyzer 的 D20 比較要求每個 task 在兩組皆為同一個已知版本；缺少指紋的歷史紀錄仍可呈現量測，但不產生新 verdict。此機制固定任務輸入，未固定 provider settings、agent binary 或外部工具鏈，也不是 host 安全隔離。

同模型、同任務、同 settings；每 (任務, 模型, 組) 跑 3 次取中位。模型：Claude（sonnet 級與 opus/fable 級各一）+ 一個開源權重模型（經 openrouter），共 3 家交叉驗證（REPORT §6 風險 7）。

**Provider config 快照（2026-10-04）**：driver 在規劃前只讀取一次 seed `models.json`，每個 run 保存相同 bytes 的快照，並以此建立 active config；`providerConfigHash` 記錄 SHA-256。執行前、各 turn 前後、驗收前後偵測快照或 active config 異動即記錄 driver error。Analyzer 要求同一 condition 的所有 runs 與同模型 baseline 使用一致的已知指紋，否則只保留量測、不產生 D20 verdict。原始快照可能含 credentials，以 `0600` 寫入 gitignored results；metadata／CSV 僅記錄指紋。此機制只固定設定檔 bytes，未固定環境變數、credential commands、provider 端路由／model aliases、agent defaults、binary 或工具鏈，也不保證不同 agent 版本對設定檔的解讀相同；不構成 host 隔離。

**Agent 啟動入口（2026-10-05）**：規劃前解析選定 launchers 的絕對 invocation path、symlink target 與 SHA-256，保存於 plan／run metadata；daemon 和 clients 均使用該 path。Setup／launch、各 turn 與驗收邊界重新檢查內容、target 與 executable access，變動即 driver error。Resume 對全部 pending slots 先檢查，不重新以目前的 `BENCH_PRIME_AGENT` 或 PATH 選擇入口；新 plans 使用 `launcherPinVersion: 1`，缺少標記的舊 plans 僅供分析、不續跑。Analyzer 拒絕同 condition 內混用 launcher identities 或比較中混合有／無 pin 的證據；全為舊證據時保留既有判準並明示未驗證 launcher。這僅固定入口檔案；額外來源的選配宣告見下方，不代表完整 runtime 可重現；turn 邊界檢查的耗時包含於 wallMs。

**宣告式來源驗證（2026-10-05）**：`--source-inputs <manifest.json>` 為每個選定組別列出檔案／目錄，規劃前記錄絕對 path、resolved root 與遞迴內容／executable bits 的 SHA-256。Setup／launch、turn 與驗收邊界核對，resume 先核對全部 pending inputs；變動即 driver error，已完成紀錄不需保留目前的來源。新 plans 使用 `sourcePinVersion: 1`，未宣告時明記 `sourceInputs: null`。Analyzer 拒絕同 condition 不同來源版本、path set 或有／無 pin 混用；全為未宣告／舊證據仍按既有規則分析並標示限制。只驗證操作人列出的 inputs，不自動發現 wrapper／extension／packages 依賴，不 snapshot／隔離 host；目錄無 ignore 規則、拒絕 nested symlinks 與 results overlap，大型目錄 hashing 會增加 wallMs。未宣告的來源、toolchain、環境與 provider routing 仍未固定。

**Treatment 組內部 sub-A/B（D17）**：prompt 有/無 few-shot 範例兩版各跑一半，判準為首個 cell 的 compile-error 率與整體修錯輪數；勝者定案進 Phase 1 prompt。此 sub-A/B 不增加對 baseline 的比較組數。

### 6.3 Benchmark 任務集（12 項）與量測

任務類別（每類 2–3 項，各附自動驗收腳本 `check.sh`，退出碼判定成功）：

1. **檔案/文本處理**：log 解析統計、多檔 grep-and-transform、CSV→JSON 正規化。
2. **程式修改**：中型 repo 定位並修 bug（測試轉綠）、跨檔 rename 重構。
3. **多步驟 + 狀態重用**：兩回合任務——第一回合分析（結論入 state）、使用者追問後第二回合基於 state 續作（**專測持久層 ergonomics**）。
4. **工具鏈組合**：跑專案測試→解析失敗→修→複跑（bash+rust 分工）。
5. **能力累積**：三個相似小任務連發，觀察模型是否把共用邏輯升格進 agent_lib（**專測自我擴充迴路**）。

指標（全部可從 session JSONL 離線萃取，`bench/analyze.ts`）：

| 指標 | 來源 | Phase 1 目標／驗收方式 |
|---|---|---|
| 任務成功率 | check.sh | ≥ baseline − 15pp |
| 每任務 token（in/out 分列） | usage entries | ≤ 2.0 × baseline（D20 採 output tokens） |
| 每任務 cell 數與 compile-error cell 佔比 | tool results | 觀測值（無閾值；預期 error 佔比 20–40%） |
| 每 cell runner 延遲 p50/p95（不含 provisioning／同 runner 排隊） | details.durationMs | 觀測／調校目標：p50 ≤ 1s |
| 修錯收斂：compile error 後至成功的平均輪數 | 序列分析 | 觀測／調校目標：≤ 2，另列未收斂錯誤 |
| 質性：state/agent_lib 使用率、每 cell 重算率 | 人工複盤 trajectory | 報告記錄 |

**Runtime 計時（2026-10-07）**：新結果以 monotonic clock 記錄 version 1 `details.timings`，拆分來源準備、skill 驗證、library test gate、build permit 等待、Cargo、rollback、import policy、probe、WasmEdge execution、bridge cleanup、Git snapshot 與其餘時間；各階段總和為 runner `durationMs`。同 runner 排隊另列 `queueMs`；tool wrapper 另記 provisioning 與 total，均不改 cell deadline 範圍。Execution 包含程序啟動和 host handler 等待，不能當成 guest CPU 或模型閱讀 diagnostics 的時間。Analyzer 彙整逐 cell phase p50/p95、回報 coverage，缺欄位／壞資料不補零；不改 D20 gate。`poc/bench/runtime.ts` 提供不呼叫模型的序列 microbenchmark，環境、來源指紋及逐筆資料獨立保存；不取代 D21 正式對照量測。欄位與重跑方式見 runtime 文件與 bench README。

**Exit 判準（D20 已確認）**（→ Phase 1 GO）：成功率與 token 閾值同時達標於 ≥2 家模型；未達標 → 回修 prompt/prelude 一輪（≤1 週）再測；仍未達 → 升級決策（範圍收窄為 systems-agent 場景或轉選項 C 重新評估）。模型組合依 D21：Claude sonnet 級 + opus/fable 級 + 開源權重一家。

**D20 整體摘要（2026-10-04）**：analyzer 除逐模型判定，另對 F 與每個 B prompt variant 分別輸出整體結果；同一模型的 repetitions 不重複計數，也不混用不同 treatment 的通過模型。該 treatment 或 A 中已記錄的模型都必須有完整、可比較的兩組資料，且跨模型 task IDs、versions、相對比重一致；任一缺漏／不一致即不下整體 verdict。資料完整且至少兩個不同 model IDs 同時通過成功率與 output-token 閾值才是 GO，完整但通過數不足為 NO-GO；模型總數不足兩個仍屬資料不足。這是已記錄選集的閾值摘要，未驗證 D21 的完整模型組合、12 tasks／3 repetitions、model aliases、provider settings 或 toolchain；亦無法找回連同 plan 一起遺失或從未登錄的模型／runs。Latency 與 recovery 仍為觀測／調校目標，不加入 D20 放行閘。

**Run inventory（2026-10-04）**：driver 為每次 invocation 在第一個 agent 啟動前原子寫入獨立的 `results/plans/<planId>.json`，保存所有預定 run IDs、task/model/group/variant/rep 與 task/provider config 指紋；每筆 metadata 記錄 `planId`。Analyzer 比對清單與實際紀錄，偵測整批模型或單筆 run 遺失、重複、欄位不符、plan 遺失或格式錯誤時，停止該 results 目錄的所有 D20 verdict，保留可讀的量測並列出問題。舊紀錄缺少 plan 時仍依既有證據檢查，不推定完整性。這是所選 matrix 的本機登錄清單，不防竄改。

**Plan 續跑（2026-10-05）**：`run.ts --plan-only` 保存完整計畫與快照，不啟動 agent；`--resume-plan <planId>` 先核對全部清單紀錄與尚未執行的快照，再沿原順序執行沒有啟動痕跡的 `planned` slots，保留 run IDs、rep／variant 與既有 inventory。Completed／running／error 紀錄均不重跑；running／error 保留原始證據並使續跑 exit nonzero。新 plan 以 `executionLockVersion: 1` 宣告鎖協議，首次與後續執行均持有獨佔檔案鎖；強制中止後由操作人確認 driver 與殘留 benchmark processes 已停止，才移除該 plan 的 stale lock。未參與鎖協議的舊 plans 不支援續跑；另須具備 §6.2 的 `launcherPinVersion: 1` 啟動入口 pin。此功能不重試已嘗試的 run、不續接 partial conversation；來源可依 §6.2 選配宣告驗證；未宣告的 source／toolchain／環境／provider routing 仍未固定。格式、恢復流程與限制見 `poc/bench/README.md`。

**D21 選集檢查（2026-10-05）**：`analyze.ts --d21 profile.json` 可要求完整 matrix：12 個固定 task IDs × 明列 sonnet／opus／openWeight 角色的 3 個不同 model IDs × A 與指定 treatment × repetitions 1–3，共 216 筆 completed、具有效 inventory 的紀錄。缺漏、額外或重複 slot 均停止所有 D20 verdict；不同 plans 不可重複同一 slot。支援 F、B/example、B/noexample 及 B/split；split 按 driver 使用奇數 rep 的 example 與偶數 rep 的 noexample，D20 仍逐 variant 判定。完整 coverage 不代表通過 D20：任務版本、設定指紋、驗收與 usage 證據仍須完整可比較，至少兩個模型同時達標；此模式只有所有指定 variants 整體 GO 才 exit 0。未加此旗標仍是前述已記錄選集摘要。Profile 的模型角色由操作人宣告，不驗證 provider aliases、實際模型家族／開源權重身分、環境設定或 toolchain；這項實作也不補足尚未執行的正式量測。格式與細節見 `poc/bench/README.md`。

---

## 7. Phase 1：Fork 手術計畫

### 7.1 Repo 策略

- **（D22 定案）**M1 GO 後 fork 至 **`hydai/wasmedge-agent`**（個人 repo 低調進行，失敗成本低）；M5 MVP 驗收通過後 transfer 至 second-state org 正式化。保留 `upstream` remote。
- **（D23 定案）**獨立發展，不預先與上游協調 runtime 抽象層——保持開發自主與節奏，接受長期 SYNC 稅（§7.3 即為此而設計）；設計成熟後歡迎與上游探討合流。
- **（D24 定案，修訂 D22 執行細節）**不用 GitHub fork 機制（fork 強制公開、issues/搜尋受限、badge+改名觀感差）。改以**吸收合併**：在既有 wasmedge-agent repo `git merge --allow-unrelated-histories upstream/main`，單一 repo 保雙邊完整歷史；GitHub 開 **private** repo；attribution 以根 README 顯著鳴謝 Prime Intellect（prime-agent）與 badlogic（pi）——正是 prime-agent 對 pi-mono 的既有先例。
- **（D25 定案，修訂本節原「只改 bin 名與品牌字串」）**M2–M4 孵化期**零改名**：bin、`piConfig.name`、env prefix（`PRIME_AGENT_*`）、config 目錄全部照舊（bench/文件/SYNC 零陣痛）；身分僅靠 repo 名與根 README。完整 rebrand（含 config 目錄遷移邏輯）於 M5 一次專門 commit 完成。根 README 是孵化期唯一允許的身分檔案改動。
- Package 更名：`@earendil-works/pi-*` 依賴關係保留（沿用上游做法——他們 fork 後也沒改依賴名），只改 `coding-agent` 的 bin 名與品牌字串；正式命名見 §11 D10。
- PoC 產物遷移：`poc/runtime/*` 升格為 `packages/coding-agent/src/core/rust-cell/`；`poc/guest/` 升格為 repo 頂層 `wasmedge-agent-runtime/`（位置對映 `prime-agent-runtime/`，`copy-assets` 腳本同機制打包模板）。

### 7.2 工作包分解（WP1–WP9，依 REPORT §1.12 耦合表逐項對應）

| WP | 內容 | 動作對象 | 規模/依賴 |
|---|---|---|---|
| **WP1 骨架** | 刪 `core/kernel/`（index/bootstrap/fork-server/state-snapshot/boot-gate，3,329 行）與 `prime-agent-runtime/`；`tools/index.ts` 咽喉點改 `ToolName = "rust" \| "bash"`；`cli/args.ts` `BUILTIN_TOOL_NAMES`；刪 zeromq 依賴 | 刪除為主 | 3 天；無依賴 |
| **WP2 Cell 引擎** | `core/rust-cell/`：WorkspaceManager、CompilePipeline、ExecPipeline、compile gate、`tools/rust.ts`（§2.2–2.5）；PoC 程式碼工業化（逾時/中斷/串流/git 守護） | 新寫 ~3K | 1.5 週；WP1 |
| **WP3 Bridge** | BridgeServer + 協議 v1（§2.7）；`_createKernelHostHandlers` 改接 BridgeServer（handler 本體零改）；guest `rlm` crate 全模組（§2.6）；`websearch.run` 新 handler（deps.add 不做——D15） | 新寫 ~1.5K TS + ~1.5K Rust | 1.5 週；WP2 |
| **WP4 呈現層** | `prompts/rust-rlm.ts`（§3 定稿）；`system-prompt.ts` 的 `hasIpython`→`hasRust` 分支；`code-preview.ts` Rust regex；`rust-cell.ts` 渲染元件（取代 ipython-cell.ts 712 行）；`tool-execution.ts`/`interactive-mode.ts` 分派；ACP 對映（title "Rust cell"、`_meta` 鍵） | 重寫 ~1.5K | 1 週；WP2 |
| **WP5 狀態通知** | compaction/resume/goal 通知改寫（§5.2、§2.8）；`agent-session.ts` 85 處耦合點清理（provisioner 型別、`_onIpythonStateRestored`→`_onWorkspaceRestored`、late-message 機制刪除、prewarm 改 workspace ensure） | 散改 | 1 週；WP2–3 |
| **WP6 Skills** | `skills.ts`：`SkillKind: "rust"` 偵測/掛載（§4.1）；`syncRustSkills`；bundled skills 替換（6 個入 crate、edit/attach 入 prelude、websearch crate、MCP 模組）；skill-creator 改寫 | 改 ~0.6K + 新 Rust | 1 週；WP3 |
| **WP7 Harness** | `reference.type: "rust"` 雙點驗證、refinement prompts 更新、`rlm::harness` 移植（mtime 同步） | 改 ~0.3K | 3 天；WP3 |
| **WP8 安裝/組態** | installer（venv 段 → rustup target + wasmedge 檢查 + 模板預建 + vendor）、postinstall、doctor 增 toolchain 檢查、env vars 更名（§10）、docs 全面改寫（rlm.md/rlm-runtime.md/skills.md/quickstart/…） | 改寫 | 1 週；WP2 |
| **WP9 測試/驗收** | 17 個 kernel 測試檔替換為 rust-cell 套件（§9）；faux-provider suite 適配；dogfood 驗收 | 測試 | 1 週；全部 |

關鍵路徑：WP1→WP2→WP3→WP5→WP9（約 6 週）；WP4/WP6/WP7/WP8 可並行插入（單人全職總計 7–8 週，與 REPORT 估計一致）。

### 7.3 上游同步策略（`SYNC.md`）

- **我方獨占區**（上游永不碰）：`core/rust-cell/`、`prompts/rust-rlm.ts`、`wasmedge-agent-runtime/`、`rust-cell.ts` → 零衝突。
- **上游直收區**：`packages/{ai,agent,tui}`、daemon/session/cron/autonomous → 每月 cherry-pick 窗口直接收。
- **手術點清單**：`SYNC.md` 維護散改點（agent-session 85 處、system-prompt、skills.ts、tools/index、ACP…）的 our-side diff 摘要；上游動到這些檔案時按清單人工 rebase。
- 上游大版本（minor：API breaking）→ 開一次專門的同步衝刺評估。

---

## 8. Phase 2：概要設計

### 8.1 T2 Runner（host functions 形態）

一個 ~1K 行的 Rust binary `wasmedge-cell-runner`，內嵌 WasmEdge（C API）：

- Host module `rlm_host`：`host_request(ptr,len)→(ptr,len)`、`emit(kind,ptr,len)`、`log(ptr,len)`；guest `rlm` crate 的 bridge 後端從 stdio 換 host function（**crate API 不變**，cell 程式零感知——這是 §2.6 全同步 API 設計的回報）。
- Runner ↔ TS host：stdio JSON-RPC（協議 v1 語意平移；框架欄位 `kind` 沿用）。
- 新能力：gas metering（statistics cost limit，`cellGasLimit` 設定）、memory page limit、`WasmEdge_Async*` cancel（interrupt 不再 SIGKILL、可拿部分輸出）、**host module 直接提供 guest bridge 能力**（網路 imports 的 admission policy 已於 CLI runner 落實，見 §2.7）。
- 部署：runner 隨 npm 包分發 prebuilt binaries（對映上游 build-binaries.yml 機制）。

**資源上限提前落實於 T1（2026-10-01）**：stock WasmEdge CLI 已提供 `--gas-limit` 與 `--memory-page-limit`，因此不用等待 T2。`rustCell.cellGasLimit`（1–4294967295）及 `cellMemoryPageLimit`（1–65536，每頁 64 KiB）現在由 session、獨立 SDK tool、runner 與 sandboxed skill tests 共用；每個 cell／test module 各有獨立上限。預設省略／null 保留 runtime 預設，無效值拒絕啟動 runtime，不靜默降級；gas 上限刻意限於 uint32 範圍，避免 WasmEdge 0.14.1 CLI 的窄化轉型。Gas 耗盡是 runtime error，memory.grow 超限回失敗值（guest 可處理），過小的 memory cap 也可能導致初始化或配置失敗。Memory cap 是每個 linear memory 的頁數，不是 RSS／compiler／host handler／所有 children 的總額；timeout 照常執行。T2 host functions 與 Async cancel 仍未完成；guest 網路限制已於 2026-10-02 以 stdio bridge + import 白名單提前落實（§2.7）。

**Cargo 編譯沙箱（2026-10-07）**：`rustCell.cargoSandbox: "off" | "bubblewrap"`，預設 off；Linux 可選 Bubblewrap 0.8+ 與 unprivileged user namespaces。Runtime 的 template／scaffold／cell／skill tests／library tests／rustdoc／dependency build 共用政策：來源與工具鏈唯讀、Cargo.lock 與獨立 `target/cargo-sandbox/` 可寫、private tmp/home/proc、編譯無網路，失敗不回退。Git／state／scratch 與未隔離 target 不掛入；host 管理的 vendoring 另允許 network、vendor 目錄與 registry cache 寫入。取消 runtime commands（含初始化 Cargo）會終止沙箱內 descendants。macOS 尚不支援。這只隔離 compiler subprocess，host provisioning／source copying、doctor／toolchain repairs、bash 與 handlers 仍有 host 權限；不提供 RSS／CPU／disk 總額限制或整條 pipeline 的 credentials 保證。完整 mounts、cache 與相容性限制見 [runtime 文件](packages/coding-agent/docs/rlm-runtime.md#cargo-sandbox)。

**Process 資源限制（2026-10-07）**：`rustCell.processLimits` 預設關閉；Linux 可選 systemd 254+ user scopes 與 cgroup v2，且要求 `cargoSandbox: "bubblewrap"`。`memoryMaxMb` 限制單次 invocation 與 descendants 的 charged memory（含 file cache、禁 swap、OOM 整組終止），`cpuQuotaPercent` 限 CPU bandwidth，`tasksMax` 限 processes＋threads。每次啟動先核對 kernel controls，不可用即失敗、無 uncapped fallback。Runtime Cargo／WasmEdge（含 tests、rustdoc、vendor 與 template 準備）共用政策，session／children／SDK 傳遞；每個 invocation 各有額度，並非 RSS 精確上限、整棵 agent tree 的總預算或 disk quota。Host handlers／bash／source copying／toolchain probes／doctor 不在額度內；初始化取消邊界見 §2.2。詳見 [process resource limits](packages/coding-agent/docs/rlm-runtime.md#process-resource-limits)。

**Agent tree 共用資源限制（2026-10-07）**：`rustCell.treeProcessLimits` 使用同樣三個欄位與 Linux／Bubblewrap 前提，預設關閉；每棵 live root tree 配一個 systemd user slice，所有 runtime invocation scopes（含 parent、inline／hosted children、daemon child rehydration 與 bridge-triggered Cargo）共用總額。可與每次 invocation 的 `processLimits` 同時啟用，每次 launch 檢查 scope 及 parent slice 的 kernel controls。Root 建立時固定政策；reload／child replacement 沿用，整棵 tree restart 才重新套用設定。所有 session references 釋放後停止並清除該 slice；host crash 可能留下 runtime unit properties 到 user manager 結束。Memory 超額可能終止個別 invocation，非 tree 原子式取消；CPU 是 bandwidth、不是持久化累計時間；host／bash／handlers 不計入，disk quota 尚未實作。

### 8.2 其他

- **Curated deps.add（D15 後續，已落實）**：30 個精確版本 crate；host 抓取／re-vendor、離線驗證與 commit，失敗回復，resume／child 重用 vendor，細節見 §2.3 實作註記。Catalog 後續擴充需增加 WASI API 測試。
- **AOT 快取**：`agent_lib` 與 skills 變更時背景 `wasmedge compile`；cell 仍 interpreter（短命，AOT 不划算）。
- **rustdoc JSON 按需查詢（2026-10-07）**：`rustCell.rustdocToolchain` 預設 null；指定已安裝 toolchain 後，`rlm::api::{list,list_page,describe}` 透過 `api.describe` host handler 回傳 `agent_lib`／掛載 skills／`rlm` 的公開路徑與結構化宣告，包含 signatures、generics、fields、variants、associated items、local re-exports、macro 產物與 WASI target cfg。固定 `nightly-2026-09-25` 驗證 JSON format 61；其他格式明確拒絕，不自動安裝／下載／換 compiler。Host 在 disposable snapshot release/offline/locked 產生文件，前後比對來源指紋；失敗、取消或來源變更不發布 cache。快取於 `target/.agent-api.json`，查詢比對 source／toolchain／rustc version，resume／compaction 僅比對 source 並標示 cache 來源；資料不納入 Git。Query 分頁、檔案與索引大小有界。第三方依賴缺少 JSON 時標 external re-export；不枚舉 synthetic／blanket impls。Rustdoc 的 `cfg(doc)`、不完整函式本體檢查與 nightly compiler 不等於 cell build 驗證；Cargo／proc macros 仍有 host 權限，guest gas／memory 上限不限制文件編譯。外部 build inputs、vendor 內容與跨進程檔案鎖不在指紋保證內。操作與限制見 `packages/coding-agent/docs/rlm-runtime.md`。
- **Workspace 唯讀模式（已落實，2026-10-05）**：`rustCell.workspaceWritePolicy: "rw" | "ro"`，預設 rw；ro 時以 WasmEdge `:readonly` 掛載 `/workspace`，教義改為產 patch，由既有 host bash 套用；無 bash 時交回 caller。設定經 session／child／SDK／runner 傳遞，修改後 restart 或 `/reload`；無效值拒絕啟動。`/agent/state`、`/scratch` 與宣告式 lib 修改仍可寫。編譯與執行前檢查 state/scratch 不得與 project 重疊（含 symlink root），拒絕含冒號的 host mount 路徑以避免 CLI 解析歧義，沒有 rw fallback。此限制只涵蓋 guest execution；Cargo、bash、host handlers 保留 host 權限，host hard links／並行 filesystem 變更不在保證內。未增加 patch approval gate，也尚未實作 trajectory replay。
- **沙箱內測試**：host `/refine` 的 skill create/update gate 已落實（§4.2）；guest skill CRUD 已經 host 儲存並移除 harness preopens；測試 import 白名單已拒絕網路能力。Project-local `skills.package` scaffold 已落實，reload 與登錄測試仍分開執行；一般 cell 已共用 import 白名單並改用 stdio bridge（§2.7）。
- Windows 評估、polars wasm 驗證（研究場景擴張的前提）、component model 追蹤（skills as components）。

---

## 9. 測試與驗證策略

| 層 | 內容 | 工具/位置 |
|---|---|---|
| 單元（TS） | workspace scaffold/版本 marker/守護回滾、compile 診斷解析、bridge framing/token/逾時、state 通知組裝 | vitest，`core/rust-cell/*.test.ts` |
| 單元（Rust） | `rlm::state` 原子性、harness bridge 契約、display 縮圖、error 對映 | `cargo test`（native target 跑 guest 邏輯，bridge 以 mock） |
| 整合 | 真 cargo+wasmedge 的 cell 往返（成功/編譯錯/panic/逾時/中斷）、bridge e2e（fake handlers）、lib guard 回滾、resume 後 state 通知 | 專用 CI job（裝 rustup target + wasmedge；~2 分鐘） |
| Suite | 沿用 `test/suite/harness.ts` + faux provider：腳本化模型回覆驅動 `rust` tool 全流程（**不花真 token**，上游既有機制） | `test/suite/rust-cell/` |
| 回歸 | 對映上游 `regressions/` 慣例 | 同上游 |
| 驗收 | Phase 0 bench 集在 fork 上複跑（成績不得低於 PoC）；dogfood：用 wasmedge-agent 開發 WP6–WP8 | 人工 + bench |

CI 注意：kernel 測試刪除後，上游 `test:kernel` script 位置換 `test:rust-cell`；macOS + Linux runner 各跑整合層。

**實作註記（WP9，2026-08-07）**：(1) 整合層失敗路徑補齊（`rust-cell-failure-paths.test.ts`）：compile_error＋診斷、壞 lib 原子回滾（workspace 恆可編譯）、panic→"error"＋stderr、排隊/執行中 abort→"aborted"、spin cell 吃盡 compile+run 共同預算→"timeout"。(2) Suite 層落地 `test/suite/rust-cell/`：faux provider 腳本回覆驅動**真** `createRustTool`（真編譯、真 WasmEdge）過 AgentSession——檔案落地、`rlm::state` 跨 cell 持久、compile error 入 toolResult 不斷 turn；與整合測試同閘（toolchain 缺即 skip），故也跑在專用 CI job。(3) `test:rust-cell` script＝`vitest --run test/rust-cell- test/suite/rust-cell/`。(4) CI 新 job `test-rust-cell`（ubuntu＋macos matrix）：rustup target、WasmEdge 官方 script 釘 0.14.1（workspace-local prefix）、cargo/template cache（key=模板 Cargo.lock）、vendor→warm→硬斷言 cell.wasm 與 wasmedge 存在（防 skip 造成的空綠）、guest crate native `cargo test --target $(host)`、最後 `test:rust-cell`；`build-check-test` 聚合閘納入。(5) 教義事實更正入文件：WASI 無 cwd，cell 以 `/workspace/...` 絕對路徑取專案（suite 測試踩出、rlm-runtime.md 已補）。驗收殘項（人工）：bench 複跑與 dogfood 需真 token／使用者參與，另行提案。

## 10. 組態與部署

**Env vars**（對映現制 7 個 `PRIME_AGENT_KERNEL_*`）：

| 新 | 語意 | 對映 |
|---|---|---|
| `WASMEDGE_AGENT_WASMEDGE` | wasmedge 執行檔路徑覆寫 | `PRIME_AGENT_KERNEL_PYTHON` |
| `WASMEDGE_AGENT_TOOLCHAIN` | cargo/rustup 路徑覆寫 | — |
| `WASMEDGE_AGENT_TEMPLATE_DIR` | workspace 模板位置 | `PRIME_AGENT_KERNEL_VENV` |
| `WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS` | compile gate | `…MAX_CONCURRENT_KERNEL_BOOTS` |
| `WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL` | postinstall 預建模板/vendor | `…BOOTSTRAP_KERNEL_ON_INSTALL` |

**settings.json** 新段：

```jsonc
"rustCell": {
  "cellTimeoutMs": 120000,
  "workspaceWritePolicy": "rw",      // 可選 "ro"，僅限 guest execution
  "preludeExtra": [],                 // 追加 crate（仍過 wasm 相容檢查）
  "cellGasLimit": null,               // T1 已支援，預設不另設上限
  "cellMemoryPageLimit": null         // 每個 linear memory 的 64 KiB 頁數
}
```

**Installer/doctor**：installer 的 kernel 段改為（a）rustup + `wasm32-wasip1` target 檢查/引導安裝、（b）wasmedge 檢查/引導（官方 install script）、（c）模板 workspace 預建 + `cargo vendor`（一次性 ~1–2 分鐘，對映現制 "setting up python kernel (one-time, ~30s)"）；`doctor` 增列 toolchain/模板/vendor 三檢查與 `--fix`。

**實作註記（WP8，2026-08-07）**：(1) env 面定案——`WASMEDGE_AGENT_WASMEDGE`（WP1 起）、`WASMEDGE_AGENT_TEMPLATE_DIR`（顯式 override，指錯即報錯不回退）、`WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS`、`WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL`（postinstall＋installer 同步換名，舊名不留相容）；表中 `WASMEDGE_AGENT_TOOLCHAIN` 實作為 **`WASMEDGE_AGENT_CARGO`**（指 binary 比指目錄精確；rustup 另由 PATH/`~/.cargo/bin` 解析，無 rustup（發行版 Rust）時跳過 target 預檢、讓 cargo build 錯誤自然浮現）。(2) build gate 為 in-process semaphore（boot-gate 後繼）：cargo 內部本就平行，故預設僅 2–8（cores/2），顯式覆寫封頂 32；排隊時間誠實計入 cell 預算，排隊中 abort 走一般 "aborted" 結果。(3) settings 僅落 `rustCell.cellTimeoutMs`；`workspaceWritePolicy`/`cellGasLimit` 維持 Phase 2，`preludeExtra` 需 re-vendor 流程、順延。(4) vendor 定案：redirect config（`[source.vendored-sources]`）**提交進模板** `.cargo/config.toml`（與既有 `[build] target` 同檔），`vendorTemplate` 只生成 `vendor/`（tmp+rename 原子化）；空 `CARGO_HOME` 下 clone 建 cell 5 秒過＝hermetic 實證；vendor 不進 git 也不進 dist（安裝時生成）；教訓：cargo vendor 印出的 config **絕不可覆寫**既有檔——曾把 `build.target` 蓋掉導致 host-triple 編譯、跑到舊 wasm。模板手動 `cargo` 操作（含 rlm native test）現在需先 vendored 一次（`doctor --fix` 可代勞）。(5) installer 流程：confirm →（缺則）官方 rustup script（`--target wasm32-wasip1`）→（缺則）官方 WasmEdge script → npm install 帶 `WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL=1`；任一引導被拒即降級為「首次 cell 使用時準備」，不擋安裝。(6) doctor 六檢查（cargo、target、wasmedge＋版本、模板位置、vendor、warm）永不 throw；`--fix` 修可修者（target add、vendor＋warm），缺編譯器僅給指引；`--json` 恆為單一文件（`{runtime, daemons}`；`--fix --json` 為 `{runtime, fixes, reaped, skipped}`，reap 核心抽為回傳資料的 `performReap`）——ENG-4603 的 CLI 契約測試釘死單文件輸出，該測試同步更新並以 `WASMEDGE_AGENT_TEMPLATE_DIR` 指向極小假 template，使 `--fix` 在測試中永不 vendor/建置真模板。(7) docs 全面改寫（rlm/rlm-runtime/skills/mcp-integrations 重寫＋13 檔掃殘），範例逐一對過 guest API 簽名；D18 child agent_lib 快照**尚未實作**，文件如實寫「child 從模板起新 workspace」。D25 品牌字串（prime-agent 名、安裝 URL）不動。

| # | 決策 | 理由 / 替代案 |
|---|---|---|
| D1 | Cell 語言僅 Rust（Phase 0–2） | 聚焦教義與 prelude 品質；`CompilePipeline` 保持 driver 介面（語言→toolchain 命令）以備擴充。替代案「任何 wasm 語言」推遲到 component model 時代 |
| D2 ✅ | `/workspace` 預設可寫，ro+patch 可選 | 與現制行為對齊、PoC 對照公平；`rustCell.workspaceWritePolicy: "ro"` 限制 guest 寫入，patch 由既有 host 工具套用（§8.2）。不限制 host pipeline，也不代表 replay 已完成 |
| D3 | T1 socket 起步 → CLI + stdio 過渡（2026-10-02）→ T2 host functions | 保留同步 guest API 與協議 v1；stdio 先移除 socket 需求，不新增 native binary 部署面（§2.7） |
| D4 | Bridge 認證用 bearer token（非 HMAC 逐訊息簽章） | 每 session 隨機 64-hex token + active cell ID；現使用每 cell private pipes，token 同時區分 stdout protocol frames |
| D5 | Workspace git 版本化 + agent_lib guard | Persisted 成功 cells 保存指定範圍快照；失敗 builds 回復先前來源。Commit 成本依檔案量而變，沒有 <10ms 保證；非完整 replay（§2.1） |
| D6 | 工具名 `rust`（不冒名 `ipython`） | 冒名會觸發上游 `hasIpython` 的全套 Python prompt（探索確認）；誠實命名 + fork 內改分支條件 |
| D7 | Prompt 全新創作、面向通用 frontier models | 上游 base prompt 是「訓練過的前綴」，模仿無利；REPORT §3.6 |
| D8 | 押 wasm32-wasip1 core module；CM/wasip2 列 Phase 3 | Rust tier-2 穩定 + WasmEdge 最成熟路徑；REPORT 附錄 B |
| D9 | Guest 直接網路能力由 runner 禁止（2026-10-02，取代 T1 crate 約束） | stdio bridge 移除 socket 需求；全部 cell/test imports 只接受非網路 WASI functions，且強制 interpreter。Standalone WasmEdge、host build scripts、bash、host handlers 不受此政策限制（§2.7） |
| D10 | 工作名 wasmedge-agent；正式命名延後到 M5 轉 org 時定案 | 上游協調議題依 D23 延後至設計成熟期；命名部分維持延後 |
| D11 ✅ | 接受「無長命進程 → 大資料跨 cell 重讀」語意 | 緩解：state/blobs 序列化中間結果；resident data service 不預先設計，待實證瓶頸再議（§1.2） |
| D12 ✅ | Guest 對外 I/O 一律 host-mediated——**產品原則，非過渡措施** | 一切 fetch/search 類能力以 host handler 擴充（websearch 模式）；guest 永不直連外網。決定性/replay/credential 隔離三重理由（§1.3 原則 4、§2.7）。D9 的 guest 強制力已由 runner import 政策補齊；host 權限邊界保留 |
| D13 ✅ | `rust` + `bash` 雙內建工具 | 沙箱涵蓋 agent 自身計算、bash 為顯式越權通道的誠實敘事（§2.10）；與上游能力對齊、PoC 對照公平。approval 政策沿用現制 |
| D14 ✅ | agent_lib 擴充走**宣告式 `lib` 參數**；`/agent/lib` 唯讀 preopen | Cell 與 lib 同次編譯；build 失敗／中斷回復先前來源，非 runtime 交易式回滾或永遠可編譯保證（§2.1）。代價：雙參數 schema、cell 內不能程式化生成 lib（經 state 中轉） |
| D15 ✅ | Phase 1 prelude 鎖死；`deps.add` 延至 Phase 2 curated 白名單 | 供應鏈面最小、WP3 縮小、決定性最強；使用者以 settings `preludeExtra` 調整。Phase 2 白名單：host 抓取 → re-vendor → commit |
| D16 ✅ | 檔案操作教義 rust-first | 讀/搜/改檔走 rust cell（prelude helpers + state 重用），bash 保留給專案原生指令——RLM 理念的直接平移；代價為 cell 數增加，PoC 質性觀察項 |
| D17 ✅ | Prompt 附一個完整 few-shot 範例；PoC treatment 組內 sub-A/B 定去留 | +~150 tokens 固定成本 vs 首錯率——用數據定案而非直覺（§3.2 範例、§6.2 sub-A/B） |
| D18 ✅ | Child spawn 時快照複製 parent 的 agent_lib（含 target 快取）；`state/` 從空開始 | fan-out「parent 建工具、children 分段執行」成立；複製毫秒級、之後各自演化零耦合；context 隔離不變（§5.1） |
| D19 ✅ | Skill 品質閘：Phase 1 教義要求（soft）、Phase 2 沙箱內 cargo test 硬驗證 | host native 跑模型寫的 test = 繞沙箱執行任意代碼——強制閘只能以沙箱內測試實作，故分期（§4.2、§8.2） |
| D20 ✅ | GO/NO-GO 閾值維持：成功率 ≥ baseline−15pp、token ≤ 2.0×、≥2 家模型同時達標 | 容忍中度折價換沙箱/型別化/決定性的長期優勢；閾值是止損線非目標（§6.3） |
| D21 ✅ | PoC 模型組合：Claude sonnet 級 + opus/fable 級 + 開源權重一家（~216 runs、$200–600） | 主力情境＋能力上限＋跨家普適性各取一點；開源家兼作 LlamaEdge 故事前哨（§6.2） |
| D22 ✅ | M1 GO 後 fork 至 `hydai/wasmedge-agent` 個人 repo；M5 驗收通過後 transfer 至 second-state org | 低調驗證、失敗成本低、不背品牌期待；轉移的 star 歸零影響小（§7.1） |
| D23 ✅ | 獨立發展，上游協調延後至設計成熟期 | 使用者裁定：保持開發自主與節奏；SYNC 稅由 §7.3 三區策略承擔；成熟後歡迎探討合流 |
| D24 ✅ | 吸收合併取代 GitHub fork 機制；private repo；README attribution | GitHub fork 強制公開違反 D22 低調意圖且功能受限；prime-agent 對 pi 的先例即獨立 repo + README 鳴謝（§7.1） |
| D25 ✅ | 孵化期（M2–M4）零改名，完整 rebrand 延至 M5 | piConfig.name 牽動 env prefix/config 目錄，早改名＝bench/文件/SYNC 全面陣痛且 M5 可能重演；根 README 為唯一身分檔案（§7.1） |
| D26 ✅ | Repo 於 M2 期即轉 **public**（取代 D22 的 private 孵化） | 使用者裁定：public repo 的 GitHub Actions 免費（private 額度制）、低調未產生實質效益；公開前完成內容體檢（provider 參照泛化、D23 措辭中性化）。Actions 於 WP1 分支合綠與 workflow 適配前保持停用；M5 僅餘 org transfer |

**審閱記錄**：
- 2026-08-06 第 1 輪（§1 總體架構）——D11/D12/D13 確認；分層圖、進程模型、原則 1–5 無異議成立。
- 2026-08-06 第 2 輪（§2 核心元件）——D14/D15 確認；另定案 `/agent/lib`+`/agent/state` 雙獨立 preopen、per-cell bridge 連線、cellTimeout 120s 預設。
- 2026-08-06 第 3 輪（§3 Prompt）——D16/D17 確認；組裝結構、動態段落對照、第四 call-contract 變體、尺寸預算（~9.2KB）成立。
- 2026-08-06 第 4 輪（§4–§5 Skills/遞迴）——D18/D19 確認；另定案 skills 全掛載；bundled 處置表、harness reference 規格、goals/compaction/MCP 平移無異議成立。
- 2026-08-06 第 5 輪（§6 PoC）——D20/D21 確認；另定案 fixture repos 固定化、baseline 全功能對照；載具、範圍界定、指標集成立。
- 2026-08-06 第 6 輪（§7–§12）——D22/D23 確認（D23 定調獨立發展、上游協調延後）；WP 分解、SYNC 三區、Phase 2 概要、測試五層、組態、里程碑結構成立。**全文件審閱完成，狀態：已定稿（formalized）。**
- 2026-08-06 M2 起手審閱——D24/D25 確認（使用者質疑「fork 直接改名」引發；修訂 D22 執行細節與 §7.1 改名時機）。
- 2026-08-06 M2 中審閱——D26 確認（CI 費用考量轉 public；體檢後 `hydai/wasmedge-agent` 公開，Actions 暫停用）。

## 12. 里程碑與時程

| 里程碑 | 內容 | 週次 | Gate |
|---|---|---|---|
| M0 | PoC 建置完成（extension + guest 雛形 + bench 集） | W1–W2 | — |
| M1 | **PoC 量測報告** | W3 | GO/NO-GO：§6.3 閾值 |
| M2 | Fork 骨架 + cell 引擎（WP1–2） | W4–W5 | cell 迴路 demo |
| M3 | Bridge + 遞迴 + 呈現（WP3–5） | W6–W8 | spawn/goal/compaction 全通 |
| M4 | Skills + harness + 安裝（WP6–8） | W9–W10 | skill-creator 迴路 demo |
| M5 | **MVP 驗收**：bench 複跑 + dogfood 開始 | W11 | §9 驗收層 |
| M6 | Phase 2 起點（T2 runner 設計評審） | W12+ | — |

人力假設：1 人全職；bench 需 API 預算（12 任務 × 3 模型 × 2 組 × 3 次 ≈ 216 runs，中型任務估 $200–600）。

## 13. 附錄

### A. Workspace 模板全文

```toml
# Cargo.toml（workspace root）
[workspace]
members = ["agent_lib", "cell", "rlm"]
resolver = "2"

[profile.release]
incremental = true

# .cargo/config.toml
[build]
target = "wasm32-wasip1"
[source.crates-io]
replace-with = "vendored"
[source.vendored]
directory = "/Users/…/.wasmedge-agent/vendor"
[net]
offline = true
```

```toml
# agent_lib/Cargo.toml
[package]
name = "agent_lib"
edition = "2021"
[dependencies]
rlm = { path = "../rlm" }            # 由模板攜帶的 guest shim
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
regex = "1"
chrono = { version = "0.4", default-features = false, features = ["clock", "serde"] }
walkdir = "2"
# prelude 集最終以 wasm32-wasip1 相容性驗證為準（§9 整合層鎖定）
```

```rust
// cell/src/main.rs（模板初始內容，示教形狀）
use agent_lib::prelude::*;

fn main() -> Result<()> {
    println!("workspace ready");
    Ok(())
}
```

### B. Bridge 協議訊息一覽（v1）

| kind | 方向 | 欄位 | 說明 |
|---|---|---|---|
| `hello` / `hello_ok` | G→H / H→G | v, token, cell | 握手；token 錯即斷線 |
| `req` / `res` | G→H / H→G | id, type, payload / id, status, payload\|error | 同步 host request；type 即現有 handler 鍵 |
| `emit` / `ack` | G→H / H→G | id, type, payload | display.diff、display.attachment |

逾時：一般 req 30s（guest 端），skill test request 使用 cell budget；host 收尾先取消合作式工作，再等待其他 in-flight 5s。錯誤碼：`hello` 失敗、unknown type（"host request type X is not available in this session"——沿用現制訊息）、payload 驗證失敗（rlm-runtime.ts 既有驗證原樣觸發）。

### C. Benchmark 任務清單（Phase 0）

| # | 類別 | 任務 | 驗收 |
|---|---|---|---|
| 1–3 | 文本/資料 | nginx log 錯誤統計 top-N；多檔 TODO 掃描產 Markdown 報表；髒 CSV 正規化為 JSON | 輸出檔 diff |
| 4–5 | 程式修改 | 中型 TS repo 修 bug 至測試綠；Rust crate 跨檔 rename | 測試/`cargo check` |
| 6–7 | 狀態重用 | 兩回合：分析 repo 結構入 state → 追問時零重讀作答；三回合累積建立 log 分析 helper 並重用 | trajectory 檢查 state/lib 使用 |
| 8–9 | 工具鏈 | 跑測試→解析失敗→修→複跑；依 lint 輸出批次修風格 | 測試/lint 綠 |
| 10–12 | 綜合 | 小 CLI 從零生成含測試；兩資料源 join 報表；含錯誤注入的 fixture 修復 | check.sh |

### D. 參照文件

- 《REPORT.md》：可行性分析全文（耦合面、實測、路線比較）——本設計的依據。
- 上游文件對映：`docs/rlm.md`→ 需改寫、`docs/architecture.md` 圖 → §1.1 取代 kernel 框、`docs/extensions.md` → PoC 載具依據。

---

*設計方案已定稿（2026-08-06 六輪審閱完成，D1–D23 全數定案）。下一步：M0（PoC 建置）開工。*
