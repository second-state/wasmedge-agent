# Three-version benchmark

[English instructions and report links](README.en.md) · [English consolidated report](../../../docs/rust-cell-report-2026-10-08.en.html)

可執行的 runner 比較 `prime-ts`、`prime-rust`、`wasmedge`（interpreter）、`wasmedge-aot`。標準模型 route 為 `anthropic/claude-opus-5-5`；這是服務實際列出的 ID，服務端不可變 backend revision 尚未獨立驗證。主量測不開 reasoning。原有 A/B/F harness 與 DESIGN D20/D21 放行規則保持原契約。

[安全性與效率統整報告](../../../docs/rust-cell-report-2026-10-08.html)（[Markdown](../../../docs/rust-cell-report-2026-10-08.md)）是最新成果入口，包含架構、安全控制、負向測試、固定程式／Opus 結果、Cargo／AOT 與 bridge 分析。使用 `uv run --with matplotlib==3.10.8 --with markdown==3.10.2 python poc/bench/consolidated-report.py` 可從保存的 evidence 重建，不呼叫模型。

需要 Node 22.8+、npm、Cargo、rustup `wasm32-wasip1`、uv，以及 WasmEdge 0.14.1 interpreter / AOT。執行前依專案 README 安裝 WasmEdge，或指定既有 `WASMEDGE_AGENT_WASMEDGE`。Rust host 與 adapter 都以 `--release --locked` 編譯。prepare 下載固定 SHA 的外部 source archive，build Node bundle，建立各自的 upstream runtime environment，vendor 並 warm 獨立 WASI template。所有輸入、bootstrap log、paid output 都留在 gitignored `poc/bench/results/`；不修改使用者的 agent 設定。

```sh
npm run build
npx tsx poc/bench/three-way/cli.ts prepare
# 從已 export 的環境執行；也可以先 source ~/.zshrc
npx tsx poc/bench/three-way/cli.ts discover --model anthropic/claude-opus-5-5
npx tsx poc/bench/three-way/cli.ts plan --suite smoke --provider poc/bench/results/three-way-provider.json --out poc/bench/results/three-way-smoke
npx tsx poc/bench/three-way/cli.ts run --plan poc/bench/results/three-way-smoke
npx tsx poc/bench/three-way/cli.ts analyze --plan poc/bench/results/three-way-smoke
```

`smoke` 共 44 slots：12 host、16 direct-runtime、16 paid end-to-end。其中一個 H03 slot 不適用。`--suite host`、`runtime`、`end-to-end`、`all` 或逗號分隔 lanes/case IDs 可選工作負載；`--variants prime-ts,prime-rust,wasmedge,wasmedge-aot`、`--reps N`、`--seed N` 可控制矩陣。單一 Opus 模型的 12-task pilot 為 144 runs（4 versions × 3 reps），formal 為 480 runs（4 versions × 10 reps）；prepare/discover/plan/analyze 不呼叫付費生成，只有 run 的 end-to-end slots 會付費。每 run 最多 64 HTTP requests，包含 retry，總 deadline 依 task 固定。

預設 E 為 `--tool-policy runtime-only`，比較 Python cell + Python runtime 與 Rust cell + Wasm runtime：TS 僅啟用 ipython，fork 僅啟用 rust，native Rust 維持其唯一的 ipython 工具。每回合至少一次成功的 cell，讀檔、解析、計算、修改與寫檔必須在 cell 內完成，不得透過 shell/subprocess 代做。原始 fixture 的 `node --test`、`cargo test` 等驗收由共同 checker 在 agent 結束後執行、另行計時；這是新的控制實驗，不等同原生工具的測試迴圈。

每 run 保存 `cell-audit.json`、實際生成的 `.py` / `.rs` 與每回合 prompt/hash。Checker 通過但沒有符合 cell 契約的 run 仍判失敗。自動檢查工具、來源、成功執行、每回合 coverage 與可辨識的 shell API；來源篩查不是安全邊界，生成的 source 仍需人工檢視。`--tool-policy native` 僅供工具選擇觀察，舊的 bash trajectory 保留原始資料與 checker 結果，但不納入 cell 對照耗時。兩種 policy 是不同 case inputs/hash，不得混池。專案原生 Cargo target 與 build-dir 固定在每 run，防止使用者全域 shared build cache 讓後跑的版本受益；cell engine 自有 target 策略保留。

`--profile-commands true` 加入獨立 profiling lane，透過 PATH wrapper 保留原 stdout、stderr、exit code，逐次保存 Cargo/rustc/node/python 的 spawn-to-close wall time、argv、cwd 與 outcome。可分原生 build、test、program run 與 control-cell Cargo invocation。`cargo test` 的 compilation 與 tests 仍是合併命令 bucket，rustc unit time 也不能加總當 Cargo wall。Wrapper 有額外 process 成本，未完成 overhead audit，不能把 profiling 與預設 lane 混池。直接以絕對路徑呼叫工具會繞過 PATH wrapper，該 invocation 的 coverage 必須由原始命令檢查。

