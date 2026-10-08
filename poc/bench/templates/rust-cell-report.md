# Rust cell 安全性與效率統整報告

更新日期：2026-10-08。比較對象為 Prime Agent 的 TypeScript host／Python cell、Rust host／Python cell，以及 wasmedge-agent 的 Rust cell／WasmEdge interpreter 和 AOT。最新四組實驗與歷史診斷分開呈現。

**直接分享這個 HTML 檔案即可。** 結論、圖表、重要數據表與計時定義都在檔案內，可離線開啟；只有選讀的官方來源引用需要網路。

<a id="conclusions"></a>

## 先看結論

| 讀者關心的問題 | 量測結論 | 實際意義 |
|---|---|---|
| 為何使用 Rust cell？ | 執行前編譯檢查、明確 guest 權限、可保存的來源與 state | 核心價值是可控、可檢查的執行單位；host 與 compiler 仍需各自限權 |
| AOT 有改善嗎？ | Data join：{{join_before}} → {{join_after}} ms，**執行時間降低 {{join_reduction}}%** | 此固定工作量有效；AOT 編譯另列，完整任務仍包含該成本 |
| Bridge 改善有效嗎？ | 100 次 echo：{{bridge_before}} → {{bridge_after}} ms，**process 時間降低 {{bridge_reduction}}%** | Readiness 消除 polling 等待；加入 AOT 再降至 {{bridge_aot}} ms |
| 這輪 Rust 比 Python 快嗎？ | 六個固定案例的 Rust／AOT cell 合計仍高於兩個常駐 Python kernel | 短 cell 仍負擔新 process／VM；本矩陣沒有 Rust 普遍勝出的證據 |
| 證據範圍多大？ | **固定程式 72/72、任務 16/16、安全測試 65 項通過** | 固定 n=3、任務 n=1；14 項 Linux 測試略過，是本機結果而非全面效能排名 |

<a id="runtime"></a>

## 1. 效率的固定程式對照

最新固定程式測試為 6 cases × 4 variants × 3 repetitions。兩個 Wasm 模式使用完全相同的 Rust reference sources，Python 使用等義操作與共同輸出契約。這一層排除模型生成差異，適合判讀 runtime 原因；不是不同語言產生完全相同機器指令的對照。

以下是每 run 的 cell 執行時間合計，再取 3 次 run 的 median，單位 ms。**排除 Cargo／AOT compilation、初始化與 snapshot；Rust 執行仍包含新 process、module／VM、guest、bridge 和 output drain。** Python 為常駐 kernel 回報，0 ms 代表低於整數毫秒解析度。R01／R04 各有兩個 cells。

![固定程式四組 cell 執行時間](assets/rust-cell-report-2026-10-08/runtime-linear.svg)

{{runtime}}

固定程式的 data join 從 interpreter {{join_before}} ms 降至 AOT {{join_after}} ms，執行成本約降低 {{join_reduction}}%；repository scan 與 bridge 也改善。短 CPU cell 的 AOT {{cpu_aot}} ms 仍高於兩個 Python kernel 的 {{cpu_python}} ms；每個 cell 啟動新的 process／VM 是重要固定成本。這支持按 workload 選 execution mode，沒有支持「Rust 編譯後就一定比較快」。

先前固定診斷也確認 Python JSON 走 `_json` C accelerator，而 Rust `serde_json` 在 interpreter 中逐指令執行。近空程式的 process wall time 約 8–10 ms；guest 計算本身可以很短，但整個 cell 仍受 launch／load 等成本影響。原慢因分析保存 CPU／JSON／regex／state 的 body timers；其中 AOT／1 ms polling 是修正前的診斷控制，已實作的 AOT 路徑與 readiness 更新見下文。

<a id="bridge"></a>

## 2. Bridge 改善的因果對照

使用相同的 `diff.rs`／`bridge.rs` source bytes、同一 host handlers 與 1 KiB payload。舊 polling、新 readiness interpreter、新 readiness AOT 輪替執行；每模式／案例 2 warmups + 15 measured samples，總計 102 個樣本全部保存。下圖與表只採 measured samples 的 median。

![Bridge 前後交錯量測](assets/rust-cell-report-2026-10-08/bridge.svg)

