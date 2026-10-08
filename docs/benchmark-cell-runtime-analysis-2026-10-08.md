# Python cell / Rust–Wasm cell 慢因分析

本輪四個付費案例中，Rust–Wasm 的 cell 執行時間確實較長。主要原因是每個 cell 都啟動新的 WasmEdge CLI、目前強制 interpreter，以及部分操作的 bridge polling。Cargo 已排除；不能再用編譯解釋這張 cell 圖。

這次以保存的付費 source/trace、固定程式與本機控制實驗分析，新增付費 requests 為 **0**。正式 runtime、付費 raw records 與既有安全政策未修改。

## 1. 原圖實際比較的邊界

| 版本 | 執行邊界 | 程式與狀態生命週期 |
|---|---|---|
| Prime TS / Python | 已啟動 kernel 的 execute request 至完成 | kernel 常駐，imports、Python objects 與 regex cache 可保留 |
| Prime Rust / Python | kernel execute request 至完成 | 同樣常駐 Python；Rust 是 host 實作語言 |
| WasmEdge / Rust | `runProcess` 呼叫前至 child process close | 每 cell 新 process、新 VM/module instance；state 經檔案保存 |

Rust 的 `cell.execution` 不含 Cargo、workspace 初始化、readonly probe、import admission 檢查、snapshot 與 bridge cleanup。它包含 process 啟動、module 載入與 VM 初始化、guest、stdout/stdio bridge、process 結束。Python 的啟動另列，不會每 cell 重做。因此這張圖量到的是產品實際每次 cell 的成本，不是只量兩種語言的程式本體。

