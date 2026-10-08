# Three-version benchmark validation — 2026-10-08

Runner、trace collector、runtime adapters 與可篩選 HTML/CSV 已實作。共有 3 個 host、16 個 direct-runtime、12 個 end-to-end cases；本次實測涵蓋全部 H/R 與 4 個 E tasks。這是 harness/correctness/coverage 驗證，沒有產生正式效能排名。

協定修正：首輪 `three-way-opus55-smoke-01` 允許 native tools，WasmEdge 的 E03/E08/E11 只走 bash；這些結果不能回答 Python cell/runtime 對 Rust cell/Wasm runtime 的問題。其原始資料保留，但整輪排除於 cell 對照。下方舊圖形與扣除驗證數字是修正前的歷史紀錄；目前重新生成的舊報表已顯示排除原因。新實驗改為每回合強制 cell、禁止 shell 委派，並把共同 checker 時間獨立列出。

操作方式見 [runner README](../poc/bench/three-way/README.md)，完整設計見 [實驗設計](benchmark-three-way-design-2026-10-08.md)。結論、圖表與重要數據見 [單檔統整報告](rust-cell-report-2026-10-08.html)。歷史 dashboard、CSV、診斷、PNG、provider requests、SSE、sessions 與生成的任務產出保留於本機。

## 固定輸入

| Variant | Base revision | Host / cell runtime |
|---|---|---|
| `prime-ts` | `7d442aafa985f9342134fac16c2ef41f03fb45c1` | TS Node bundle / upstream persistent Python |
| `prime-rust` | `967eb13fd488507af5f590e9c6ea8b2672f1fc05` | native Rust release / upstream persistent Python |
| `wasmedge` | `48d6312570f7d39809703db2c69a43f342fb7424` | fork TS Node bundle / Rust WASI cells, WasmEdge interpreter |

Prime Rust 的改寫範圍是 host，其 cell runtime 仍為 Python。R lane 的兩個 upstream 使用相同 Python source bytes；fork 使用有 assertions 的等義 Rust reference programs。正式產品的 runtime engine 透過獨立 adapters 呼叫，沒有用簡化 mock 取代 runtime。

環境：Darwin 25.6.0 arm64、Apple M5 Max、18 logical CPUs、128 GiB RAM、Node 24.13.1、Cargo/rustc 1.98.1、WasmEdge 0.14.1。Rust host/adapter/guest 採 release builds。各 plan 保存 source/build/task/collector hashes、collector source snapshot、seed 與配對隨機順序。

付費模型 route 為 `anthropic/claude-opus-5-5`，主量測關閉 reasoning。此 ID 由服務 catalog 提供；不可變 backend revision 尚未獨立驗證。

## 實測與檢查

| Campaign | Slots | 結果 | 付費 requests | 報表 |
|---|---:|---|---:|---|
| `three-way-local-02` | 57 | R 48/48；H 6 pass、2 fail、1 不適用 | 0 | H/R report（本機保存的證據） |
| `three-way-opus55-smoke-01` | 12 | 4 tasks × 3 variants，全數通過 checker | 54 | Opus report（本機保存的證據） |
| `three-way-opus55-cell-smoke-01` | 12 | 4 tasks × 3 variants；checker 與逐回合 cell 契約皆 12/12 通過 | 50 | Cell 對照 report（本機保存的證據） |
| `three-way-command-profile-check` | 1 | fork R01 通過，保存 48 個 Cargo/rustc command spans | 0 | profiling report（本機保存的證據） |
| `three-way-edit-phase-check` | 3 | R06 三版本通過；read/transform/write/verify 四段皆量測到 | 0 | edit report（本機保存的證據） |

付費 tasks 為 `03-fix-bug`、`08-rust-rename`、`09-helper-accumulation`、`11-join-report`。12/12 是 12 個 runs 的 correctness，並非全部 12 種 E tasks 已實跑。其餘 E cases 仍需另建 plan 執行。