生成的 manifest 固定 source/build hashes、collector hash、task snapshot/hash、case inputs、model ID、seed 與先後順序。執行前檢查 drift；resume 只跳過完整 slots，保留中斷／infrastructure failure，禁止覆寫這些資料或偷偷以成功重跑取代失敗。重測請建立新 plan。Plan directory 要留在原位置。

模型憑證只留在 reverse gateway process。各版本讀取隔離的 models.json，使用不具付費權限的本機隨機 token。HTTP request body、response SSE、decoded tool arguments、usage、stream chunk timestamps、CLI/session logs、project output、failure records 都逐步存入各 run 目錄。原始資料含 prompt/code，目錄權限 700、敏感紀錄 600；API key 不寫入 manifest、config、child env 或 command line。

| Lane | 已實作 cases | 驗證方式 |
|---|---|---|
| H | H01 startup、H02 fixed UTF-8 stream、H03 10 shell tool calls | scripted HTTP/SSE replay；沒有付費模型 |
| R | R01–R16 的小規模 reference workloads | 直接呼叫各版本正式 cell engine；兩個 upstream 使用相同 Python bytes；Rust 等義程式有 assertions 與 guest markers |
| E | 原有 12 個 tasks 的 cell 控制版本 | 原生 system prompt + 僅 cell 工具 + 同一 Opus route/fixture/外部 checker |

H01/H02 replay 回應相同，產品原生 prompt/tool metadata 保留並存檔；它們不是完全相同 request payload 的 parser microbenchmark。Native Rust CLI 固定公開 runtime tool，沒有 tool filter，也沒有獨立 bash model tool；H03 在該版本為 `not_applicable`，不得從 runtime 呼叫湊成 host-only 數字。R10 用相同 `/bin/sh` 的 reference handler 經正式 bridge 比較命令 roundtrip。R15 是獨立 runtime sessions，並非 RLM 子代理。R11 分別驗證 Python namespace checkpoint 與 Rust explicit blob/Git，保存契約不同。R04 的 resident/reparse 子步驟也分開報告。

目前實作小規模固定 reference，不代表設計文件所有 scale、cold host caches、compiler internals、crash recovery、library test gate 或 E13–E15 擴充已完成。R02 cold 只清除 benchmark-owned workspace target；OS/toolchain/template caches 仍暖。R16 100 cells，目前每 cell no-op，尚未加入每 10 cells 的 state mutation variant。

每個 run 產出 `spans.jsonl`、`events.jsonl`、`result.json`；分析產出 `report.html`（variant/case/phase/state/outcome 與 run/cell/request 搜尋）、`report.json`、`runs.csv`、`phases.csv`、`phase-summary.csv`、`requests.csv`。失敗耗時保留，task failure 以預定 deadline 計入 penalized mean，infrastructure error 不被算成產品 correctness failure，並阻擋整體完整性判定。

量測包含 gateway 接收／headers／TTFB／首內容與 reasoning／stream、tool args 與 source-field emission/code-ready、tool execution、runtime admission/provision、WASI source preparation／gates／queue／Cargo／policy／probe／execution／bridge cleanup／snapshot／residual、reference guest compute/read/parse/edit/state/bridge/output、checker、teardown。`llm.code_emission` 是 raw tool JSON source 欄位對應 SSE event 的可見窗口；不是服務端純生成時間。code-ready 從 gateway 收到 request 起算，不含尚未觀測的 host prompt construction。

原生 duration summaries 有獨立 clock ID，只能比較 duration，不能拼成全域 timeline。Inclusive totals、guest children、bridge roundtrip 不可相加。Python parse/bytecode/import、rustc typecheck/codegen/link、host result-pack/transcript flush、process launch/drain 與 exact CPU/tree RSS hooks 未公開，明確標 missing；Python Cargo 為不適用，compile rejection 後 runtime 為未執行。沒有用 wall minus CPU 冒充 I/O，也沒有把 cached/缺失測量補成 0。

報表現在始終 `rankingAllowed:false`：尚未完成 instrumentation overhead ≤2% audit；smoke 樣本不足，僅驗證 harness、correctness 與量測 coverage。正式統計應另作 paired bootstrap 與 confidence interval，不能以單次 latency 宣告勝負。Usage 保留服務原值，未設定 pricing 時不推估付費金額。

