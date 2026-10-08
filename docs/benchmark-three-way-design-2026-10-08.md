# 三版本效能實驗設計

日期：2026-10-08。狀態：**設計規格，尚未實作三版本 runner、尚未執行正式實驗**。

交付物：[實驗清單](benchmark-three-way-plan.json)、[trace record schema](benchmark-trace.schema.json)、[已實作 runner 與 coverage 說明](../poc/bench/three-way/README.md)。本文是完整實驗規格；catalog 保留 `executionReady: false`，執行時由 CLI 產生含實際 source/build/環境 hashes 的 immutable manifest。標準模型依本次要求固定為服務列出的 `anthropic/claude-opus-5-5`，同一路由供三版本使用。本文不改動 DESIGN.md 的 D20/D21 放行規則，也不把歷史結果當成本次結果。

## 1. 實驗要回答的問題

1. Prime 的 TS host 與 Rust host：啟動、prompt 組裝、stream 處理、tool dispatch、session persistence 各差多少？
2. Python REPL 與 Rust → WasmEdge cell：每次使用的固定成本、實際運算、資料 I/O、bridge、狀態保存各差多少？
3. 同模型、同任務下：生成程式碼、編譯、執行、修復、測試分別花多少時間與 tokens，最後能否正確完成？

**host 的 Rust 改寫與模型執行語言的 Rust 是兩件事。** 三個產品的組合如下：

| variant ID | 產品 | Host | 模型的控制程式 | 執行模型 |
|---|---|---|---|---|
| `prime-ts` | Prime Agent，最後 TS main | TypeScript | Python | 持久 Python REPL |
| `prime-rust` | Prime Agent，查核時 Rust main | Rust | Python | 持久 Python REPL |
| `wasmedge` | 本 repo | TypeScript | Rust | 每 cell release 編譯成 WASI module，再啟動 WasmEdge interpreter |

### 1.1 固定版本與來源

查核時固定以下 **完整 commit SHA**，實驗中不得再追蹤 moving main：

| variant | Source revision | 選擇理由 |
|---|---|---|
| `prime-ts` | `7d442aafa985f9342134fac16c2ef41f03fb45c1` | Rust port commit 的唯一 parent；TS package version 0.9.8 |
| `prime-rust` | `967eb13fd488507af5f590e9c6ea8b2672f1fc05` | 本次查詢的上游 main，commit UTC 2026-10-07 22:04:58 |
| `wasmedge` | `48d6312570f7d39809703db2c69a43f342fb7424` | 本次設計開始前的 fork main |