- `npm run check` 通過，含 typecheck、branding 與專案既有檢查。
- `npm run build` 通過；固定 upstream TS bundle 與 native Rust release host/adapter 已 build 並實跑。
- `benchmark-three-way.test.ts` 15/15 通過；使用 faux HTTP/SSE，不呼叫付費 provider。
- 以上 73 slots 的 6,187 個 spans 全數通過 Draft 2020-12 schema；report 的跨 span/parent/clock integrity errors 為 0。
- R06 四段 duration 總和均落在 inclusive edit transaction 內；寫入段只包含 write/close，沒有包含 read/match/verification，也沒有宣稱 fsync durability。
- 報表的 variant/case/phase/state 篩選已用瀏覽器驗證，保存 篩選截圖。
- 675 個付費實驗檔案檢查到實際 API key 的次數為 0；檢查略過 build outputs。憑證不寫入 agent config、child env、manifest 或 command line。

機器可讀驗證紀錄：trace/stream/edit audit（本機保存的證據）、credential audit（本機保存的證據）。各 run 保留原始 SSE、decoded tool arguments、CLI/session logs、修改後專案、checker 與 failure records。

## 已觀測的失敗與比較限制

H02 是 8 KiB context、64 KiB UTF-8 output、64 code points/chunk 的無延遲 burst replay。`prime-ts` 與 `wasmedge` 的 print client exit code 都為 0，但 JSON output 沒有最後的 assistant `message_end`；兩者 session 皆保存完整 65,536 bytes 與 marker。`prime-rust` 同時輸出並保存完整結果。報表保留兩個 correctness failures；本次尚未定位或修正 client 的根因。

H03 在 native Rust CLI 不適用：該版僅公開 runtime tool，沒有獨立 bash model tool，也沒有相同 tool-filter flags。未用 runtime 內的 shell command 冒充 host-only dispatch。R10 則明確透過正式 bridge 使用共同 reference `/bin/sh` handler。

首輪付費 smoke 的原生 Cargo task 曾使用本機全域 shared build-dir，不能用來比較 cache-controlled compilation latency。後續 runner 已把專案原生 Cargo target/build-dir 固定在每 run；舊產出原樣保留，沒有覆寫或重跑成新結果。原生工具觀察曾讓模型直接選 bash；目前預設已改為 `runtime-only`，兩種 policy 的資料不可混池。

所有報表 `rankingAllowed:false`：僅一個 repetition、未完成 instrumentation overhead ≤2% audit，未做 paired bootstrap/confidence interval。PATH command profiling 有額外 process 成本，是獨立 lane；Cargo test bucket 合併 compilation/test，rustc units 也不可加總當 Cargo wall time。

未公開的 host、Python compiler、rustc typecheck/codegen/link、精確 process CPU/tree RSS hooks 保留 `missing`；不適用、未執行、失敗與中斷都有不同 state，不補成零。模型 code emission 是 client-visible SSE window；獨立 clocks 的 duration summaries 不能拼成全域 timeline。完整設計中的多尺度、cold host cache、更多復原與 library gate cases 尚未全部實作。

## 圖形化報表補充

四份主要 campaign 皆重新 `analyze` 產生離線 dashboard，新增案例耗時比較、correctness、span coverage、階段熱圖與單一 clock 時間軸。熱圖、時間軸可點入 trace，SVG 可匯出；只分析保存的資料，新增付費 requests 為 0。

12 根 Opus latency bars 與原 report 的成功 median 完全一致；H02 兩個 failure 保持 `null` success median，penalized mean 各為 90,000 ms；H03 native Rust 保持 N/A。390px、320px 的頁面無橫向溢出，寬圖表在區塊內滑動；熱圖、時間軸點選與 SVG 下載通過實際瀏覽器驗證。新增的圖表資料與 HTML 嵌入測試使 collector tests 為 18/18。

保存 桌面截圖、階段熱圖、手機截圖、SVG（本機保存的證據） 與 圖表核對紀錄（本機保存的證據）。

## 扣除 compilation 比較