{{bridge}}

100 次 echo 的 process 執行時間從 {{bridge_before}} ms 降至 {{bridge_after}} ms，readiness 修正降低約 {{bridge_reduction}}%。正常 WASI reply reads 改以 `poll_oneoff` 同時等待 stdin 就緒與 monotonic deadline，資料抵達即可讀取；native TCP 與罕見 write retries 仍保留既有 polling。

AOT 再降至 {{bridge_aot}} ms。下表另列 guest body median，不含 process 啟動及 module／VM 準備，支持 readiness 去除等待後，interpreter／JSON framing 等工作仍有優化空間。此次對照不與較早排程環境不同的 bridge median 混算。

上述 AOT 執行前另花約 2.74／2.76 秒編譯。若未來可信 artifact 可以重用，在此固定 100-echo workload 下，以 2.76 秒除以每次約 54.57 ms 的執行節省，約需 **51 次**才回收一次 AOT 編譯成本。這是固定程式與未來重用前提下的算術估算；目前每 cell 重編，沒有這個 amortization 收益。

### Guest 本體計時

{{bridge_body}}

這是相同交錯控制樣本的另一個計時邊界。Body 與 process 的 median 不可直接相減，重建成個別 phase 耗時。

<a id="aot-details"></a>

### 已實作的 AOT 路徑

`rustCell.runtimeMode` 預設 `interpreter`，`aot` 是另加的第四組。AOT 先檢查 imports、移除 guest 所有 custom sections，再由 host compiler 以 `--interruptible` 及設定所需的 gas instrumentation 產生 native payload。Core Wasm 必須與檢查輸入相同，native payload 必須存在；驗證失敗就停止，不靜默回退 interpreter。每 cell 重編，沒有 AOT cache。Skill／library tests 仍使用 interpreter。

剝除後 input、AOT output 與 SHA-256 provenance 保存於 host-only `.aot/`，不對 guest preopen。編譯與執行共用 timeout、cancellation、process-limit 設定。本次固定 WasmEdge 0.14.1 CLI 自動載入 AOT，flags 由保存的命令紀錄識別，未使用新版本的 run-mode flag。

`aot.command` 為 compiler spawn-to-close 時間，不包含 Node wrapper 自己的啟動；`cell.aot_compile` 另含 stripping、verification、provenance，與 runner `cell.execution` 不重疊。全部 Cargo capture 涵蓋初始化、cell、library gate、重試及 checker；扣除量依任務時間邊界裁切，命令重疊只計一次。

<a id="tasks"></a>

## 3. Opus 5.5 的完整任務結果

4 tasks × 4 variants × 1 repetition，16/16 通過共同 checker 與逐回合 cell 契約，共 70 次付費模型 requests。Route 為 `anthropic/claude-opus-5-5`，reasoning off；服務 advertised model ID 已保存，不可變 backend revision 未獨立驗證。

每個模型回合至少一次成功的 Python／Rust cell；讀檔、計算、修改與寫檔在 cell 完成。實際 sources／library edits 已逐份檢視，沒有 shell／subprocess 代做。Node／Cargo 等共同驗收在 agent 完成後執行、另計時間。這不同於產品允許 native command tools 的任務迴圈。

### 原始 agent 時間

單位秒，包含 workspace 初始化、模型 requests、工具執行與生成程式的修錯；排除 daemon 啟動與 agent 完成後的 checker。每格只有一次實測。

![Opus 5.5 任務與編譯成本](assets/rust-cell-report-2026-10-08/paid-agent-all.svg)

{{paid_raw}}

### 全部 Cargo 與 AOT 分開扣除

以下同樣使用 **agent 期間**，單位秒。Cargo 包含此期間內所有 runtime-managed Cargo 命令，包括初始化、library gates、失敗重試；`cargo test` 整段 wall time 含測試，並非純 compiler CPU。AOT 是 WasmEdge compiler 的命令 wall time。重疊取區間聯集、裁切於 agent 期間；期外 checker 不從 agent elapsed 扣除。

{{paid_compilation}}