來源：[Rust execution boundary](../packages/coding-agent/src/core/rust-cell/cell-runner.ts#L287)、[process spawn/close](../packages/coding-agent/src/core/rust-cell/process.ts)、[Python TS kernel](../poc/bench/results/three-way-inputs/prime-ts/packages/coding-agent/src/core/kernel/repl-manager.ts)、[Python Rust host kernel](../poc/bench/results/three-way-inputs/prime-rust/crates/pa-core/src/kernel/manager/requests.rs)。

## 2. 每 cell 固定成本：接近空程式仍需約 10 ms

既有 R16 各版本連續執行 100 次只印 marker 的 cells，沒有模型參與：

| Runtime | 每 cell 執行時間中位數 | 補充 |
|---|---:|---|
| Prime TS / Python | 0 ms（上游整數解析度） | 高解析度 adapter envelope 中位數 0.136 ms |
| Prime Rust / Python | 0 ms（上游整數解析度） | 高解析度 adapter envelope 中位數 0.132 ms |
| WasmEdge interpreter | 9.718 ms | 範圍 9.220–10.466 ms；只取 execution，不含 Cargo/snapshot |

Python 的 0 ms 是整數毫秒解析度，並非零成本。新補測 15 次的 Python 常駐 kernel envelope 為 0.197 / 0.217 ms，WasmEdge 為 10.642 ms，native Rust 新 process 為 1.802 ms。

新 process 是實測邊界的一部分，但目前沒有 WasmEdge 內部 hooks，可以把 10 ms 精確分為 OS spawn、載入、validation、instantiation、guest startup 與退出。也不能直接把 native Rust 的 1.8 ms 相減宣稱剩餘全部是 VM 初始化。

## 3. Interpreter 會拖慢實際程式本體

每組 15 次，另有 2 次 warmup，serial 執行；Rust 使用 release build。以下是 guest 內部 timer，排除 process 啟動：

| 固定工作 | Python / TS host | Python / Rust host | Rust–Wasm interpreter | Native Rust |
|---|---:|---:|---:|---:|
| 100,000 次 uint32 wrapping 運算 | 4.725 ms | 4.692 ms | 2.079 ms | 0.109 ms |
| 10,000 筆 JSON parse/sum | 4.064 ms（含 read） | 4.320 ms（含 read） | 212.394 ms（read 另為 1.840 ms） | 1.130 ms（read 另為 0.043 ms） |

整數運算的 Rust–Wasm 程式本體仍快於 Python；加上每次 process 成本後，整個 cell 反而較慢。JSON 則是程式本體就較慢，不只啟動。

補測的 Python 3.11.15 `json.decoder.scanstring` / `json.scanner.make_scanner` 皆確認使用 `_json` C accelerator。Python 呼叫原生 C JSON 實作；Rust 的 serde_json 在目前 runner 中成為逐指令解譯的 Wasm。兩邊都叫「runtime」不代表都用相同的解譯方式處理 parser。

另做同一份可信、固定 AOT artifact 的控制：交替使用 `--force-interpreter` 與 AOT，原 module/program/data 相同，各 15 次，AOT 編譯不計入執行：

| 工作 | Interpreter cell wall time | AOT cell wall time | Interpreter guest body | AOT guest body |
|---|---:|---:|---:|---:|
| 近空程式 | 8.361 ms | 7.026 ms | 無獨立 body timer | 無獨立 body timer |
| 100,000 次運算 | 10.690 ms | 6.616 ms | 2.022 ms | 0.023 ms |
| 10,000 筆 JSON | 223.773 ms | 9.009 ms | parse/sum 211.703 ms | parse/sum 1.220 ms |
| E09 等義 regex/count/state | 31.237 ms | 10.308 ms | regex 建立 4.574、比對 3.484 ms | regex 建立 0.161、比對 0.048 ms |

這個控制直接支持 interpreter 是 JSON/regex 路徑的主要慢因。AOT 仍有新 process 的成本；近空程式沒有因此降到常駐 Python 的水準。AOT 前置編譯分別耗時約 1.407 / 1.505 / 1.822 / 10.810 秒，短命且程式常變的 cell 不會免費得到這個改善。

目前強制 interpreter 是 [DESIGN §2.4/2.7](../DESIGN.md#24-執行管線) 的 import admission 政策，用來避免 guest 夾帶的 AOT native payload 繞過檢查。本次只在本機可信 fixture 做 AOT 診斷；沒有更改產品旗標。若採 AOT，必須設計由 host 從已驗證 Wasm 產生、按內容識別的 artifact，不能只移除旗標。

## 4. Bridge 的 5 ms polling 是可重現的延遲

[guest bridge](../wasmedge-agent-runtime/template/rlm/src/bridge.rs#L34) 在 stdin 暫無回覆時 sleep 5 ms，之後才再讀。初次使用另需 hello/hello_ok；diff 也需要 emit/ack。即使 host 很快回覆，也可能在 guest sleep 期間等待。

只在診斷 workspace 副本將 polling 從 5 ms 改成 1 ms。兩模式交替，各 15 次；相同 handler/payload/assertions，全數通過：

| 工作 | 原 5 ms：guest 中位數 | 副本 1 ms：guest 中位數 | 原 5 ms：整個 process | 副本 1 ms：整個 process |
|---|---:|---:|---:|---:|
| 單次 diff，含首次 handshake/ack | 6.590 ms | 1.647 ms | 15.201 ms | 10.796 ms |
| 100 次 1 KiB echo，含首次 handshake | 147.509 ms | 62.722 ms | 157.416 ms | 72.664 ms |

新 handler 只回傳 `n/payload`；既有 R09 reference handler 還會回傳 `cellSourceCode`，不能把新/舊 R09 數字混用。5 ms 並非每 request 一定增加 5 ms：回覆在第一次 poll 前抵達時不會 sleep，實際延遲也隨排程變動。因果比較使用最後一組交替量測的 15 個樣本，沒有把前面的 baseline samples 混入。

這支持優先改善等待回覆的 transport。1 ms 是診斷擾動，不是已完成的產品修正；較好的修法是以 fd readiness 加 deadline 等待，避免固定 sleep，同時保留取消與 timeout 行為。

## 5. 對目前四個付費案例的解釋

| 案例 | 實際 Rust execution（ms/cell） | 已確認的機制 |
|---|---|---|
| E03 修 bug | 9.872、24.425 | 第一次列檔；第二次 `edit_exact` 不只 write，還呼叫 `rlm::display::diff`，需 bridge handshake/ack；Python cell 直接 pathlib replace/write |
| E08 rename | 10.877 | 接近近空 process floor；前一個 compile failure 未執行，不在 cell execution 合計內 |
| E09 helper/state | 29.964、30.873、11.765 | 前兩個新 process 都重新 `Regex::new`、比對 log、讀寫 state；第三個無 regex，只載入 state/格式化檔案，接近啟動 floor |
| E11 join/report | 9.455、11.604 | fixture 很小，兩次新 process 成本明顯；不能拿放大的 10,000 筆 JSON 診斷數字回填這筆 run |

E09 的 `rlm::state` 使用 [state.json 的檔案讀寫](../wasmedge-agent-runtime/template/rlm/src/state.rs)，**沒有走 host bridge**。在新 15 次等義診斷中，regex 建立 4.347 ms、首次 captures/比對 3.399 ms、state 寫入 0.640 ms、讀 log 0.101 ms；獨立 state 寫讀為 0.582 / 0.132 ms。這些 phases 不是完整 guest partition，尚未細分 module 載入、配置/析構、輸出與其餘成本，不能把剩餘時間全部歸給單一階段。原付費 source 沒有 guest timers，無法追溯出精確 partition。

各版本的 paid cells 與次數不同；例如 E09 Python 有更多 cells、imports/cache/memory API 與失敗修正。因此既有圖能回答這輪產品 trajectory 的 cell 成本，固定程式的診斷則回答機制。不同資料不能相減冒充原 run 的啟動或 guest 時間。

## 6. 改善優先順序與證據保存

1. Bridge：移除固定 sleep 帶來的等待，先覆蓋 diff 與 request/reply 的 deadline、abort、broken pipe 測試。這對 E03 類 helper 有直接收益。
2. Process/VM：依 DESIGN T2 檢查 embedded runner / worker reuse，保留每 cell instance 與隔離；先解決約 10 ms 的每次啟動成本。單純減少 Cargo 不會改變這個數字。
3. Interpreter/library：以 JSON/regex 等固定重工作驗證可信 AOT/cache，或評估 host 原生服務；AOT 另報 compilation/amortization，host 服務仍列 bridge/序列化成本。
4. 跨 cell state/cache：評估可重用 helper/compiled regex 的生命週期；目前常駐 Python 與新 Wasm process 的 cache 行為不同。

資料：[主診斷 JSON](../poc/bench/results/cell-runtime-diagnostic-20261008-02/measurements.json)、[主診斷可重現 source](../poc/bench/results/cell-runtime-diagnostic-20261008-02/diagnostic-source.mjs)、[同 artifact AOT 控制](../poc/bench/results/cell-runtime-diagnostic-20261008-02/aot-control/measurements.json)、[原 paid report](../poc/bench/results/three-way-opus55-all-cargo-smoke-01/report.html)。主診斷保存 272 個 Rust/process 與 136 個 Python samples（包含 warmups），AOT 控制保存 136 samples（包含 warmups），每個比較組排除 2 次 warmup 後採 15 次的 median。

`cell-runtime-diagnostic-20261008-01` 是早先診斷 script 的 regex escape 錯誤而中止的紀錄，已保留、不列入任何比較。有效控制來自 `-02`，source/artifact hashes、stdout/assertions 與 completion marker 均有保存。本次控制沒有做 profiler overhead audit 或跨機器驗證；它支持這台機器、WasmEdge 0.14.1、這些固定程式的慢因與改進方向，沒有將數字推廣到所有 Rust/Wasm workloads。