四份報表新增獨立 section，逐次成功 run 扣除已量測的 Rust→Wasm cell Cargo（`cell.compile`），再取 median；原始長條使用同一批可扣除樣本。支援 agent/user-visible、linear/log、SVG、逐次扣除明細及 compile trace。Library test gate 與專案 build/test 的編譯尚未獨立拆分，保留在剩餘耗時內；此數字也仍包含模型與其他工具成本。

73 個 runs 的 JSON/CSV 扣除與 paired summary median 全數核對通過；18 runs 實際扣除 Cargo，46 個 upstream runs 不適用、5 runs 未執行 Rust cell、3 runs 排除於成功 median、1 run 無法扣除。R15 WasmEdge 的 cells 並行，缺少共同起點的 compile durations 無法安全加總扣除，維持 unavailable。Opus E09 WasmEdge 的三次 Cargo 合計 689.717917 ms，agent elapsed 29,427.396583 ms，扣除後為 28,737.678666 ms。

25/25 collector tests 與 `npm run check` 通過；測試涵蓋逐次扣除後 median、原始樣本配對、編譯失敗嘗試、inclusive/child 防重複、缺失/重複 observations、重疊 clocks、負值與 export。桌面 12 根 bars 與原始資料完全一致，user/log 切換、compile trace drill-down、案例聚焦、重設與 SVG 匯出通過瀏覽器驗證；390px、320px 無頁面橫向溢出，圖表與表格在區塊內滑動。未新增付費 requests。

保存 桌面截圖、手機截圖、SVG（本機保存的證據）、逐次 CSV（本機保存的證據） 與 核對紀錄（本機保存的證據）。

## 修正後的 Python cell / Rust cell 控制實驗

`three-way-opus55-cell-smoke-01` 是新的不可變 plan，模型維持 `anthropic/claude-opus-5-5`、reasoning off。E03 修 bug、E08 跨檔 rename、E09 三回合 helper/state、E11 資料 join/report 各跑三版本一次。全部 50 個實際 request 都僅公開該版本的 `ipython` 或 `rust`，12/12 run 通過共同 checker 與逐回合 cell 執行規則。Checker 在 agent 結束後執行，其時間不包含於 agent elapsed；因此不能與原 native 測試迴圈的 latency 混池。

實際呼叫 32 次 cell，其中 28 次成功、4 次失敗後在同一 trajectory 修正；失敗成本完整保留。已逐份檢視 34 份生成的 `.py` / `.rs`（含 Rust library sources），未發現 shell/subprocess 委派。WasmEdge E03 使用產品 `edit_exact` helper，其他 Rust 檔案處理使用 `std::fs`；E09 的計數、state 合併與 report 生成在 Rust/Wasm 執行。Python E09 也使用原生 skill/memory API 與生成的 Python helper source，沒有改成 shell script。自動 source 篩查仍不是對任意程式的安全證明。

以下為單次 agent elapsed，僅描述此 smoke；不是 runtime 純執行時間或正式效能排名。四個 WasmEdge 案例全部有 Rust→Wasm Cargo 與 Wasm execution observations；扣除量包括失敗編譯嘗試。

| Case | Prime TS / Python (s) | Prime Rust / Python (s) | WasmEdge 原始 (s) | Rust→Wasm Cargo (ms) | WasmEdge 扣除後 (s) |
|---|---:|---:|---:|---:|---:|
| E03 fix bug | 9.067 | 7.320 | 15.056 | 337.089 | 14.718 |
| E08 rename | 7.556 | 6.435 | 16.840 | 209.671 | 16.630 |
| E09 helper/state | 38.656 | 22.429 | 27.863 | 607.187 | 27.256 |
| E11 join/report | 9.130 | 8.287 | 17.793 | 353.279 | 17.439 |