Python 四個 agent 期間的 Cargo／AOT 扣除量均為 0，扣除後等於上表；E08 的共同 checker Cargo 只在含驗收期間扣除。圖形報表另可切換「全部 Cargo」及「全部 Cargo + AOT」，並可選 agent／user／初始化到驗收完成的時間邊界。扣除是對同一筆量測做算術分解，沒有把程序真的免編譯重跑。

E09 AOT 的 3 次 regex compilation 合計 **29.31 秒**，造成原始 agent 時間 59.57 秒；扣除全部 Cargo + AOT 後約 25.14 秒，interpreter 約 30.46 秒。這只說明本輪分段：生成 sources／cell 次數不同，不能用扣除後的大小當純 runtime speed ratio。

### Cell 執行與修錯成本

<!-- paid-cell-chart -->

{{paid_cells}}

成功／runtime 失敗／Cargo 失敗欄為 cell 次數；所有 AOT compiler failure 均為 0。合計 {{cell_calls}} cells，{{runtime_failures}} 次 runtime errors、{{cargo_failures}} 次 Cargo compile errors，均在成功 trajectory 中修復，成本完整保留。E09 的 Prime TS、Prime Rust、interpreter、AOT 分別呼叫 11、5、5、3 次 cells；Python resident imports/cache 與 Rust 新 process 的狀態行為也不同。可維護 helpers 的價值已有實際 trajectory，但目前無跨任務長期 token／金錢節省的量測。

### 模型 requests 與 token 用量

以下合計同一輪四個任務的所有模型 requests，包括修錯與後續回合。Prompt tokens 含 cached tokens；cached 欄是其中的子集，不重複相加。這是產品 trajectory 的用量，不是固定程式 runtime 指標。

{{usage}}

本輪 Rust／AOT 比 interpreter 少 2 次 requests、578 個 output tokens；模型生成程式與修錯路徑不同，沒有證明 AOT 會讓模型固定減少 tokens。Rust cell 的 output 用量也沒有一致低於兩個 Python 版本。服務未提供本輪完整帳務明細，沒有用 token 數推算實際付費金額。

<a id="value"></a>

## 4. 核心價值與證據

| 價值 | 目前可支持的主張 | 證據與適用條件 |
|---|---|---|
| 限制模型程式的能力 | Guest 只能使用允許的 WASI imports 與明確 preopens；直接 socket imports 在執行前被拒絕 | Interpreter／AOT 真實 WasmEdge 測試都驗證了 `sock_open` 拒絕；host handlers 的能力另由 host 決定 |
| 縮小憑證暴露面 | Guest 只接收 host 選擇的環境；Cargo／AOT compiler 不繼承未列入 allowlist 的環境變數 | Environment allowlist 與 AOT compiler tests；未啟用 Cargo sandbox 時仍可能讀取 host 檔案或 Cargo config |
| 控制失控執行 | 可限制 guest gas、linear memory pages 與 cell deadline；錯誤設定不降級執行 | Interpreter／AOT 的 gas exhaustion 與 memory growth 負向測試；gas／page caps 需設定，並非全流程 RSS 限制 |
| 提早發現程式錯誤 | Rust 型別、借用與 ownership 檢查在 guest 執行前進行；失敗 build 不執行新 cell | Compiler diagnostics、來源回復與實際付費修錯紀錄；不保證業務邏輯正確，也可能增加修錯 round trips |
| 累積可維護的能力 | Helpers 以 `agent_lib` 原始碼保存，state 顯式落盤，成功 cells 有 workspace Git snapshots | Workspace／library gate／snapshot 實作；沒有任意 in-memory namespace、交易式副作用回滾或位元級 deterministic replay 保證 |
| 降低特定執行成本 | AOT 降低 interpreter 的 JSON／regex 等執行成本，readiness bridge 降低固定 polling 等待 | 固定程式四組對照與 bridge 前後交錯量測；必須另計 Cargo、AOT 與新 process 成本 |

可對外表達的主張是：**Rust cell 提供可檢查、可限權、可保存的執行單位；WasmEdge AOT 為運算較重的程式提供效率改善的路徑，bridge readiness 已降低互動成本。** 目前實測不支持把所有任務概括為比 Python 更快、更省記憶體或更省模型費用。

<a id="safety"></a>

## 5. 安全性提升的範圍

