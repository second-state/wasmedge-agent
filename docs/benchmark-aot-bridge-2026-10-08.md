# AOT 與 bridge readiness 實測（2026-10-08）

新增 `wasmedge-aot` 第四組；原 `wasmedge` 維持 interpreter。兩組均使用更新後的 bridge，原三組 campaign 與其原始檔案保留。

- [四組固定程式圖形報表](../poc/bench/results/four-way-aot-bridge-runtime-01/report.html)：6 cases × 4 variants × 3 repetitions，72/72 通過，0 付費 requests。
- [四組 Opus 5.5 圖形報表](../poc/bench/results/four-way-opus55-aot-bridge-01/report.html)：4 tasks × 4 variants × 1 repetition，16/16 通過，共 70 次模型 requests；完整付費來源、SSE、工具與 checker 紀錄保留。
- [Bridge 前後交錯量測](../poc/bench/results/bridge-readiness-diagnostic-20261008-01/measurements.json)、[median CSV](../poc/bench/results/bridge-readiness-diagnostic-20261008-01/summary.csv)。

## 固定程式的 cell 執行時間

以下是每 run 的 cell 執行時間合計，再對 3 次 runs 取 median，單位 ms；排除 Cargo 與 AOT 編譯，但 Rust 包含每次 WasmEdge process 啟動、module 載入、VM、guest、bridge 與 output drain。Python 重用 resident kernel，0 ms 表示低於其整數毫秒解析度。R04 有兩個 cells，不是單一 parse body；報表可切換成功 cell 平均。

| Case | Prime TS / Python | Prime Rust / Python | Rust / interpreter | Rust / AOT |
|---|---:|---:|---:|---:|
| R01-noop | 1.000 | 0.000 | 18.162 | 15.922 |
| R03-cpu | 5.000 | 5.000 | 10.306 | 8.224 |
| R04-data-join | 8.000 | 6.000 | 293.578 | 21.266 |
| R05-repository-scan | 3.000 | 2.000 | 37.079 | 11.805 |
| R09-bridge | 8.000 | 6.000 | 64.415 | 15.182 |
| R12-error-repair | 1.000 | 0.000 | 9.120 | 8.154 |

AOT 減少 interpreter 的運算／JSON／regex 執行成本，但不會移除新的 WasmEdge process 與 VM 固定成本。短 CPU cell 此輪仍慢於 Python kernel；no-op 成功 cell 平均約 8 ms，支持固定成本對短 cells 影響顯著，並非已單獨量出 process launch 的耗時。

## Bridge 的因果對照

使用前次診斷保存的 `diff.rs` / `bridge.rs` 相同 source bytes，舊 polling Wasm 與新 readiness Wasm 交錯跑，每組 2 warmups + 15 measured repetitions。三模式輪替順序；102 個有效樣本全部保存。舊／新 artifact hashes、來源 hashes 與 AOT provenance 保留。數字來自這次配對測試，不將上次診斷的 medians 混入。

| Cell | 舊 polling（ms） | 新 readiness / interpreter（ms） | 新 readiness / AOT（ms） |
|---|---:|---:|---:|
| 一次 diff / ack | 23.041 | 11.030 | 8.106 |
| 100 echo × 1 KiB | 652.714 | 65.795 | 11.224 |

只看 guest 本體，diff 的 median 為 12.211 → 0.410 → 0.160 ms；100 echo 為 639.344 → 53.548 → 3.207 ms。新 bridge 用 `poll_oneoff` 等 stdin 就緒或 request deadline，資料抵達即可喚醒，正常 WASI reply reads 不再經過固定 5 ms sleep；native TCP tests 與罕見 write retry 保留既有 polling。新 interpreter 剩下的 JSON framing/serialization 與 guest 執行成本再由 AOT 降低。這輪固定 source 的 AOT 編譯另外花了約 2.74 / 2.76 秒，不包含於上表。

## AOT 與扣除口徑

`rustCell.runtimeMode` 預設 `interpreter`，另可設 `aot`。AOT 仍先通過 import policy，移除 guest 的所有 custom sections，再由 host 產生可信 native payload。Compiler 使用 `--interruptible`，gas limit 啟用時編入 gas instrumentation；core Wasm 必須與被檢查的內容相同，缺少 native payload 時失敗，不靜默回退。每個 cell 重編，沒有 AOT cache。Skill/library tests 仍使用 interpreter。

- `cargo.command`：捕捉全部 Cargo，包括初始化、cell、library gate、失敗重試與共同 checker；`cargo test` 的整段命令也扣除。
- `aot.command`：WasmEdge compiler 的 spawn-to-close wall time，獨立 ledger 與 phase；不包含 compiler wrapper 自己的 Node 啟動。
- `cell.aot_compile`：host stripping、compiler、output verification 與 provenance；與 `cell.execution` 是互斥的 runner phases。
- Cell 圖表只用 runtime-reported execution；編譯扣除圖表可選「全部 Cargo」或「全部 Cargo + AOT」，後者取兩者區間聯集、重疊不重複扣除。

AOT 產物、剝除後 input、SHA256 provenance 留在 host-only `.aot/`，不對 guest preopen。Compiler 與執行共用 timeout/cancellation/process limits。[官方 AOT 說明](https://wasmedge.org/docs/start/build-and-run/aot/)說明 native payload 格式與 instrumentation；本次固定 WasmEdge 0.14.1 的 CLI 使用自動載入 AOT，實際 flags 由保存的命令紀錄確認，不使用新版本的 run-mode flag。

## 驗證

`npm run check`、全 workspace build 通過。新增 AOT stripping/provenance/fail-closed、phase 隔離、Cargo/AOT overlap/clock/capture 與四組 reference coverage 測試。真實 WasmEdge interpreter/AOT integration 15 tests 通過，涵蓋 large UTF-8 bridge、禁止的 socket import、timeout 後 fresh handshake、gas exhaustion 與 memory growth cap；native bridge release tests 12/12 通過。其他相關 suite 86 tests 通過、3 個環境限定 tests 略過。

固定程式 campaign 3822 spans 均通過 JSON schema；54 Cargo commands / 24 AOT commands 配對完整，72 runs 的兩種編譯扣除均可計算。計時方法仍有 wrapper 開銷；3 次固定程式與單次模型任務沒有 confidence interval，不作整體效能排名。比較應按 workload、cell 次數、實際編譯成本與生成程式一起閱讀。

付費 campaign 的 1600 spans 均通過 schema，32 Cargo / 8 AOT commands 完整，16/16 runs 可計算編譯扣除且符合 cell 契約。46 cells 包含 6 次 runtime errors、3 次 Cargo compile errors，重試紀錄完整保留，沒有 AOT compiler failure；生成的 Python/Rust sources 與 lib edits 經人工檢視，沒有以 shell/subprocess 代做工作。E09 的三次 regex AOT 命令合計 29.31 秒，因此本輪 AOT 的端到端時間較長；扣除所有 compiler 後 agent 時間為 25.14 秒，interpreter 為 30.46 秒。兩者生成的 cells／程式不同，固定 source 的對照更適合判讀 runtime 原因。