首次實測結果、付費產出與比較限制見 [2026-10-08 驗證紀錄](../../../docs/benchmark-three-way-validation-2026-10-08.md)。

HTML 為離線圖形 dashboard：案例耗時並排長條圖（agent/user-visible median 或 penalized mean，可切換 linear/log）、correctness 與量測 coverage、單一案例階段熱圖、單一 clock 時間軸。熱圖與時間軸可點入 trace；SVG 圖可匯出。熱圖是各階段 observation median，錯誤 observation 與缺失狀態保留；它不是可相加的成本 pie chart。重新 `analyze` 即可把既有資料轉成圖形報表，不呼叫模型。

「扣除全部 Cargo 的耗時比較」逐次成功且符合 cell 契約的 run 扣除所選期間內全部 `cargo.command` 的 wall time，再取 median；淡色原始 median 使用相同樣本。預設期間為初始化到共同 checker 完成，另可切換不含 checker 的 user/agent 期間。包含初始化、skill 掛載/probe-build、cell、library test gate、專案 build/test、輔助命令與失敗重試；`cargo test` 整個命令（含測試執行）都扣除。區間取聯集，重疊只扣一次，再截取所選期間；不加上 cell.compile、rustc 或其他子步驟。Checker Cargo 僅從包含 checker 的總耗時扣除，Python 版本也可能透過 checker 使用 Cargo。

每 run 預設啟用 Cargo-only wrapper，透過 PATH 及 WASMEDGE_AGENT_CARGO 捕捉固定版本 runtime 與共同 checker 的所有 Cargo 入口，保存 `cargo-commands.jsonl`、`cargo-capture.json`、`cargo-clock-calibration.json`。執行前用三個 child monotonic 取樣確認可與 collector 對齊；起訖配對缺失、重複、不同 clock 或舊 run 未啟用完整捕捉時顯示「量測不足」，不得將未知補零。其他自訂的絕對 Cargo 路徑會繞過這些入口，不屬於本矩陣已驗證的 capture scope。Wrapper 的 Node 啟動額外成本保留在剩餘耗時，overhead 尚未審計；新 capture campaign 不與舊 lane 混池。算術扣除不是實際免 Cargo 的重新執行。

新增「Python cell 與 Rust cell 執行時間」表：每 run 的 runtime-reported 執行時間合計、成功 cell 平均、成功/runtime 失敗/compile 失敗次數與量測狀態。來源為 `cell.python_execute` / `cell.execution`，排除 LLM、Cargo、初始化、snapshot，不使用可能批次送出的 CLI tool event 窗口冒充 kernel 執行時間。保留 runtime 執行邊界內的啟動、I/O、host bridge 成本；不是純 CPU。平行 cells 合計是工作量而非 wall time，生成程式與 cell 次數不同時不能當固定程式 microbenchmark；Python 回報 0 ms 表示低於解析度。逐次資料存於 `cell-execution-runs.csv`、`report.json.cellExecutionRuns`；兩個 section 可點入原始 trace。

Cell 執行 section 另提供各版本並排長條圖，單位固定 ms，可切換「每 run cell 執行時間合計」與「每個成功 cell 平均時間」、linear/log 座標及 SVG 匯出。每 run 先計算所選指標，再對完整且可比較的 runs 取 median，不將不同 run 的 cells 混池；n 是 run 數。沿用案例／版本篩選，點長條可聚焦案例，tooltip 顯示 cell 次數及 runtime／compile 失敗；逐次表格保留在圖下方。

AOT 是額外的第四組 `wasmedge-aot`，原 `wasmedge` 固定 interpreter；兩組使用相同 Rust reference cells 與新的 readiness bridge，來源及 template hash 一起固定。每個 AOT cell 從通過 import gate 的 Wasm 重新編譯，無快取。Cargo→Wasm 與 Wasm→AOT 分別記為 `cargo.command` / `cell.compile`、`aot.command` / `cell.aot_compile`。Cell 執行圖表只使用 `cell.execution`，排除兩段編譯。

編譯扣除 section 可切換「全部 Cargo」與「全部 Cargo + AOT」，表中兩者分欄、合併扣除量使用命令區間聯集。`agentWithoutAllCompilationMs` / `userWithoutAllCompilationMs` / `validatedWithoutAllCompilationMs` 為新增欄位，舊的 `*WithoutCompilationMs` 仍只扣全部 Cargo。AOT wrapper 僅包 compiler，不包 runtime；記錄於 `aot-commands.jsonl` / `aot-capture.json`，與 Cargo 共用已校準 collector clock；AOT 捕捉不完整時合併扣除量保持未知。這是算術扣除；實際端到端耗時仍包含 AOT。新的 campaign 保留 collector/template/source hashes，不與舊 bridge campaign 混池。
