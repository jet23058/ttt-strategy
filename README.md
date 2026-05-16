# TTT 低頻趨勢 Web

依據 `ttt_feature_manual.html` 重新製作的 Web 版本，聚焦 TTT 模組本體，並透過本機 API 從 Yahoo Finance 抓取真實 OHLCV 日線資料。

## 功能

- 股號查詢：台股 / 美股分頁、提示清單、查詢歷史、TTT 回測結果。
- 掃描適合進場股票：前 N 大清單、加碼狀態篩選、20 日量比篩選、排序循環、掃描快取。
- 依據上傳圖片分析股票：圖片預覽、股號批次分析、圖片組紀錄、圖片股號紀錄。
- 共用最新決策：單股查詢、掃描、圖片分析都使用同一套 TTT latest decision。
- 圖表與交易紀錄：收盤線、20MA、買賣點、position-based 交易紀錄。
- 欄位說明：20 日量比、5 日量比、20MA 乖離、成交金額、價量結構。
- 真實資料：本機 `server.py` 代理 Yahoo Finance chart API，台股自動嘗試 `.TW` / `.TWO`，美股直接抓 Yahoo 代號。

## 啟動

```bash
python3 server.py
```

開啟：

```text
http://127.0.0.1:4173
```

## 策略身分

```text
Strategy Version: TTT v2.0 | Engine: Position-Based | Exit Mode: Close Confirm | Position: Core/Mobile
```

## 資料來源與限制

- 日 K 資料來自 Yahoo Finance chart API。
- 台股輸入 `2330` 會依序嘗試 `2330.TW` 與 `2330.TWO`。
- 美股輸入 `AAPL`、`NVDA` 會直接抓對應 Yahoo 代號。
- 若直接用一般靜態伺服器或 GitHub Pages 開啟，瀏覽器可能被 Yahoo CORS 擋下；建議使用 `python3 server.py`。
- 圖片分析頁保留 LLM 設定與圖片組流程；靜態版不會送出 API Key。可手動貼入辨識出的股號，或從圖片檔名抓股號。
- 掃描前 N 大目前使用畫面中的掃描清單作為股票池；每檔仍會抓真實 Yahoo 日 K。