新表格把「原始時間／編譯扣除量／扣除後時間／原因」分欄，預設展開。Python 版本直接顯示 0 ms 並說明「此版本沒有 Rust→Wasm 階段」，不代表 Python source 準備是零成本。缺失資料顯示「無法計算」，不符合契約或任務失敗顯示「未納入比較」。舊 native runs 的 phase/raw checker 結果保留，但成功耗時長條與扣除比較皆排除。

29/29 collector tests 與 `npm run check` 通過。新 1,008 個 spans 全數通過 trace schema，跨 span/parent/clock integrity errors 為 0；12 個 runs 的 JSON/CSV 扣除算術全部一致，checker 起點皆在 agent elapsed 終點之後。5,354 個非 build/runtime-cache 檔案未找到實際 API key。

已用瀏覽器驗證十二組 agent/linear 長條、E11 user/log 長條、編譯 trace drill-down、案例篩選、重設與 SVG 匯出；390px/320px 沒有頁面橫向溢出，寬圖表與明細在區塊內滑動。保存 完整圖、表格與扣除說明、手機圖、SVG（本機保存的證據）、cell/trace/credential 稽核（本機保存的證據） 與 視覺核對（本機保存的證據）。所有付費 response、生成程式碼、events、專案產物與 checker logs 保存於此新 campaign；沒有覆寫舊原始 run。

## 慢因分析：初始化編譯與模型 trajectory

本輪四個 WasmEdge runs 在 task 開始至第一個 gateway request 間花 5.195–5.916 s；Prime TS 為 0.510–0.538 s、Prime Rust 為 0.032–0.037 s。這段初始化包含於 agent elapsed，但不在 `cell.compile` 的 scope。主 agent 在 session creation 開啟 `prewarmRustWorkspace`；同步 toolchain/workspace/skill 處理會阻塞同一 Node event loop，即使入口是 fire-and-forget prewarm，也未在模型呼叫前完成背景並行。

檢查實際 workspace 發現，預置 template 未含內建 `websearch` skill，正式 session 的 agent_lib 卻掛載此 skill。`syncRustSkills` 在新 workspace 執行 `cargo build --release -p agent_lib` 的 probe build。無付費模型的獨立診斷用正式 RustCellProvisioner，在六個全新、各自隔離的 workspace 交替測試三次無 skill、三次同一 websearch skill：無 skill 初始化 0.346–0.389 s；掛 skill 4.612–5.048 s，其中 probe Cargo 4.241–4.650 s。Cargo stderr 顯示 regex、serde、rlm、websearch、agent_lib 等重編，template 預暖並沒有讓這次 build 全部命中 cache。保存並重開既有 workspace 約 0.049–0.055 s（掛 skill 的三筆），不重新執行 probe Cargo。診斷有 wrappers，沒有做 overhead audit，不能把其時間直接從原付費 run 扣除或宣告普遍 speedup。診斷原始資料（本機保存的證據）

E11 的兩個 Node host 對照如下，單位為秒。模型欄是完整 HTTP request 等待＋串流，不是服務端純生成時間。區間均裁切於 task.agent_elapsed，HTTP 取 union，工具窗口排除與 HTTP 的重疊，其餘保留為未細分等待；不把嵌套 cell/compiler 子步驟再加上去。

| E11 分段 | Prime TS / Python | WasmEdge / Rust |
|---|---:|---:|
| 第一個模型請求前 | 0.516 | 5.195 |
| 模型 HTTP requests | 7.058 | 11.939 |
| 工具事件窗口 | 0.011 | 0.483 |
| 其餘未細分等待 | 1.545 | 0.176 |
| Agent 總時間 | 9.130 | 17.793 |

WasmEdge E11 的 0.483 s 工具窗口內，cell Cargo 合計 0.353 s、execution 0.021 s、snapshot 0.076 s；execution 含程序啟動、I/O 與 host handlers，不能當純 guest CPU。Python 的 kernel execute summaries 合計 4 ms，也不是同一個拆分契約。Wasm 執行本身沒有解釋 8.663 s 的整體差距。模型 trajectory 也不同：E11 兩者各三次 HTTP calls，Rust cell requests 的輸出合計 774 tokens，Python 合計 341（含 tool arguments），整輪分別 876/439。Rust 首次 prompt 9,241 tokens，Python 11,520，不能把本輪模型較慢概括成 Rust prompt 較長；API 排隊、cache、prefill 與 generation 尚無服務端獨立 hooks。

