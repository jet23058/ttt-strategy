# TTT 低頻趨勢 Web

依據 `ttt_feature_manual.html` 重新製作的靜態 Web 版本，聚焦 TTT 模組本體。

## 功能

- 股號查詢：台股 / 美股分頁、提示清單、查詢歷史、TTT 回測結果。
- 掃描適合進場股票：前 N 大清單、加碼狀態篩選、20 日量比篩選、排序循環、掃描快取。
- 依據上傳圖片分析股票：圖片預覽、股號批次分析、圖片組紀錄、圖片股號紀錄。
- 共用最新決策：單股查詢、掃描、圖片分析都使用同一套 TTT latest decision。
- 圖表與交易紀錄：收盤線、20MA、買賣點、position-based 交易紀錄。
- 欄位說明：20 日量比、5 日量比、20MA 乖離、成交金額、價量結構。

## 啟動

```bash
python3 -m http.server 4173
```

開啟：

```text
http://127.0.0.1:4173
```

## 策略身分

```text
Strategy Version: TTT v2.0 | Engine: Position-Based | Exit Mode: Close Confirm | Position: Core/Mobile
```

## 靜態版限制

- 目前使用可重現的示範行情資料，不會連線抓 Yahoo / TWSE 即時資料。
- 圖片分析頁保留 LLM 設定與圖片組流程；靜態版不會送出 API Key。可手動貼入辨識出的股號，或從圖片檔名抓股號。
- 掃描前 N 大在靜態版使用畫面中的掃描清單模擬市場池。