來源：[TS revision](https://github.com/PrimeIntellect-ai/prime-agent/tree/7d442aafa985f9342134fac16c2ef41f03fb45c1)、[Rust revision](https://github.com/PrimeIntellect-ai/prime-agent/tree/967eb13fd488507af5f590e9c6ea8b2672f1fc05)、[Rust port commit](https://github.com/PrimeIntellect-ai/prime-agent/commit/39bc99a91d102c46474c090fdc7ae7cd5037ffcf)。上游的 [runtime lifecycle benchmark](https://github.com/PrimeIntellect-ai/prime-agent/blob/967eb13fd488507af5f590e9c6ea8b2672f1fc05/crates/pa-core/examples/kernel_bench.rs) 實際啟動 Python child；因此不能把第二組解讀成「native Rust 執行模型生成的 Rust」。

此選集測量三個產品版本的差距，仍包含功能、prompt、依賴與 revision 差異。若要更接近 host rewrite 的歸因，另加 `prime-rust-port`（`39bc99a91d102c46474c090fdc7ae7cd5037ffcf`）對 TS parent 的診斷對照；不混入三版本主榜，也不宣稱完全排除移植時的其他改動。

加入 instrumentation 時保存 `baseRevision`、patch bytes/hash、完整 instrumented source hash；不能只寫原 commit SHA 卻漏記量測用修改。

### 1.2 Build 與包裝條件

- 主實驗使用 build 完的 TS bundle，由相同 Node binary 啟動兩個 TS hosts；Rust host 使用 `cargo build --release --locked` 的 binary。**禁止用 tsx 開發入口對 release Rust 排名。** 上游 TS launcher 的 `--dist` 會跑 bundle，預設則跑 tsx（[固定來源](https://github.com/PrimeIntellect-ai/prime-agent/blob/7d442aafa985f9342134fac16c2ef41f03fb45c1/prime-agent.sh)）。
- 主實驗保留產品 runtime 政策：WasmEdge `--force-interpreter`、release/offline guest build、persisted workspace、Git snapshots；記錄每項設定。不把 standalone module 跳過 policy 的數字當產品 cell latency。
- 「發行包使用體驗」另列 packaging lane。上游 TS standalone build 使用 Bun，不能與 Node bundle 數字合併；來源見 [binary builder](https://github.com/PrimeIntellect-ai/prime-agent/blob/7d442aafa985f9342134fac16c2ef41f03fb45c1/packages/coding-agent/scripts/build-binary.mjs)。
- 一次性 host build、依賴安裝、vendor、toolchain 安裝另列 setup report。模型為任務寫的專案程式需要的 build 則計入任務時間。

## 2. 三條測試線

| Lane | 模型來源 | 工作輸入 | 比較結果的範圍 |
|---|---|---|---|
| H：host | 本機固定 provider replay | 相同 response schedule、相同 payload 規模、相同共用 tool 契約 | Host overhead、stream throughput、session persistence |
| R：runtime | 無模型呼叫 | 預先寫好的 Python/Rust reference cells，相同演算法與輸出契約 | Runtime + cell pipeline；跨語言比較包含語言與函式庫成本 |
| E：end-to-end | 真實、固定 model revision 的 provider | 相同自然語言任務、fixtures、hidden checker | 完成品質、用戶等待、tokens、修復成本 |

H/R 不花 provider tokens，可先完整跑。E 的模型與預算固定後才建立正式 plan。本次工作沒有呼叫付費模型。

H 使用獨立本機 HTTP/SSE replay server，讓三者都經過實際 provider adapter、daemon/client 與 agent loop。初期固定一種三者都支援的 wire API；其餘 API 分開列。

- 主榜用 `no-runtime` 與 `bash-common` 腳本：純回答／固定共用 shell command，避免 cell 語言干擾 host 比較。共用 command 由 pinned executable 執行，輸出 checksum 固定。
- 另做原生 cell replay：兩個 Prime variants 收相同 Python，wasmedge 收等義 Rust。這條只能稱「固定 trajectory 下的整體開銷」，不能稱 host-only。
- Replay script 固定 reasoning/text/tool-argument bytes、chunk 邊界、terminal event、usage fixture、tool call 次數及預定延遲；三組 tool IDs 可由 adapter 正規化，但不改程式內容。Server 記錄實際 emit 時刻、socket backpressure 與收到的 request hash。
- 輸入 request 不會完全相同：原生 prompt/tools schema 保留。另列 `synthetic-context` 子測試，給三者等量 context；不能把這個人造 prompt 當真產品體驗。
- Faux provider 適合插樁正確性測試，正式 H 要走 wire，不能只測 in-process callback。
- 既有 upstream replay server 與 faux provider 可供參考；本次確認它們存在，尚未驗證本計畫的三方 replay 相容性。

## 3. 共用逐階段時間定義

每個 run 保存 start/end 事件及 normalized spans，粒度依序為 `run → turn → request attempt → tool call → cell/command → phase`。子 agent 另外記 `agentId`、`parentAgentId`；不只保存總時間或每回合平均。

### 3.1 啟動、模型與 host

| Span / marker | 起點 → 終點 | 說明 |
|---|---|---|
| `startup.cli` | process launch → CLI 可接收命令 | 新程序；記 Node/Bun/Rust 包裝方式 |
| `startup.daemon` | supervisor launch → 已完成協議 readiness | Socket 存在不等於 ready |
| `startup.worker` | session 建立請求 → worker ready | 含 session worker boot |
| `startup.resources` | 開始載入 → prompt/skills/catalog 可用 | 掃描、讀檔、設定解析分成 children |
| `startup.runtime` | runtime provision 開始 → 可接收首 cell | Python boot／Rust scaffold；可與其他啟動重疊 |
| `host.prompt_build` | turn dispatch → context/messages 建好 | 另記 context bytes、entries、實測 tokens |
| `host.provider_prepare` | messages 建好 → payload 交給 transport | provider 轉換、序列化、credential lookup 分開插樁 |
| `provider.headers_wait` | transport send 邊界 → response headers | 含 upload、網路、server queue/prefill；不是純 inference |
| `provider.first_body_wait` | headers → 第一個 body/SSE bytes | 必須在 transport 層新增 marker |
| `provider.first_content_wait` | headers → 第一個非空 content delta | thinking、text、tool args 皆可；空 start block 不算 token |
| `provider.reasoning_visible` | 第一個 → 最後一個 reasoning delta | 可觀測窗口，不是模型內部完整思考時間 |
| `provider.code_emission` | 某 tool code/source 第一個 byte → 最後一個 byte | §3.3 定義；保留 chunk 邊界 |
| `provider.response_stream` | 第一個 content delta → stream terminal | 是上述生成窗口的 parent，不可重複加總 |
| `host.stream_decode` | 單 chunk 到達 → event/tool args 可用 | 每 chunk 分布；不把整段 stream 的等待當 parser CPU |
| `host.tool_dispatch` | 完整 tool args 可用 → tool body 進入 | schema validation、排程、序列化分開 |
| `host.result_pack` | tool 執行完成 → toolResult 組好 | 截斷、diagnostic formatting、attachments、JSON encoding |
| `host.transcript_append` | append 開始 → caller 的 persistence 契約完成 | 記錄是 write、flush 或 fsync；不同保證不得混稱 durable |
| `host.next_turn_gap` | toolResult 可用 → 下次 request dispatch | 包含剩餘 host bookkeeping，不等於 diagnostics 理解時間 |
| `host.client_delivery` | result enqueue → benchmark client 完整收到 | daemon IPC、output encoding、backpressure |
| `task.agent_elapsed` | prompt submit → 最後必要輸出完整收到 | 主要用戶等待；不含 fixture setup、offline checker、teardown |
| `run.user_elapsed` | cold CLI launch／warm prompt submit → 最後必要輸出完整收到 | cold 使用體驗含 startup；與 task.agent_elapsed 分開，不把已重疊 startup 再相加 |
| `task.check` | offline checker launch → checker 完成 | 三組相同，另列；agent 自行跑的 tests 仍計入 agent elapsed |
| `run.teardown` | stop 請求 → benchmark-owned process tree 停止 | 與任務 latency 分開 |

每次 provider retry 有獨立 `requestId/attempt`。`retry.backoff`、retry request 與失敗 response 都保留，不只計最後成功的 request。HTTP status、錯誤類型、實際 model ID、usage 分 request 記錄。

### 3.2 Cell：編譯、執行、bridge、I/O 與保存

| Span | 必須再切出的 children | 適用性 |
|---|---|---|
| `cell.provision` | toolchain probes、scaffold copy、skills mount、cache copy/validation、history init | Rust；Python counterpart 為 runtime provision/boot |
| `cell.queue` | 同 runtime cell queue、build permit queue | 分開記，標示各 deadline 是否涵蓋 |
| `cell.source_prepare` | source 備份、library edits、main source write、helper index | 檔案寫入不能算模型生成時間 |
| `cell.validate` | skill gate、library-test snapshot/build/run、policy/probe | 每個額外 Cargo invocation 有獨立 ID |
| `cell.compile` | Cargo spawn、dependency/fingerprint scan、rustc units、link/artifact、diagnostics decode | WASI 控制程式編譯；不含專案 build |
| `cell.python_prepare` | source decode、parse/bytecode compile、imports | Python 仍有 compilation；不能填「0 成本」 |
| `cell.runtime_launch` | spawn → guest entry marker | Wasm load/instantiate/WASI init 若沒有更低層 hooks，保留 combined bucket |
| `cell.guest` | guest entry → guest exit | inclusive wall；不等於純 CPU |
| `guest.compute` | 固定演算法的內部起點 → 終點 | guest local wall + process CPU；模型任意程式無 markers 時 unavailable |
| `guest.input` | read、decode、parse、index | bytes/records/files，分別計 |
| `guest.output` | serialize、write、flush、stdout emit | bytes、output hash、是否真正 fsync |
| `guest.state` | encode、save、load、decode | memory reuse、blob reuse、重新 parse 分開列 |
| `bridge.roundtrip` | guest 發送 → guest 收到完整 reply | guest 同一 clock；payload size/hash、method、sequence |
| `bridge.host` | host 收完整 frame → reply 交給 writer | parse、handler queue、handler execution、encode、write |
| `cell.exit_drain` | guest exit → process reaped/output 完整處理 | 不把 output drain 丟入 guest compute |
| `cell.rollback` | failure 判定 → source/library restoration 完成 | build failure 與 runtime failure 的語意不同 |
| `cell.snapshot` | snapshot start → snapshot 契約完成 | Git/status/hash/add/commit 或 Python serialization/save/debounce |
| `cell.cleanup` | cell stop → bridge/handler cleanup 完成 | handler wait/drain、cancel、scratch cleanup |
| `project.source_write` | 寫入任務的實際 source files | 與 cell wrapper source 分開 |
| `project.build` | native build command spawn → 完成 | 含 dependency resolution、compiler、link，與 `cell.compile` 分開 |
| `project.test` | agent 啟動 tests → 完成 | assertions count、pass/fail、test runner startup 分開 |
| `project.program_run` | 執行生成的程式 → 完成 | runtime/輸出分開於 build/test |

`cell.guest` 包含 I/O 與 bridge 等待，因此 guest.compute、guest.input、bridge.roundtrip 不可以再直接加到它上面。用排他的子區間和 residual；不同 child 重疊時取 interval union。State、snapshot、flush 的持久性保證寫入 metadata，不以同名數字假定保證相同。

**Compiler 能量到哪裡就報到哪裡。** Level 1 是 Cargo process wall/CPU、compiler-artifact 的 `fresh` 與各 unit identity；Level 2 才用支援的 Cargo build timings（記 toolchain/flag）；更細的 rustc parse/typecheck/borrow-check/codegen/link 需要額外 compiler instrumentation，放 profiling lane 並量測 overhead。Cargo 內部平行編譯時，各 unit wall 的和不是 Cargo wall。Python parse/import 若沒有 runtime hook，保留 combined span 與 missing reason，不能從整體 cell 時間猜出來。

Cargo `--timings` 提供 unit durations、dependency critical path 與 Cargo concurrency；不完整呈現 compiler 內部的平行度，binary unit 也未必有 codegen 分段。來源：[Cargo build timings](https://doc.rust-lang.org/cargo/reference/timings.html)。報表依可取得欄位列明 coverage，不承諾所有 rustc 內部 phase 都已可量。

### 3.3 「write code 時間」的四個不同數字

1. **`code_ready_ms`**：該 attempt request dispatch → code/source argument 完整可用。這是「等待模型交出可執行程式」的可觀測時間，含 prompt build、transport、思考與生成。
2. **`code_emission_ms`**：source argument 第一個 decoded UTF-8 byte → 最後一個 byte。Tool JSON 包裝 bytes 與實際 source bytes 分開；同時生成多份 source 記多個 span 和 interval union。
3. **`source_write_ms`**：工具真正把 source 寫入 filesystem 的時間。分控制 cell、helper/library、任務 project 三種路徑。
4. **`time_to_first_correct_artifact_ms`**：prompt submit → 首個通過預定 correctness probe 的 artifact。Probe 放進任務明訂驗證點，計 probe 自身時間；沒有中途 probe 的 E 只報最終 check，不能事後猜第一次何時正確。

另外保存 `source_bytes`、`code_output_tokens`（只有 provider 真正提供此粒度時）、全部 output/reasoning tokens、生成嘗試數、compile error 數與錯誤後重寫 bytes。Provider 沒有 code-only token attribution 時只報 source bytes，不用字元比例冒充 billed tokens。

若串流只拿到完整 tool call，`code_ready_ms` 仍可量，`code_emission_ms` 必須 missing。可以保存 raw tool-argument deltas，在串流結束後依 JSON parser 的 source field byte ranges 回映到原始 chunk timestamps；buffering 已發生的 delta 只代表「client 可見生成窗口」。不能把 reasoning delta、空 tool-call-start 或 response streaming 整段當成 code generation。

每份 source 記 `artifactRole: control_cell | helper_library | project_source`。例如 Rust cell 中嵌入 JavaScript CLI 字串，control cell emission 可量；project source 只有在字串來源範圍可可靠對應 chunks 時才另量，兩個窗口可能包含彼此，不能相加。若程式動態合成 source，記生成動作與實際 artifact write/hash，project source 的模型 emission 標 unavailable；不靠事後檔案大小推定其生成時間。

### 3.4 修復成本

將任務中相同目的的嘗試連成 `repairChainId`：

```text
生成 #1 → source write → compile error → diagnostic pack/delivery
→ repair request → 生成 #2 → compile success → runtime/test error
→ repair request → 生成 #3 → compile success → tests pass
```

保存失敗偵測/diagnostic formatting、repair request 的 headers/first-content/code emission、重編譯、重測、rollback 各自 spans。報 `first_attempt_success_rate`、`attempts_to_correct`、`repair_elapsed_ms`、`repair_output_tokens`、失敗 compile/test 所耗時間。

模型「閱讀並理解 compiler diagnostics」的內部時間不可直接量測；`repair_request_to_code_ready_ms` 是含傳輸與生成的觀測值。以同模型、同原始錯誤、匹配長度的 structured vs rendered diagnostic 做額外 randomized ablation，才能討論 diagnostics 呈現的影響，不從兩產品總時間直接推論。

## 4. Benchmark 工作負載

### 4.1 H：三個 host benchmarks

| ID | 固定工作 | 參數與驗收 | 主要分離的成本 |
|---|---|---|---|
| H01 startup/session-open | 新 CLI/daemon/session 與熱 daemon 新 session | 無 runtime、預置 catalog；empty／1k／10k transcript entries；readiness + final response 相同 | 啟動、load/parse、session hydrate、第一個 response |
| H02 stream/context | replay 相同 reasoning/text；無工具 | context 8/32/128 KiB；output 1/64/1024 KiB；chunk 64/1024/16384 bytes；0-delay 與 paced stream | prompt build、payload encode、stream decode、client delivery/backpressure |
| H03 dispatch/persistence | 共用 command 回固定 checksum | 1/10/100 次 tool calls；result 1/64/1024 KiB；0 或固定 10ms handler work；persisted transcript | tool dispatch、result pack、append、daemon IPC、next-turn gap |

H02 採預定 `(context, output, chunk, pacing)` cases，先不要全笛卡兒積。0-delay replay 測吞吐與 backpressure；paced replay 測是否追得上，server 的 emit schedule 與實際 emit 誤差另列。不要把預設 sleep 減掉後就稱純 host overhead。

### 4.2 R：十六個 runtime benchmarks

Reference cells 均預先寫好；Prime TS/Rust 使用**相同 Python bytes**，wasmedge 用 Rust 等義版。主榜使用標準／既有 prelude 能力，不把 NumPy vs 純 Rust、regex 不同語義或不同排序算法混為同一 case。額外 optimized implementation 另分組。

| ID | 工作負載與規模 | 驗收 | 主要 phase |
|---|---|---|---|
| R01 no-op | stdout 固定 `ok`；fresh session 首 cell／同 session 後續 cell | 精確 stdout，成功 status | provision、queue、compile/parse、spawn、protocol、snapshot 的固定底噪 |
| R02 source/cache | 同 bytes 重送、改一個 literal、改 helper、空 target；依賴預置 | artifact/hash、預定數值，記 actual cache evidence | source write、fingerprint、dependency/leaf compilation、library rebuild |
| R03 CPU integer loop | 10^4/10^6/10^7 iterations 的 uint32 wrapping checksum | oracle checksum；結果輸出避免 optimizer 消掉迴圈 | guest compute wall、user/system CPU、吞吐 |
| R04 data parse/join | deterministic JSONL + CSV，1/16/128 MiB | canonical join output hash、rows；相同 parser 契約與 overflow 規則 | read、decode、parse、hash-index、join、serialize/write |
| R05 repository scan | 100/1k/10k files，各 4 KiB；固定 TODO/FIXME scan | 排序後 path/line/content hash；固定 UTF-8、symlink policy | directory walk、open/read、search、sort、output |
| R06 exact edits | 1/100/1k files 的唯一字串替換，每檔 4 KiB | 新樹 hash、修改數；缺匹配 case 必須拒絕 | read、match、source write、diff pack |
| R07 state across cells | 同 session 5 cells；4 KiB/1 MiB/16 MiB 固定資料 | 5 次預定 query/hash | memory resident／每次 reparse／serialized blob 三種策略；write/load/decode |
| R08 helper reuse | 定義一個 reusable helper，再用 10 cells；中途改 helper | 精確 counts；helper 未改寫與版本記錄 | Python definition/import vs library compile、warm reuse、invalidation |
| R09 bridge | echo requests：1/100/1k；payload 0/1/64 KiB；固定 handler 0/10ms | 所有 sequence、reply hash 正確 | guest roundtrip、host parse/queue/work/encode、transport |
| R10 native command | 從控制 cell 發送相同 pinned shell command；0/10/100ms work | exit code、stdout checksum | bridge/command launch、native command wait、output drain |
| R11 persistence/resume | 1 KiB/1 MiB/16 MiB logical state + helper；save、正常停止、fresh worker resume | 重啟後 hash/query；明列各版本可保證的保存邊界 | snapshot serialize/write/Git、stop、restore、runtime boot |
| R12 deterministic repair | 注入 syntax、type/name、runtime、test-contract 四類錯誤；固定正解下一步 | 各 variant 每步 expected status，最終 oracle；錯誤不得污染下一步 | rejection/compile failure、diagnostics、rollback、rebuild、retest |
| R13 output volume | stdout 1/64/1024 KiB；另大檔寫入 16 MiB | 原始 bytes/hash、model-facing truncation 合約 | emit、pipe drain、truncate、pack、persist、client delivery |
| R14 interrupt/timeout | long compute、handler wait、compile（有此 phase 時）中 cancel；再執行 probe | cancellation receipt、process tree 停止、下一 cell 可用 | time-to-cancel、kill/drain、cleanup、recovery |
| R15 fan-out/resource | runtime sessions 1/4/8，各執行相同 fixed cell | 各結果 hash，無遺失；與 RLM child trajectory 另列 | admission/build queue、per-cell slowdown、throughput、tree memory |
| R16 long session | 同 session 100/1k cells；每 10 cells 更新 4 KiB state | 每階段 checksum、完整 cell inventory | latency drift、transcript/state growth、history maintenance、retained RSS |

R07 的策略不可混池：`resident` 是產品原生語意，wasmedge 沒有跨 cell in-memory resident 便標 not-applicable；三者可比較的 `serialized` 使用相同 on-disk format；`reparse` 讓每 cell 重讀同資料。這直接測 DESIGN D11 的成本，不新增 resident service。

R11 主測正常 checkpoint/resume；另可做 forced crash，但結果必須依各版本實際 durability contract 評分，不要求產品從未承諾的副作用原子回滾。R12 的 type/name 問題可能在 Rust compile 時被拒、在 Python execute 時才被拒，驗收的是各自預定拒絕點與修正結果，不強求錯誤 status 名稱相同。R14 的 compiler cancel 在 Python 組為 not-applicable；比較共同的 compute/handler cases。R15 主榜關閉選配限制且記設定；Linux Bubblewrap/systemd limits 作 wasmedge-only ablation，不能與另外兩組的 unrestricted 數字直接排名。

R01/R03 再做 `prebuilt-runtime-only` 診斷：Rust 使用預建 module；Python 使用預先 compile 的 code object，在固定 warmed interpreter 執行。它們不含完整產品 tool pipeline，因此獨立報表，不替換原 cell totals。WasmEdge AOT 尚非本產品主 lane；若加 AOT，另列編譯成本、執行次數 N 與 break-even，不修改既有 interpreter 政策來爭主榜。

### 4.3 E：十二個正式 coding tasks

優先沿用 [現有 fixtures/checkers](../poc/bench/README.md#tasks-full-set-designmd-appendix-c)，為本實驗建立不可變 version/hash。原始任務不加觀測用中途 checker；scaling 與帶 probe 版另有 task version。

| Task | 任務 | 必須分開評分的工作 |
|---|---|---|
| 01-log-stats | Log 統計報表 | explore、生成 cell、parse/count、write report |
| 02-csv-normalize | CSV 正規化 JSON | schema inference、parse/normalize、serialize、output |
| 03-fix-bug | 修正邊界 bug | read/search、定位、project edit、test command、repair |
| 04-multi-turn-state | 探索後跨回合回答 | first exploration、persist、reload/re-read、second answer |
| 05-toolchain-loop | 修兩個 bug，tests 迭代 | 每次 edit、test、failure delivery、修復、retest |
| 06-build-cli | 寫 wordfreq CLI | 等待 source ready、source write、syntax/test、program run |
| 07-todo-scan | 多檔 TODO/FIXME 索引 | directory scan、match/sort、markdown output |
| 08-rust-rename | Rust 跨檔 rename | search、edits、WASI 控制 cell compile、**native project cargo/test** |
| 09-helper-accumulation | 三回合 helper 建立與重用 | helper author/build、state save/load、reuse、summary |
| 10-lint-fix | 修 lint 並保持行為 | lint command、diagnostics、edit、behavior tests |
| 11-join-report | JSON × CSV join 報表 | parse/index/join、format/write、repair |
| 12-repair-config | 修設定並符合 validator | read requirements、edit、validator、retry |

另有三個 extended tasks，不混入原 12-task D21 集：

- **E13 native Rust CLI**：相同 stdlib-only Rust project skeleton，實作 streaming log aggregator；hidden tests 含空輸入、malformed rows、overflow、排序、1/16/128 MiB input。三組都產出 Rust project。分 `project source generation → project build → test → execute`，另外保留 wasmedge 自身的控制 cell compile。此 task 能把「寫 Rust 專案」與「用 Rust 當控制語言」分開。
- **E14 child fan-out**：固定 4/8 shards、各自 oracle、最終 reduce；H/replay 診斷固定 child trajectories，E 真模型量測 parent dispatch、child ready/code/runtime、join/merge、tokens。不能只把所有 children wall 相加當總等待。三者能力/語意 parity 驗證後才上榜。
- **E15 compaction/resume**：固定長 context 觸發相同預定 checkpoint；保存 schema、helper、large input index，正常 detach/resume 後完成查詢。記觸發前後 context bytes/tokens、compaction provider request、state extraction、checkpoint/restore、重讀、後續修復。三組達不到相同觸發條件時分 product-native 與 forced-checkpoint 診斷，不靜默改 threshold。

本次主實驗 E 使用 `cell-runtime-comparison-v1`：保留各版本原生 system prompt，但僅公開 Python / Rust cell 工具；以對應語言 API 完成讀檔、解析、計算、修改與寫檔，禁止從 cell 委派 shell/subprocess。每回合需有成功執行的 cell，保存生成 source、工具事件、成功數與契約稽核。原任務要求的外部 test/lint 命令由 prompt 明確改為共同 checker 在 agent 完成後執行、另行計時。因此表中原生 project test command 不算入此控制版的 agent 執行時間，原有 D21 的產品測試迴圈另行保留。

`native-tool-choice-observation` 保留產品原生工具與工具選擇，可供另行分析；不能用只走 bash 的 trajectory 回答 Python cell/runtime 對 Rust cell/Wasm runtime 的問題。舊 native 資料保留但排除於 cell 對照。兩個協定的 prompt、case inputs/hash 與 latency 不混池。即使控制了工具，原生 system prompt/schema 仍不同，模型耗時不能解讀成單純 runtime microbenchmark；R lane 才是固定 reference code 的直接 runtime 比較。

## 5. 冷／暖與控制變因

每筆 run 記錄完整 `cacheState`，不用一個含糊的 cold/warm flag：

| Condition | 明確前置狀態 | 比較用途 |
|---|---|---|
| installed-fresh-session | toolchain/deps/catalog 已預置；新 agent dir/session/workspace；無活 worker | 首次實際任務；template target 是否預暖/複製另記 |
| active-session | 同 worker/runtime、前置 cell 已成功；target/namespace 保留 | 連續 cell；Python resident 與 Wasm 每 cell process 的產品差異 |
| empty-cell-target | 刪除**該 run 專有** target；vendor/toolchain 保留 | Rust build-cache miss；Python 無對應 target，not-applicable |
| artifact-reuse | 相同 source bytes 且 compiler 實際回報 fresh/無重編證據 | 真正 cache hit；僅相同 source 不足以認定 |
| checkpoint-restored | 正常保存、worker 停止，從保存 state 開新 worker | resume 成本 |
| setup-empty | 新隔離 install roots/cache，所需 binary/dependencies 尚未準備 | installation/setup lane，網路成本獨立 |

Rust 每次 tool 呼叫重寫 `main.rs`，相同內容不保證 artifact reuse；模板 target 複製也不保證依賴 cache 命中。記錄 Cargo `fresh`、rustc invocation counts、target/template fingerprint、absolute paths、mtime 策略和相關 compiler version，禁止依 case 名稱推定快取命中。

共用規則：

1. 同一 dedicated host，AC power、相同 OS/CPU architecture、固定 Node、Cargo/rustc、Python/uv、WasmEdge executable 及 hashes。macOS arm64 與 Linux x86_64 各自比較，不合併為一個 latency 分布。
2. 三者共用相同 Python executable 與 pinned Python dependency lock 作 H/R controlled lane；若產品無法接受相同 runtime，公開差異並另列 product-default lane。不無聲替換官方 bootstrap。
3. 固定 provider、API、實際 model revision、temperature、reasoning effort/budget、max output、retry policy、region/routing（無法固定就標示）。不要只 pin 可變 alias 或 models.json bytes。
4. 記 native prompt/schema hash、input/output/reasoning/cache-read/cache-write usage；缺 usage 留 null。Prompt caching 記 provider 實際證據，冷／暖 cache 不混池；不能用沒有證據的「cache disabled」聲明。
5. Fixtures 由相同 seed generator 生成，完整檔案 hash/bytes/permissions；先用 oracle 驗兩種 reference implementation，bytes、Unicode、排序、overflow、error policy 相同。
6. 每個 variant/run 都有獨立 agent dir、socket、session dir、project copy、runtime workspace、logs。別接上使用者平常的 daemon/config，credentials 僅由 benchmark 的隔離設定注入，archive 不包含秘密。
7. Setup/fixture copy/source hashing/checker/teardown 的 driver spans 另列。待測 host 本身的檔案掃描、validation、snapshot 保留於 latency；driver 的重驗成本不假稱產品開銷。
8. 不並行跑主 latency campaign；variant order 以固定 seed 在配對 block 內 counterbalance 六種排列。完整六排列週期後剩餘 blocks 的 order imbalance 明列。真正 concurrency 只在 R15/E14。
9. 每次 case 從預定 seed state 建立，不能拿前個 benchmark 的 target/state 污染下一個。R07/R08/R16 的相依 cell order 是工作負載，保留；randomize 的是 variants/blocks。
10. 不清全機 OS caches，不清使用者 Cargo/npm caches；OS/page cache、磁碟、負載/temperature/thermal throttling 可觀測值明列。`empty-cell-target` 不叫 cold OS。

## 6. Trace、輸出與 filtering

### 6.1 每個 run 的檔案

```text
campaign/
  manifest.json                  # 所有預定 slots，launch 前寫入
  sources/                       # instrumentation patches、fixtures/schema hashes
  runs/<runId>/
    meta.json                    # pins、environment、cache/policy、outcome
    events.jsonl                 # 增量 start/end/instant；crash 留 partial evidence
    spans.jsonl                  # 依 schema 正規化的各 phase
    requests.jsonl               # attempts、wire markers、usage、hashes
    cells.jsonl                  # source/artifact/status/cache evidence
    commands.jsonl               # command class、spawn/exit、CPU、I/O
    resources.jsonl              # process tree 的固定間隔 samples
    check.json                   # oracle assertions/pass/fail
    stdout.log / stderr.log
  summary.csv                    # 每 slot 一列；各 phase totals/counts/coverage
  phases.csv                     # 每 run × phase 一列
  cells.csv / requests.csv
  report.html                    # timeline/flame view + filters
```

Report filters：variant、base/instrumented revision、model、task/version、scale、cache condition、packaging、platform、phase、agent/turn/request/tool/cell、outcome、first attempt/repair、policy configuration。每個 aggregate 可回到原始 samples。

UI 至少提供三版本同 scale 的時間堆疊、每 cell timeline、repair chain、compile vs execution scatter、資料量 vs throughput、pass rate vs penalized latency。堆疊用 per-run exclusive categories 的算術平均，不把一組 phase p50 當成可相加的 p50 total。

### 6.2 欄位與缺資料

Normalized record schema 在 [benchmark-trace.schema.json](benchmark-trace.schema.json)。核心欄位：

```text
schemaVersion, recordId, runId, variantId, benchmarkId,
agentId, parentAgentId, turnId, requestId, requestAttempt,
toolCallId, cellId, commandId, repairChainId,
spanId, parentSpanId, name, processId, clockId,
startMonoNs, endMonoNs, durationMs, measurementState, outcome,
attributes, counters
```

`measurementState` 必須區分：

- `measured`：真實 span，有 timestamps/duration，包括失敗階段花掉的時間。
- `not_applicable`：Python 沒有 Cargo target 等，不能報 0ms。
- `not_run`：Rust compile error 後 execution 沒發生；不是量到 0ms。
- `missing`：phase 發生但 hook/record 遺失；該 metric unavailable。
- `incomplete`：crash/abort 未收到 phase 結束；保存起點與 censoring，不猜 duration。

每個 run 必須有 capability/expected-phase inventory；不能只從出現的 spans 算 coverage。Schema example 是合成資料，不是新量測。Schema 驗結構；跨 row 的 ID uniqueness、parent graph、clock、phase coverage、duration consistency 另外驗證。

Monotonic ns 保存成 decimal string，避免 JSON number 丟失精度。TS 用 `process.hrtime.bigint()`，Rust 用 process-local `Instant` origin；wall UTC 只做 provenance。各 process 的 raw monotonic origins 不相減；duration 在各自 clock 內計。跨程序 timeline 用多次 request/reply calibration 的 offset interval 和不確定度，或用 collector receipt 作明確標示的粗略邊界。校準誤差大於要比較的 phase 時，該跨程序 latency 不排名。

Snapshot/handler background work 必須以 links 指向原因 cell/run，並記 settled 邊界；排他 totals 用已校準的 interval union。在 clock 無法可靠對齊時只報各自 inclusive/local durations，不虛構可加總的全樹 breakdown。

報表分開 `inclusive wall`、`exclusive wall`、`CPU work` 與 `critical-path wait`。序列任務在可對齊的 root timeline 上以互斥分類驗證 `agent elapsed = 各分類 interval union + unattributed`，保留 residual 與 coverage；併行 children 的全部工作量與 parent 實際等待分列。不能用 LLM、Cargo、guest、bridge 等所有 parent/child durations 相加還原總時間，也不能直接把階段 medians 相加。

### 6.3 Resource counters

- 每 process 的 user/system CPU（含已退出的 Cargo/rustc/WasmEdge/Python/native command children）、最大 RSS、process spawn count、thread count；runner 使用可取得的 OS accounting，不僅靠事後 `ps`。
- 整棵 task process tree 每 10ms sample current RSS，報 concurrent sum 的 peak、sample interval/coverage；不能把每個 child 的個別 peak 加總稱 tree peak。短命 children 靠 process exit accounting 補充，與 sampled peak 分開。
- Linux cgroup charged memory 與 RSS 是不同量；另記 memory.current/peak/events。macOS 沒有相同 accounting 就留 unavailable，不假造跨 OS memory score。
- input/output bytes、files opened/edited、records、syscall/I/O counters（可取得時）、artifact/target/state/transcript bytes。CPU time 與 wall time 分開；wall 減 CPU 不是精準 I/O wait。
- profiling lane 可加 Linux perf/strace、Node CPU profile、Rust tracing；主榜只用已量測 overhead 的低成本 hooks。

## 7. 統計與細項評分

### 7.1 Sample protocol

- R/H 可重複的 atomic warm cases：每 fresh session block 先 5 warmups，之後 100 measured operations；至少 10 個獨立 session blocks。Operations 不能當作 1,000 個獨立 session。Fresh startup／empty-target／checkpoint restore 的每次 sample 都重建對應前置狀態，至少 30 個獨立 samples，不使用會暖到待測狀態的 warmup。
- R07/R08/R12/R15/R16 是有狀態的完整 trajectory，每個 parameter case 先做 10 個獨立 session/block，不把整個 trajectory 再重複 100 次，也不以 warmup 改變指定初始 state。R14 每個 cancellation case 30 個獨立 samples。R16 的 100/1k 是每 session 的 cells 數；R15 每 block 的固定迴圈長度須在 executable manifest 登錄。
- E smoke：4 tasks × 3 variants × 1 model × 1 rep = **12 runs**，只驗 adapter/trace/oracle，無正式排名。
- E pilot：12 tasks × 3 variants × 3 model roles × 3 reps = **324 runs**，用於估計 variance/成本。
- E formal：相同 matrix × 10 reps = **1,080 runs**；視 pilot variance 決定是否增至 20 reps，決定在正式 campaign 前登錄。Extended tasks/packaging/diagnostic ablations 另建 plans。
- 三 model roles 延續 D21 的 sonnet 級、opus/fable 級、開源權重一家；由操作者填具體 immutable IDs，role 不是本規格對供應商身分的驗證。本次未指定任何付費 campaign 的模型或價格。
- 報 median、mean、min/max、IQR、樣本數及 95% CI。p95 只有在該條件實際有足夠 samples 時報並提示有效 session/block 數；E 每 task 的 3/10 reps 不稱可靠 tail latency；不以少量樣本報 p99。

Ratio 的 95% CI 用 seeded paired bootstrap；以 task 為最外層、matched repetition/session block 為內層，保留三 variants 的配對與每 session 的全部 cells。Model/platform/cache strata 分開。Task aggregation equal-weight，不讓很多 cheap cells 的任務支配總體。

### 7.2 首選：品質與成本向量

每 variant/task/model/condition 輸出：

| 面向 | 細項 |
|---|---|
| 正確性 | full task pass rate、hidden assertions、first-attempt pass、repair 次數、checkpoint correctness |
| 用戶等待 | agent elapsed、first correct artifact（有 probe 才報）、retry/backoff、penalized latency |
| 寫程式 | code ready、code emission、source write、source bytes、output/reasoning/repair tokens |
| 編譯 | cell Cargo、project build、library/test gate build、cache hit evidence、failed compile spend |
| 執行 | runtime launch、guest compute、parse/I/O、bridge wait、native command、tests |
| Host | startup、prompt/payload、dispatch、result pack、transcript/client delivery、next-turn gap |
| 保存 | state encode/write/load/decode、snapshot/restore、Git maintenance |
| 資源 | CPU seconds、concurrent tree RSS、artifact/cache/state bytes、實際 billed cost（usage 完整時） |

同一 metric 基準 `prime-ts = 100`：

```text
latency_score(v, k) = 100 × median_ms(prime-ts, k) / median_ms(v, k)
throughput_score(v, k) = 100 × throughput(v, k) / throughput(prime-ts, k)
quality_score = 100 × passed_runs / attempted_valid_runs
```

數值可以 >100，不截頂。只在同工作/scale/cache/model、metric coverage 完整且兩組 denominator >0 時算相對分數。零 baseline、not-applicable、missing 一律 unavailable；Python 的 Cargo phase 不會因沒有 Cargo 就得到無限高分。跨語言 compile 子項以絕對數字比較、common cell total 才算共同 score。

Runtime reference case 通過全部 oracle 才有 speed score；失敗亦保留 latency/status，不能把錯答案的快當優勢。

### 7.3 失敗與公平的總體排名

保留三份時間結果，不任意丟掉慢／失敗 runs：

1. 全部 valid attempts 的實際 elapsed/outcomes，包括模型失敗、provider retries 與 task timeouts。
2. Successful-only latency，以及三 variants **同一配對 block 都成功**的共同成功子集；列 survivor subset 大小，不稱全任務效能。
3. 預登錄 `taskBudgetMs` 下的 penalized time：成功用實際 agent elapsed，任務失敗/timeout 用該 task budget。Budget 必須是 run 前固定且包含所有 task turns/LLM/tool retries，不能事後用最慢版本調大。

Driver/adapter/inventory/collector 故障為 infrastructure error，不直接算模型失敗，但不能靜默刪除後宣稱 matrix 完整。任何必要 slot 缺失、trace missing 或來源漂移阻止該 comparison 的正式 verdict；若重跑，建立新 attempt ID、保存舊 evidence、固定重跑規則。Provider 的正常可見錯誤/retry 屬 E 產品結果；獨立證明的整批外部 outage 可依預登錄規則另報 sensitivity analysis。

需要單一主速度數字時：先對每 task 算兩組 median penalized time ratio，再 equal-task-weight geometric mean；每 model 分開，另列 95% CI 和 quality。各 phase scores 不拿來混合成「總效能」，因為 phase 可重疊且某些版本沒有該 phase。若日後要求不同 workload weights，先公布使用情境/weights，才跑或重新算，不為結果挑權重。

D20/D21 仍依原 12 tasks、完整 evidence、成功率/output-token 的既有規則另列。`prime-rust` 不可冒充原 A，三版本結果不直接餵給只識別 A/B/F 的舊 analyzer；新 IDs、比較鍵與 D21 compatibility export 都要明確實作。

## 8. 現有證據、缺口與落地順序

### 8.1 可重用的已實作能力

- [cell-timing.ts](../packages/coding-agent/src/core/rust-cell/cell-timing.ts)：v1 runner 有 prepare、skillValidation、libraryTests、buildQueue、cargo、rollback、importPolicy、probe、execution、bridgeCleanup、snapshot、other；同 runner queue 另外列。
- [Rust tool wrapper](../packages/coding-agent/src/core/tools/rust.ts)：已有 provisionMs、totalMs。
- [request-timing.ts](../packages/coding-agent/src/core/request-timing.ts)：已有 dispatch→prompt、payload handoff→headers、first content、stream done、usage。`PI_REQUEST_TIMING=1` 或 settings `requestTiming: true` 可開啟；上游兩個 pinned hosts 也有同類 hooks，但必須逐欄驗語意。
- [runtime.ts](../poc/bench/runtime.ts)：既有無模型十 scenario runner、來源指紋、逐 sample 保存；[歷史 microbenchmark](bench-history/runtime-microbenchmark-2026-10-07.md) 的每 scenario 僅 5 reps，不能作本次三方排名。
- [舊 driver/analyzer](../poc/bench/README.md)：task/provider/launcher snapshots、plan inventory、resume、offline checks 可以重用設計；目前 A/B/F、協議及 transcript 假設不代表已支援 Rust upstream。

### 8.2 必須新增或校正

1. 三 variant adapter：release launcher、隔離 daemon/config、協議 readiness、task turns、snapshot paths、shutdown ownership、model/usage evidence。先跑 contract smoke，不直接換 `BENCH_PRIME_AGENT` 就假定相容。
2. Normalized traces + required-phase inventory；每 request attempt、tool/cell/command 的穩定 correlation IDs；clock calibration 與 schema/graph checks。
3. 兩個 Prime Python runtime 的 queue/parse/execute/host-call/snapshot hooks；wasmedge 的 source-write、Cargo units、guest entry/exit、bridge、state、Git 子階段 hooks。
4. Wire stream tool-argument chunk timestamps，code source field 回映；request first-body marker、明確 transport 邊界。現有 `first-byte` 是 headers，`request-sent` 是 payload handoff，`first-token` 可含空 block start，不能直接換個名字當精準新 metric。
5. OS process accounting、sampled tree RSS、nested native command classification、trace export與 filterable report。
6. `compileMs` 現有範圍包括 build permit wait，failure 時可含 rollback；`runMs` 包含 bridge cleanup。兩者是 legacy inclusive totals，不與 `cargoMs`、`executionMs` 相加，也不冒充純 compiler/guest 時間。新增 breakdown 保留既有 v1 欄位，按 normalized schema 另存。
7. 對 guest 未插 markers 的 E 任意程式，報可觀測 process wall/CPU，guest 子階段 missing。不要為了精細表格，把 runtime total 人為分配到各子項。

### 8.3 執行順序與驗收

| 階段 | 產出 | 通過條件 |
|---|---|---|
| P0 pins + parity | 三版本 release artifacts、effective settings、adapters | binary/source/deps hashes 齊全，runtime/tool/session 行為可對照 |
| P1 collector + replay | H01–03、normalized trace、報表基本 filters | oracle/parity/phase inventory 全通；事件丟失與 incomplete 可被識別 |
| P2 runtime refs | R01–16 的 sources、fixtures/oracles、cache presets | 兩語言 output 契約一致；各 variant 符合預定 success/error/cancel 與恢復契約 |
| P3 instrumentation audit | 開/關 trace 的 paired H/R runs | primary latency instrumentation overhead 的 95% CI 上界 ≤2%；未達則主榜降低 hooks，詳細 profile 另列 |
| P4 E smoke/pilot | 12 smoke + 324 pilot；variance、usage/成本估計 | 調整只進新 plan/task version，正式前固定模型/rep/budgets |
| P5 formal | 1,080 core E + H/R；平台各自報表 | matrix 完整、來源未漂移、check/trace coverage 齊全、CI/失敗報告可追原始 evidence |

Overhead audit 至少記 absolute overhead：原生 no-op 太短時，單看 2% 會不穩；若 CI 無法支持閾值，該細粒度 lane 只作診斷。不可用估計 overhead 直接扣主榜時間。

所有 artifacts 保存 checksums；正常與 failed attempts 同樣保留。公開 summaries/source patches/schema/oracles，raw provider payload/credentials 與敏感 project 內容只放受限 archive。只清理這次 benchmark 建立的 process trees/workspaces；不動一般工作 daemon、config 或 cache。

第一輪最有辨識力的順序：**H01/H03 → R01/R02/R09 → E03/E08/E09/E11**。先量出固定成本、cache、bridge 與修復鏈，再擴充大資料/長 session/並行；全程維持上述分層與 pins。

## 2026-10-08 實作補充：全部 Cargo 與 cell 執行對照

使用者指定原先 cell compilation 扣除擴成全部 Cargo。新 campaign 預設透過 Cargo-only PATH wrapper 與正式 runtime 的 WASMEDGE_AGENT_CARGO 入口捕捉所有命令；初始化、skill probe、cell、library gate、checker、輔助命令與失敗重試均在 scope。扣的是整個命令 wall time，cargo test 包含測試時間，並非純編譯時間。每 run 保存完整起訖 ledger 與三次 child monotonic clock 對齊取樣；開始／結束不完整、ID 重複、時鐘不符或舊資料未捕捉完整 Cargo 時，一律 unavailable。入口以外自訂的絕對 Cargo 路徑不在本固定矩陣驗證過的 coverage 內。

預設新比較邊界 run.validated_elapsed 是初始化到共同 checker 完成，不含 benchmark fixture/capture setup 與 teardown；原 run.user_elapsed 到 agent 完成、task.agent_elapsed 不含 daemon 啟動與 checker 的邊界不變。逐 run 對 Cargo 區間取聯集，再裁切於所選邊界，最後原始 elapsed 減聯集 wall time。平行 Cargo 不重複扣、checker Cargo 不從 agent elapsed 扣、cell.compile 與 rustc child 不再加上去。每對 raw/adjusted medians 使用同一批成功且符合 cell 契約的 runs。這是算術扣除，不是實際免 Cargo rerun；Node wrapper 啟動成本仍在剩餘耗時，overhead 未審核，與舊 lane 分開報告。

新增 cell 執行表使用 kernel 的 cell.python_execute / Rust runner 的 cell.execution，而非可能批次送出的 client tool 事件窗口。每 run 報 cell 次數、成功／runtime 失敗／compile 失敗、runtime 時間合計、成功 cell 平均與失敗執行成本。編譯失敗的 cell 沒有 runtime 執行時間；有 runtime 失敗的成功 trajectory 保留失敗成本。平行 cell durations 合計表示工作量，不表示任務 wall time。Python 0 ms 回報低於解析度；不同產品的執行邊界含各自的 launch/I/O/bridge，不能當純 CPU 或固定生成程式的 speed ratio。