E08 Rust 首次使用未直接可見的 `walkdir::WalkDir` 而編譯失敗，隨後改 std::fs 修正，多一次 cell/model request；Rust 3 calls、Python 2 calls。E09 則 Rust 三個 cells 無失敗、6 次 HTTP，Prime TS 八個 cells 含兩次 API 錯誤、11 次 HTTP，Rust 27.863 s 比 TS 38.656 s 快；並非每個案例 Rust 都較慢。產生 cell 的編譯、模型修正成本、初始化編譯與 warm-session 執行必須分開評分。十二個 runs 的完整分段與 usage（本機保存的證據）

Smoke 的 12 runs 是四案例 × 三版本 × 一次，不是每組十二次。它可支持本輪 latency、錯誤與初始化機制的診斷，不能估計每組模型/排隊變異或穩定勝率；`median` 在 n=1 時就是單筆值。正式單 Opus 比較需更多 tasks 與配對 repetitions，依 pilot variance 決定樣本、報 confidence intervals，並先完成量測 overhead 審核與初始化 Cargo coverage。這不撤回已觀測的慢因與正確性結果。

## 全部 Cargo 扣除與 cell 執行表

已建立新的獨立 campaign `three-way-opus55-all-cargo-smoke-01`，相同 E03/E08/E09/E11 × 三版本 × 一次，模型仍為 `anthropic/claude-opus-5-5`、reasoning off、runtime-only。12/12 checker 通過且符合逐回合 cell 契約，共 52 次付費 HTTP requests，34 次 cell 呼叫、28 次成功、5 次 Python runtime API 失敗與 1 次 Rust compile 失敗（成功 trajectory 內的修正嘗試）。已讀完整的 36 份實際 Python/Rust source，沒有 shell/subprocess 代做。E09 的各產品 helper/memory/persistence 方法不同，TS 最後 cell 直接格式化前面已觀察的 fixture counts；因此仍是產品 trajectory 比較，非固定程式 CPU microbenchmark。

12/12 具有完整 Cargo capture，合計 16 個 Cargo 命令。每 run 的三次 child clock 對齊、起訖配對、argv/cwd/ID、原始命令與 cargo.command spans 已驗證。新 run.validated_elapsed 包含初始化至 checker 完成；agent/user/full 三種期間的 Cargo union、裁切與減法及 CSV 均逐筆驗證。1068 spans 通過 trace JSON schema、跨 record integrity errors 為零。檢查 5433 個非 build 產出檔案，實際 API key 出現零次；所有 52 requests 只宣告該版本的 ipython 或 rust。

下表總時間的邊界為初始化至驗收完成，單位秒；Cargo 是此期間內完整命令 wall time，包含測試而非只編譯。

| 案例 | 版本 / cell | 原始總時間 | 全部 Cargo | 扣除後 |
|---|---|---:|---:|---:|
| E-03-fix-bug | Prime TS / Python | 11.349 | 0.000 | 11.349 |
| E-03-fix-bug | Prime Rust / Python | 7.324 | 0.000 | 7.324 |
| E-03-fix-bug | WasmEdge / Rust | 14.939 | 4.366 | 10.573 |
| E-08-rust-rename | Prime TS / Python | 9.306 | 0.873 | 8.433 |
| E-08-rust-rename | Prime Rust / Python | 7.331 | 0.415 | 6.916 |
| E-08-rust-rename | WasmEdge / Rust | 17.624 | 4.534 | 13.090 |
| E-09-helper-accumulation | Prime TS / Python | 44.481 | 0.000 | 44.481 |
| E-09-helper-accumulation | Prime Rust / Python | 25.283 | 0.000 | 25.283 |
| E-09-helper-accumulation | WasmEdge / Rust | 28.254 | 5.045 | 23.209 |
| E-11-join-report | Prime TS / Python | 9.885 | 0.000 | 9.885 |
| E-11-join-report | Prime Rust / Python | 8.919 | 0.000 | 8.919 |
| E-11-join-report | WasmEdge / Rust | 18.163 | 4.946 | 13.217 |