### 預設控制與可選控制

| 控制 | 預設或啟用方式 | 可限制的範圍 | 驗證與限制 |
|---|---|---|---|
| 非網路 WASI import allowlist | 預設 | Guest 的直接 socket、plugin、未知 module imports | Imports 檢查只驗證、不在 Node host instantiate guest；拒絕在 guest 執行前發生 |
| 明確檔案 preopens | 預設 | `/workspace`、`/agent/state`、`/agent/lib`、`/scratch` | `/workspace` 預設可寫；guest library mount 唯讀，來源編輯經 host tool 的 `lib` 參數 |
| Project 唯讀 | `workspaceWritePolicy: "ro"` | Guest 對 project 的寫入、刪除、改名等 | 真實 WasmEdge 負向測試；mount overlap／symlink／colon ambiguity 檢查防止可寫別名；host handlers 不受此 guest mount 限制 |
| Host stores 隔離 | 預設 mount 檢查 | Writable preopens 與 harness stores 的路徑重疊 | 檢查既存 ancestors 與 symlinks；不涵蓋任意 host hard links／並行 filesystem races |
| Compiler environment allowlist | 預設 | Parent ambient credentials／flags／wrappers 的一般繼承 | 不等於 compiler filesystem 沙箱；既有 sources/artifacts 不清除過去的資料 |
| Cell timeout | Runner cell budget | 編譯、AOT、執行與 bridge 的該次 cell 流程 | Runner queue、workspace provisioning 不在該 cell deadline；host handler 已產生的副作用不自動撤回 |
| Guest gas 與 memory pages | `cellGasLimit`／`cellMemoryPageLimit` | Guest 指令成本與每個 linear memory 的頁數 | AOT 以 `--interruptible` 與必要 gas instrumentation 產生；不是 compiler／host／整棵 agent tree 的總額 |
| Cargo process sandbox | Linux `cargoSandbox: "bubblewrap"`；預設 off | Build scripts／proc macros／`include_str!` 可見 filesystem 與編譯網路 | 不可用時 fail closed；macOS 本輪未啟用；host-managed vendoring 有獨立網路政策 |
| Invocation／tree 資源限制 | Linux `processLimits`／`treeProcessLimits`；預設 off | Cargo／WasmEdge descendants 的 charged memory、CPU bandwidth、processes／threads | cgroup v2／systemd／Bubblewrap 前提；不含 Node host、bash、host handlers，沒有 disk quota |
| 可信 AOT artifact | `runtimeMode: "aot"`；預設 interpreter | Guest 自帶 native payload 繞過 Wasm inspection 的路徑 | 先檢查 imports，剝除 guest custom sections，host 重新編譯；核對 core Wasm 與 native payload、保留 SHA256 provenance；沒有 AOT cache |

兩個 pinned Prime Agent README 都明確說明 Python 與 project commands 以使用者權限執行，worker／kernel 分離是生命週期隔離，並非安全沙箱。對照的 kernel startup 也會複製 parent environment。這是本實驗固定 revision 的差異；Python 同樣可以另外配置外部 sandbox，沒有宣稱所有 Python 架構都無法限權。

