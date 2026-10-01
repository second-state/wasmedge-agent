# M5 驗收：fork 本體 bench 複跑報告

日期：2026-08-07。對象：wasmedge-agent fork 本體（main @ WP1–WP9 全數合併後，`prime-agent.sh` from-source、內建 `rust`+`bash` 工具、無 extension）。對照：M1 量測（2026-08-06，`docs/m1-measurement-report.md`）之 A 組（upstream ipython baseline）與 B 組（upstream＋PoC rust extension）。

**引用範圍（2026-10-02 補註）**：72 是 12 個任務的重複 runs，不是 72 個不同任務。A/B 引用前一日的 M1 campaign；本報告也不同於 [August 10 同輪 A/F 對照](benchmark-comparison-2026-08-10.md)，不包含後續 runtime 修復。表格保留歷史 analyzer p50（偶數樣本取較高中間值，非中間兩值平均）；數字與 GO 判定未改，不能從這個跨日比較分離 compiler 或 prompt 的因果效果。

## 1. 設計

- **F 組**（fork）：12 任務 × 2 模型（sonnet-4-6、opus-5，經 gateway）× 3 reps ＝ 72 runs，driver 與 fixture、check 均沿用 M1（`poc/bench/run.ts` 增 F 組啟動路徑）。
- Prompt variant 為 fork 內建（D17 定案之 example 預設），標記 `builtin`。
- Gate：M5 驗收「成績不得低於 PoC」＋ D20 準則（pass ≥ A−15pp、tokOut ≤ 2.0×A、雙模型同過）。

## 2. 主結果

| 條件 | runs | pass | tokOut(p50) | cells(p50) | compile-err 佔比 | cell p50 |
|---|---|---|---|---|---|---|
| opus-5 · A（M1） | 36 | 100% | 440 | 3 | 0% | 15ms |
| opus-5 · B/example（M1 PoC） | 24 | 100% | 868 | 3 | 23% | 238ms |
| **opus-5 · F（fork）** | 36 | **100%** | **797** | **2** | 25% | 225ms |
| sonnet-4-6 · A（M1） | 37 | 97% | 773 | 4 | 0% | 13ms |
| sonnet-4-6 · B/example（M1 PoC） | 25 | 100% | 1175 | 3 | 34% | 234ms |
| **sonnet-4-6 · F（fork）** | 36 | **100%** | **1539** | **2** | 29% | 215ms |

## 3. Gate 判定：**GO**

| 判準 | opus | sonnet |
|---|---|---|
| pass 不低於 PoC B | 100% vs 100% ✓ | 100% vs 100% ✓ |
| tokOut ≤ 2.0×A（D20） | 797/440 = 1.81× ✓ | 1539/773 = 1.99× ✓（貼線） |
| pass ≥ A−15pp（D20） | ✓ | ✓ |

- **72/72 runs 全 PASS**——本輪 12 個任務的所有重複 runs 通過既定離線驗收，含多回合任務；不代表一般任務正確性保證。
- **opus F 的 output-token p50 低於 PoC**（797 vs 868，−8%）；cells p50 由 3 降至 2。這是觀察到的互動差異，未隔離 prompt 改動的效果。
- **sonnet F token 高於 PoC**（1539 vs 1175，+31%），但仍壓在 D20 的 2.0×A 天花板內（1.99×）。方向與 M1 一致（sonnet 較費）；本輪部分 run 額外吸收了 harness 環境修復工作（§4），對 F 為不利偏差。
- compile-error 佔比（25%/29%）與 cell p50（~220ms）與 PoC 同量級——「編譯錯誤是一等回饋」的迴路特性在 fork 本體維持。

## 4. 量測註記（誠實記錄）

1. **Driver 基建事故（與 fork 品質無關，零 token 損耗）**：serial one-shot 共享 per-uid daemon socket，前一 run 的 supervisor 拆除與下一 run 的 create 重疊時會留下殭屍 supervisor 毒化後續 runs；救火過程中 `pkill` 打斷 cache 寫入又毒化共享 tsx compile cache，一度全機 create 必死。修法：driver 增 run 間 settle 等待（daemon.sock 清空才起下一 run；卡 15 秒即殺持有者）；毒 cache 以清除復原。全部受害格均以修復後 driver 補跑，失敗 runs 之模型均未啟動（log 佐證），不入成績。
2. **Fixture 環境滲漏（harness 缺陷，已修）**：M2 併入上游後 repo 根 `package.json` 帶 `"type": "module"`，results 目錄棲身 repo 內，使無 package.json 錨定的 fixture CJS 腳本被 node 當 ESM 而炸（M1 期根 package.json 尚不存在故未觸發）。受影響任務 03/05/10/12 已補 `{"type":"commonjs"}` 錨定；兩個因此誤判的格以錨定後環境補跑（皆過）。錨定前通過的 runs 中，模型多以自建 package.json 繞過——屬額外工作，只多算 F 的 token、不虛增 pass。
3. 與 M1 同：gateway 串流不回報 input tokens（對比用 output）；cell 計數以 transcript toolName=rust 為準。
4. M1 原始 A/B runs 仍在 `poc/bench/results/runs/`（本機、不入 git），本報告表格由 `analyze.ts` 對全集一次計算（M1 期 provider 別名與現名 `gateway` 為同一端點）。

## 5. 結論

fork 本體成績不低於 PoC：pass 全等（100%），opus 端 token 反優於 PoC，sonnet 端貼 2.0× 天花板但在閘內，多回合／狀態持久／編譯迴路行為與 PoC 同質。**M5 bench gate 判 GO**；驗收另一支柱 dogfood 進行中。