WasmEdge 的初始化 agent_lib skill probe-build 現在包含於 Cargo 扣除。E08 兩個 Python 版本的 checker Cargo 分別 0.873 / 0.415 s，同樣扣除；若切成 agent/user 期間，這兩筆位於期間外，扣除量為零，不能從該時間再減去驗收。新資料與舊無完整 Cargo capture 的資料分開，舊資料標量測不足，沒有回填診斷數字。

Cell 表的數字單位 ms；合計包含 runtime 失敗成本，compile 失敗不算 runtime；cell 次數分成功/runtime 失敗/compile 失敗。

| 案例 | Prime TS / Python | Prime Rust / Python | WasmEdge / Rust |
|---|---:|---:|---:|
| E-03-fix-bug | 6.000 ms · 2/0/0 | 2.000 ms · 2/0/0 | 34.297 ms · 2/0/0 |
| E-08-rust-rename | 3.000 ms · 1/0/0 | 2.000 ms · 1/0/0 | 10.877 ms · 1/0/1 |
| E-09-helper-accumulation | 23.000 ms · 6/4/0 | 7.000 ms · 4/1/0 | 72.601 ms · 3/0/0 |
| E-11-join-report | 4.000 ms · 2/0/0 | 10.000 ms · 2/0/0 | 21.060 ms · 2/0/0 |

30 個針對 benchmark 的測試與 root npm run check 通過，包含並行 Cargo 聯集、跨邊界裁切、歷史資料不可補零、缺失／重複 command 與 clock proof、Python sub-resolution 與 Rust runtime/compile failures。這次每組仍只有一次，overhead 未審核；保存實測數字，不宣告普遍效能勝負。

新版離線圖形報表（本機保存的證據） · Cargo/Cell 逐筆驗證（本機保存的證據） · 全部 Cargo 扣除 CSV（本機保存的證據） · Cell 執行 CSV（本機保存的證據）。

圖形報表已以隔離 agent-browser 實際檢查桌面 1440px 與手機 390px / 320px，無整頁水平溢出、JavaScript errors 為零。期間切換與 E08 checker 位於 agent 期間外的零扣除原因已核對；cell 表可點入對應 runtime trace。畫面驗證（本機保存的證據） · Cargo 桌面截圖 · Cell 執行表截圖。

Cell 表已補上三版本並排長條圖，可切換每 run 執行合計與成功 cell 平均（先逐 run 計算、再取 median），固定 ms 並提供 linear/log、案例／版本篩選、點長條聚焦與 SVG 匯出。兩種指標的 12 組圖表數值全部對照既有 runtime rows 一致，1440px / 390px / 320px 無整頁水平溢出，JavaScript errors 為零；這次只重新產生離線報表，沒有新增付費模型 requests。Cell 圖表驗證（本機保存的證據） · 桌面圖表截圖。

## Cell runtime 慢因診斷

已補做不呼叫模型的固定程式控制，各組 2 次 warmup + 15 次量測，保存主診斷 272 個 Rust/process、136 個 Python samples，以及同 artifact 的 interpreter/AOT 控制 136 samples。確認約 10 ms 的每次新 process 成本、interpreter 的 JSON/regex 慢因，以及 5 ms bridge polling 的延遲；E09 state 為檔案操作，不經 bridge。AOT 與 1 ms polling 僅診斷副本，沒有變更產品政策。Cell 圖註解已明列常駐 Python kernel 與每 cell 新 WasmEdge process 的計時差異；原始 paid measurements 不變。[完整分析與數字](benchmark-cell-runtime-analysis-2026-10-08.md)。