Rust ownership 檢查能在編譯階段排除一類錯誤；這是 [Rust 官方文件](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html) 描述的語言特性。Python 本身也有記憶體管理，不能用「Python 沒有記憶體安全」作比較。Host 存取權限的差異主要來自 Wasm／WASI 能力配置與 runner 政策，[WASI 官方定位](https://wasi.dev/)也強調 capability-based security；Rust 語言本身不提供 OS 沙箱。Unsafe code、native dependencies、compiler、runtime、host handlers 仍須納入信任邊界。

### 已重驗的安全性證據

{{validation}}

這輪在 macOS 使用真實 WasmEdge 執行：interpreter／AOT 的禁止 socket import、gas 耗盡、memory growth 限制、large UTF-8 bridge 與 timeout 後 fresh handshake 均通過；project 唯讀測試使用 interpreter。Environment、import allowlist、mount aliases、AOT stripping／provenance／fail-closed 另有 unit tests。Linux Bubblewrap／cgroup 的真實測試因平台前提略過，不能把 macOS 結果當成 Linux enforcement 實證。完整設定與未涵蓋的 host 路徑見 runtime trust boundary。

<a id="architecture"></a>

## 6. 比較的四組架構

{{variants}}

Prime Agent 的 Rust 版本改寫的是 host，cell 仍為 Python。wasmedge-agent 目前仍使用 TypeScript host；本實驗的 runtime 差異是 Python kernel 與 Rust／Wasm cell。最新 interpreter 與 AOT 兩組共用同一份 fork source/build 和更新後的 bridge，只有 runtime mode 不同。

Python 重用常駐 kernel 與記憶體；Rust 每個 cell 是一個完整程式，啟動新的 WasmEdge process／VM。跨 cell 的 helpers、state 與 project files 由磁碟保存。這使持久內容更明確，也意味著大型資料、JSON 和 regex 可能每 cell 重新載入或建立。

![Cell 的能力與信任邊界](assets/rust-cell-report-2026-10-08/boundary.svg)

<a id="diagnosis"></a>

## 7. 為何 Rust cell 原先較慢

| 機制 | 已確認的證據 | 已處理或仍存在的成本 |
|---|---|---|
| 新 session 的初始化 Cargo | 前次正式 provisioner 診斷：無 skill 約 0.35–0.39 s；加入 websearch skill 約 4.61–5.05 s，主要為 probe build | 全部 Cargo ledger 現在納入；仍有實際初始化成本，沒有在此宣稱已消除 |
| 每 cell 新 WasmEdge process | 近空程式診斷及最新 R01 成功 cell 平均約 8 ms | AOT 保留 process／VM 成本；embedded runner／reuse 尚未完成 |
| Interpreter 的 JSON／regex 工作 | 同 artifact AOT 控制與最新固定程式 join 大幅改善 | 已新增可信 host AOT；編譯另計，interpreter 保留 |
| Bridge 固定 5 ms polling | 同程式前後交錯量測、guest body 等待降低 | 正常 WASI reply read 已改 readiness + deadline |
| 每 cell 重新建立資料／regex | E09 source 與 body timers；state 為檔案存取，沒有走 bridge | 顯式 state 可保存預處理結果；常駐資料服務／跨 cell compiled regex cache 尚未實作 |
| 模型輸出與修錯 trajectory | 前次 E11 Rust 輸出 tokens 更多；最新 E08 Cargo failures 與 E09 cell 次數不同 | 屬產品效率的一部分，需保留 request／diagnostics／失敗成本，不能全歸因給 Wasm |

### 先前控制實驗：guest 工作與完整 cell 的差距

以下是 readiness 更新前的診斷；每組 2 次 warmup 後量測 15 次取 median，interpreter／AOT 使用同 artifact。Body timer 在 guest 內，不含啟動／載入；不與最新六案例矩陣混算。

| 固定工作 | Interpreter cell ms | AOT cell ms | Interpreter body ms | AOT body ms |
|---|---|---|---|---|
| 近空程式 | 8.361 | 7.026 | 未設 body timer | 未設 body timer |
| 100,000 次 CPU 運算 | 10.690 | 6.616 | 2.022 | 0.023 |
| 10,000 筆 JSON parse | 223.773 | 9.009 | 211.703 | 1.220 |
| Regex 與保存的 state | 31.237 | 10.308 | Regex 4.574；match 3.484 | Regex 0.161；match 0.048 |

對應 AOT compiler 命令另花 1.407、1.505、1.822、10.810 秒，未包含於 cell 欄。Guest 計算變快不會消除 process／VM 固定成本。Python JSON 使用原生 `_json` accelerator；Rust JSON 在 Wasm 執行，library 路徑不同。

<a id="timing"></a>

## 8. 細分計時與資料解讀

| 問題 | 已量測的邊界 | 解讀 |
|---|---|---|
| Write code 花多久 | `llm.tool_arguments_generation`、`llm.code_emission`、`llm.code_ready` 與保存的 SSE／cell sources | Source tool arguments 從 wire stream 出現至完成的可觀測區間；不等於服務端純生成時間或模型思考時間 |
| 寫入 Rust source／準備 mount | `cell.source_prepare`／runner `prepareMs` | 包含來源與 mount/state 準備；沒有單獨 isolate write syscall 時間 |
| 初始化／provisioning | `host.daemon_startup`、`cell.provision`、各期間邊界和全部 Cargo ledger | 必須保留在實際使用時間；不與嵌套 Cargo 重複相加 |
| Rust → Wasm | `cargo.command`、主 cell `cell.compile`／`cargoMs` | 全部 Cargo 命令有 ID、argv、cwd、起訖、outcome 與 clock calibration；typecheck／codegen／link 未完整拆分 |
| Wasm → AOT | `aot.command` 與 `cell.aot_compile`／`aotCompileMs` | 命令計時與 host strip／verification 外層 phase 不相加；後者還含 wrapper 啟動等外層工作 |
| Runtime 執行 | Python `cell.python_execute`、Rust `cell.execution` | Rust 包含 launch／load／VM／guest／bridge／I/O；paid cells 沒有完整 guest body partition |
| Cleanup／持久化 | `cell.bridge_cleanup`、`cell.snapshot`、`cell.other` | 成功 snapshot 的時間和失敗 attempts 均保留；Git 失敗不重執行已成功的 cell |
| 完整任務 | `task.agent_elapsed`、`run.user_elapsed`、`run.validated_elapsed`、`task.check` | Agent 排除 daemon／checker；user 包含 daemon 到 agent 完成；validated 包含初始化到共同 checker 完成 |
| 資源效率 | Schema 預留 CPU user/system、peak tree RSS；此輪沒有完整資料 | 沒有宣稱 Rust memory／energy 優勢；Wasm memory cap 與實際 RSS 節省是不同問題 |

Cell 圖的「每 run 合計」包含成功與 runtime 失敗的執行；Cargo／AOT 失敗不算 runtime。成功 cell 平均先逐 run 算，再取 median；cell 合計是工作量，平行時不是任務 wall time。

顯示語意統一：**「完整量測、扣除量 0」**表示 ledger 完整且該期間沒有 compiler 命令；**「此版本沒有 AOT 階段」**表示不適用；**「無法計算」**表示資料不足；**「未納入比較」**表示未通過驗收／cell 契約。沒有把缺失回填為 0。Python 0 ms execution 表示解析度不足，並非零成本。

<a id="method"></a>

## 9. 實驗環境與證據沿革

環境為 Darwin 25.6.0 arm64、Apple M5 Max、18 logical CPUs、128 GiB RAM、Node 24.13.1、Cargo／rustc 1.98.1、WasmEdge 0.14.1；Rust host、adapter、guest 採 release。最新 fork baseline 為 `48d6312570f7d39809703db2c69a43f342fb7424` 加保存的未提交 runtime source patch，不能只用 commit ID 重建；prepared inputs／launcher／template／collector hashes 與原始成果均保存。

歷史 campaigns 包含 host replay、native tools 與不同 Cargo capture 規則，完整結果本機保存，未併入最新比較。

舊 host/replay、native-tool policy、runtime-only、完整 Cargo capture 和最新 AOT campaigns 各有不同控制，不混成總平均。首次 runtime campaign 的 bridge adapter 與 native-command adapter 失敗仍保存；最新固定程式矩陣通過的是列出的 6 cases，不是全部設計中的 16 cases。2026-08 的可行性研究、舊 12-task benchmark和 2026-10-07 microbenchmark為歷史背景，runtime／模型／環境不同，不併入此次速度結論。

最新兩個 campaigns 共 {{spans}} spans，schema／integrity 檢查皆無錯誤；Cargo {{cargo_commands}} 條、AOT {{aot_commands}} 條命令 capture 完整。每次 paid response、生成程式、修錯、session、project outputs、checker、失敗 attempts 都保留。先前實際 key 掃描的已檢文字檔案沒有外洩；這是保存成果的指定掃描範圍，不是全系統秘密偵測。

固定程式每組 n=3，付費任務每組 n=1；沒有 confidence intervals、跨平台複驗或完整 instrumentation overhead audit。結果足以說明本機 workload 的成本與修正效果，尚不足以估計跨任務穩定勝率。模型 ID 也不等於獨立驗證的 backend revision。

<a id="aot-validation"></a>

### AOT 實作時保存的驗證

實作時的 root checks 與全 workspace build 通過；真實 interpreter／AOT integration 15 tests 通過，涵蓋 large UTF-8 bridge、禁止 socket imports、timeout 後 fresh handshake、gas exhaustion、memory-growth caps。Native bridge release tests 12/12 通過，其他相關 suites 86 tests 通過、3 個環境限定 tests 略過。這些是先前實作驗證，與上文安全重驗的 65 pass／14 skip 分開，不能合計成單一 suite。本次編輯報告沒有重跑 runtime tests。

| 最新 campaign | Schema-valid spans | Cargo commands | AOT commands |
|---|---|---|---|
| 固定程式：72 runs | 3,822 | 54 | 24 |
| Opus 任務：16 runs | 1,600 | 32 | 8 |

全部 88 runs 均可計算 Cargo-only 與 Cargo-plus-AOT 扣除。付費 sources／library edits 已檢視 shell／subprocess 委派，修錯成本完整保留，所有 AOT compiler failure counts 均為 0。Wrappers 與小樣本仍限制效能主張。

<a id="next"></a>

## 10. 採用與下一步

**適合優先採用 Rust cell 的情境**是需要明確 guest 能力邊界、受控資料存取、可檢查的型別化 helpers，以及可保存、可 review 的長期程式資產。需要更強 compiler／tree 隔離時，應在符合前提的 Linux 啟用相應 controls，再以負向測試驗證部署設定。任務是否受隔離仍取決於工具和 host handlers 的權限。

**效率選擇應按工作量決定。** 短小且程式常變的 cells，interpreter 避免額外 AOT 成本；JSON／regex／bridge 密集的 cells，AOT 已降低執行時間，但目前每 cell 重編，必須把 compiler 費用放回實際總時間。較少的 cells、批次處理和顯式預處理 state 是現有 API 可採的方式，尚未量測其普遍節省。

| 下一步 | 預期改善 | 驗收方法 |
|---|---|---|
| 按 inspected Wasm／compiler／flags／platform 識別的可信 AOT cache | 相同程式的編譯攤提 | Cache hit／miss 分開、失效與污染負向測試，重用時仍符合 import／resource policy |
| Embedded runner／減少 process 固定成本 | no-op／短 cell latency | 每 cell 保持新的 instance／能力邊界；量 launch、load、guest、cleanup，而非只看 guest timer |
| Template／skill probe cache 與初始化並行 | 新 session 首次請求 latency | 保留來源／toolchain 變動失效，分 cold／warm／resume；避免阻塞 Node event loop |
| 更大、重複且配對的 Opus 任務矩陣 | 可對外泛化的速度／成功率／token 成本 | 預先固定 tasks／budgets／樣本規則，保留 failures、CI，先審核量測 overhead |
| 安全性攻擊矩陣 | 防護完整性的比較 | 非 preopen／symlink／compiler／credentials／gas／AOT payload／bridge 方法逐項測試；Python 另列是否有外部 sandbox |
| CPU／RSS／memory 指標 | 效率主張的資源面 | 將 compiler、WasmEdge、host handlers 與 tree 邊界分開；實際資源使用與配置上限分開報告 |

<a id="sources"></a>

## 證據識別與重建

讀者作決策需要的數據已整合於上文：六案例 runtime、bridge 控制、完整任務、全部 Cargo／AOT 扣除、cell 失敗、模型用量、安全測試與計時定義。原始 traces、生成程式及歷史 dashboards 本機保存，閱讀本報告不需要它們。

下列來源 SHA-256 用於識別保存的證據；hash 本身不是可重現套件。重跑實驗需要 baseline 與 runtime patch。重建閱讀版只使用 Git 中的精簡 aggregate、模板與 SVG，不重跑 benchmark、不呼叫模型。

`uv run --with markdown==3.10.2 python poc/bench/consolidated-report.py` 產生中英文單檔 HTML。只有原始本機證據仍在時才使用 `--refresh-evidence`，另需 Matplotlib 3.10.8；該選項稽核既有資料，不發出模型請求。

{{provenance}}

選讀官方來源：[WasmEdge AOT 說明](https://wasmedge.org/docs/start/build-and-run/aot/)。
