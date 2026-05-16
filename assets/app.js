const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const STORAGE = {
  queryHistory: "ttt.queryHistory.v2",
  scanCache: "ttt.scanCache.v2",
  imageGroups: "ttt.imageGroups.v2",
  imageSymbols: "ttt.imageSymbols.v2",
};

const MARKET_NAMES = { tw: "台股查詢", us: "美股查詢" };
const TTT_IDENTITY = "Strategy Version: TTT v2.0 | Engine: Position-Based | Exit Mode: Close Confirm | Position: Core/Mobile";

const STOCKS = {
  tw: [
    ["2330", "台積電"], ["2317", "鴻海"], ["6217", "中探針"], ["2337", "旺宏"],
    ["3016", "嘉晶"], ["6442", "光聖"], ["8210", "勤誠"], ["2368", "金像電"],
    ["2103", "台橡"], ["6147", "頎邦"], ["3289", "宜特"], ["4966", "譜瑞-KY"],
    ["3037", "欣興"], ["3661", "世芯-KY"], ["2382", "廣達"], ["3231", "緯創"],
  ],
  us: [
    ["NVDA", "NVIDIA Corporation"], ["AAPL", "Apple Inc."], ["MSFT", "Microsoft Corporation"],
    ["AMD", "Advanced Micro Devices"], ["TSLA", "Tesla"], ["META", "Meta Platforms"],
    ["AMZN", "Amazon"], ["GOOGL", "Alphabet"], ["AVGO", "Broadcom"], ["SMCI", "Super Micro Computer"],
  ],
};

const FIELD_GUIDE = [
  ["20日量比", "今日成交量 / 20 日平均成交量。"],
  ["5日量比", "今日成交量 / 5 日平均成交量，用來觀察短期爆發。"],
  ["20MA 乖離", "現價相對 20MA 的距離。太高代表追價風險升高。"],
  ["成交金額", "收盤價乘以成交量，用於流動性檢查。"],
  ["弱收", "收盤接近當日低點，可能是假突破或賣壓。"],
  ["強收", "收盤靠近當日高點，代表買盤承接。"],
  ["漲停鎖住", "接近漲停且收在高位，台股強勢股中可能代表籌碼鎖定。"],
  ["開板回封", "接近漲停後仍收回高位，代表承接力強。"],
  ["爆量弱收", "量明顯放大但收盤弱，可能是分歧或派發。"],
];

let state = {
  market: "tw",
  lastResult: null,
  scanRows: [],
  scanSort: { key: null, dir: 0 },
  zoom: null,
};

const fmtPct = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "-";
const fmtNum = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "-";
const fmtMoney = (value) => Number.isFinite(value) ? value.toLocaleString("zh-TW", { maximumFractionDigits: 0 }) : "-";
const todayKey = () => new Date().toISOString().slice(0, 10);

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function resolveStock(input, market = state.market) {
  const raw = String(input || "").trim();
  const normalized = raw.split(/[｜|\s]/)[0].replace(/\.(TW|TWO)$/i, "");
  const list = STOCKS[market];
  const found = list.find(([symbol, name]) => symbol.toUpperCase() === normalized.toUpperCase() || name.includes(raw));
  if (found) return { symbol: found[0], name: found[1], market };
  return { symbol: normalized || (market === "tw" ? "2330" : "NVDA"), name: normalized || "-", market };
}

function updateHints() {
  $("#symbolHints").innerHTML = STOCKS[state.market]
    .map(([symbol, name]) => `<option value="${symbol}｜${name}"></option>`)
    .join("");
}

function yahooCandidates(symbolInfo) {
  const raw = symbolInfo.symbol.toUpperCase().replace(/\.(TW|TWO)$/i, "");
  if (symbolInfo.market === "tw") {
    return [`${raw}.TW`, `${raw}.TWO`];
  }
  return [raw];
}

function rangeForYears(years) {
  if (years <= 1) return "1y";
  if (years <= 2) return "2y";
  if (years <= 5) return "5y";
  if (years <= 10) return "10y";
  return "max";
}

async function fetchHistoricalBars(symbolInfo, years) {
  const params = new URLSearchParams({
    symbol: symbolInfo.symbol,
    market: symbolInfo.market,
    years: String(years),
  });

  try {
    const response = await fetch(`/api/history?${params.toString()}`);
    if (response.ok) {
      const payload = await response.json();
      if (payload.bars?.length) {
        symbolInfo.yahooSymbol = payload.yahooSymbol;
        symbolInfo.name = symbolInfo.name === symbolInfo.symbol && payload.name ? payload.name : symbolInfo.name;
        return payload.bars;
      }
      throw new Error(payload.error || "API 沒有回傳可用日 K");
    }
  } catch (error) {
    console.warn("Local API unavailable, trying direct Yahoo fetch.", error);
  }

  let lastError = "";
  for (const yahooSymbol of yahooCandidates(symbolInfo)) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${rangeForYears(Number(years))}&interval=1d&events=history`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastError = `${yahooSymbol}: HTTP ${response.status}`;
        continue;
      }
      const payload = await response.json();
      const bars = parseYahooChart(payload, yahooSymbol);
      if (bars.length) {
        symbolInfo.yahooSymbol = yahooSymbol;
        return bars;
      }
      lastError = `${yahooSymbol}: 沒有日 K`;
    } catch (error) {
      lastError = `${yahooSymbol}: ${error.message}`;
    }
  }
  throw new Error(`抓不到 ${symbolInfo.symbol} 的 Yahoo Finance OHLCV。${lastError}`);
}

function parseYahooChart(payload, yahooSymbol) {
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  return timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    volume: Number(quote.volume?.[index]),
  })).filter((bar) => [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite));
}

function sma(values, period, index) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) sum += values[i];
  return sum / period;
}

function priorExtreme(values, period, index, mode) {
  if (index < period) return null;
  const slice = values.slice(index - period, index);
  return mode === "max" ? Math.max(...slice) : Math.min(...slice);
}

function enrich(rawBars) {
  const closes = rawBars.map((b) => b.close);
  const highs = rawBars.map((b) => b.high);
  const lows = rawBars.map((b) => b.low);
  const volumes = rawBars.map((b) => b.volume);
  return rawBars.map((bar, index) => {
    const ma5 = sma(closes, 5, index);
    const ma10 = sma(closes, 10, index);
    const ma20 = sma(closes, 20, index);
    const ma60 = sma(closes, 60, index);
    const vol5 = sma(volumes, 5, index);
    const vol20 = sma(volumes, 20, index);
    const range = Math.max(0.01, bar.high - bar.low);
    return {
      ...bar,
      ma5,
      ma10,
      ma20,
      ma60,
      vol5,
      vol20,
      prior10High: priorExtreme(highs, 10, index, "max"),
      prior20High: priorExtreme(highs, 20, index, "max"),
      low10: priorExtreme(lows, 10, index, "min"),
      low20: priorExtreme(lows, 20, index, "min"),
      closePosition: (bar.close - bar.low) / range,
      volumeRatio20: vol20 ? bar.volume / vol20 : null,
      volumeRatio5: vol5 ? bar.volume / vol5 : null,
      turnover: bar.close * bar.volume,
      ma20Distance: ma20 ? bar.close / ma20 - 1 : null,
    };
  });
}

function latestDecision(bars, options = {}) {
  const threshold = Number(options.volumeThreshold ?? $("#volumeThresholdInput")?.value ?? 1.2);
  const isOpen = Boolean(options.isOpen);
  const entryPrice = options.entryPrice || null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  const maStack = last.ma5 && last.ma10 && last.ma20 && last.ma5 > last.ma10 && last.ma10 > last.ma20;
  const weakClose = last.closePosition <= 0.3;
  const strongClose = last.closePosition >= 0.55;
  const upperShadowPct = (last.high - last.close) / last.close;
  const limitUp = last.close >= prev.close * 1.095;
  const limitDown = last.close <= prev.close * 0.905;
  const limitLocked = limitUp && last.closePosition >= 0.85;
  const openedRelocked = limitUp && last.high > last.close && last.closePosition >= 0.85;
  const failLimit = limitUp && last.closePosition < 0.6;
  const distribution = (last.volumeRatio20 || 0) >= 2.2 && weakClose;
  const liquidityOk = last.turnover >= (options.market === "us" ? 5_000_000 : 100_000_000);
  const breakout = last.prior20High && last.close > last.prior20High;
  const volumeOk = (last.volumeRatio20 || 0) >= threshold;
  const entryReady = Boolean(maStack && breakout && !weakClose && upperShadowPct < 0.08 && !failLimit && liquidityOk && volumeOk);
  const addReady = Boolean(isOpen && maStack && liquidityOk && !distribution && (limitLocked || openedRelocked || (last.prior10High && last.close > last.prior10High && strongClose)));
  const addStatus = addReady ? "可加碼觀察" : isOpen ? "等待加碼" : "不適合加碼";

  const blockers = [];
  if (!maStack) blockers.push("MA5 / MA10 / MA20 尚未形成右側多頭排列");
  if (!breakout) blockers.push("尚未突破近 20 日結構高點");
  if (!volumeOk) blockers.push(`20 日量比低於 ${threshold}`);
  if (weakClose) blockers.push("收盤位置偏弱");
  if (upperShadowPct >= 0.08) blockers.push("上影線偏長");
  if (failLimit) blockers.push("疑似漲停打開後未回封");
  if (!liquidityOk) blockers.push(options.market === "us" ? "成交金額不足" : "成交金額未達 1 億元");

  let structure = "一般結構";
  if (limitLocked) structure = "漲停鎖住";
  else if (openedRelocked) structure = "開板回封";
  else if (distribution) structure = "爆量弱收警示";
  else if (limitDown) structure = "流動性 / 派發警示";
  else if (last.close < prev.close && (last.volumeRatio20 || 0) <= 0.85 && last.ma20 && last.close >= last.ma20) structure = "急跌縮量可能洗盤";
  else if (strongClose && last.close > prev.close) structure = "價漲且收盤強";
  else if (weakClose) structure = "收盤偏弱";

  return {
    entryReady,
    addReady,
    addStatus,
    structure,
    entryReasons: entryReady ? ["右側多頭排列、突破 20 日高點、量價與流動性通過"] : blockers,
    addReasons: addReady ? ["持有中且出現續強確認，短均線與流動性仍完整"] : [isOpen ? "持有中，但尚未出現漲停鎖住、開板回封或 10 日高點強收" : "目前不是策略持有狀態"],
    metrics: {
      date: last.date,
      close: last.close,
      ma5: last.ma5,
      ma10: last.ma10,
      ma20: last.ma20,
      ma60: last.ma60,
      volumeRatio20: last.volumeRatio20,
      volumeRatio5: last.volumeRatio5,
      turnover: last.turnover,
      ma20Distance: last.ma20Distance,
      profit: entryPrice ? last.close / entryPrice - 1 : null,
    },
  };
}

function tttSignal(bars, index, position, market, threshold) {
  const bar = bars[index];
  const prev = bars[index - 1] || bar;
  const decision = latestDecision(bars.slice(0, index + 1), {
    isOpen: position.shares > 0,
    entryPrice: position.entryPrice,
    market,
    volumeThreshold: threshold,
  });

  if (position.shares <= 0) {
    if (index >= 65 && index < bars.length - 1 && decision.entryReady) {
      return { action: "buy", size: 0.3, reason: "初始突破：右側多頭排列與 20 日結構突破" };
    }
    const earlyAcceleration = bar.ma5 && bar.ma10 && bar.ma20 && bar.ma5 > bar.ma10 && bar.close > bar.ma5 && (bar.volumeRatio20 || 0) >= threshold * 1.15 && bar.closePosition >= 0.65;
    if (index >= 65 && index < bars.length - 1 && earlyAcceleration && bar.ma20Distance < 0.16) {
      return { action: "buy", size: 0.2, reason: "EARLY_ACCELERATION：剛加速且未離 20MA 過遠" };
    }
    const pullback = bar.ma20 && bar.ma60 && bar.close > bar.ma20 && bar.ma20 > bar.ma60 && prev.close < prev.ma20 && bar.closePosition >= 0.55;
    if (index >= 65 && pullback) {
      return { action: "buy", size: 0.2, reason: "PULLBACK：上升趨勢中回測 20MA 守穩" };
    }
    return null;
  }

  const profit = bar.close / position.entryPrice - 1;
  const belowMa20 = bar.ma20 && bar.close < bar.ma20;
  const threeBelow = index >= 2 && bars.slice(index - 2, index + 1).every((x) => x.ma20 && x.close < x.ma20);
  const fiveBelow = index >= 4 && bars.slice(index - 4, index + 1).every((x) => x.ma20 && x.close < x.ma20);
  const distribution = (bar.volumeRatio20 || 0) >= 2.2 && bar.closePosition <= 0.3;
  const liquidityDeath = bar.close <= prev.close * 0.905 && bar.closePosition <= 0.2;

  if (profit >= 1 && bar.ma10 && bar.low10 && bar.close < Math.max(bar.ma10, bar.low10)) return { action: "sell", size: 1, reason: "高獲利保護：跌破 MA10 / 10 日低點防守" };
  if (liquidityDeath) return { action: "sell", size: 1, reason: "流動性崩潰：類跌停且收盤弱" };
  if ((fiveBelow && bar.low20 && bar.close < bar.low20) || distribution) return { action: "sell", size: 1, reason: "真正出貨或長期結構破壞" };
  if (threeBelow && !position.reducedTrend) return { action: "reduce", size: 0.4, reason: "確認轉弱：連續 3 日低於 MA20" };
  if (profit >= 0.6 && bar.ma10 && bar.close < bar.ma10 && !position.reducedBigWin) return { action: "reduce", size: 0.4, reason: "Big Win Protection：高獲利後跌破 MA10" };
  if (belowMa20 && !position.reducedMa20 && !(bar.close < prev.close && (bar.volumeRatio20 || 1) <= 0.85)) return { action: "reduce", size: 0.3, reason: "第一層風控：首次收盤跌破 MA20" };
  if (decision.addReady && position.stage < 3) return { action: "add", size: position.stage === 1 ? 0.3 : 0.4, reason: "加碼：續強確認或 10 日高點強收" };
  return null;
}

function runBacktest(symbolInfo, rawBars, options = {}) {
  const years = Number(options.years ?? $("#yearsInput").value);
  const capital = Number(options.capital ?? $("#capitalInput").value);
  const maxPositionPct = Number(options.maxPositionPct ?? $("#maxPositionInput").value / 100);
  const threshold = Number(options.volumeThreshold ?? $("#volumeThresholdInput").value);
  const bars = enrich(rawBars);
  if (bars.length < 75) {
    throw new Error(`${symbolInfo.symbol} 只有 ${bars.length} 筆日 K，TTT 至少需要 75 筆。`);
  }
  let cash = capital;
  let position = { shares: 0, entryPrice: null, entryDate: null, stage: 0, entryReason: "", reducedMa20: false, reducedTrend: false, reducedBigWin: false };
  const trades = [];
  const actions = [];
  const equity = [];
  const maxCash = capital * maxPositionPct;

  for (let i = 65; i < bars.length - 1; i += 1) {
    const signal = tttSignal(bars, i, position, symbolInfo.market, threshold);
    const next = bars[i + 1];
    if (signal?.action === "buy" || signal?.action === "add") {
      const allocation = Math.min(cash, maxCash * signal.size);
      const shares = Math.floor(allocation / next.open);
      if (shares > 0) {
        cash -= shares * next.open;
        const oldValue = position.shares * (position.entryPrice || next.open);
        position.shares += shares;
        position.entryPrice = (oldValue + shares * next.open) / position.shares;
        position.entryDate ||= next.date;
        position.entryReason ||= signal.reason;
        position.stage += 1;
        actions.push({ date: next.date, action: signal.action === "buy" ? "買進" : "加碼", price: next.open, reason: signal.reason });
      }
    } else if ((signal?.action === "reduce" || signal?.action === "sell") && position.shares > 0) {
      const sellShares = signal.action === "sell" ? position.shares : Math.max(1, Math.floor(position.shares * signal.size));
      cash += sellShares * next.open;
      position.shares -= sellShares;
      actions.push({ date: next.date, action: signal.action === "sell" ? "出清" : "減碼", price: next.open, reason: signal.reason });
      if (signal.reason.includes("首次")) position.reducedMa20 = true;
      if (signal.reason.includes("連續 3 日")) position.reducedTrend = true;
      if (signal.reason.includes("Big Win")) position.reducedBigWin = true;
      if (signal.action === "sell" || position.shares <= 0) {
        trades.push({
          entryDate: position.entryDate,
          exitDate: next.date,
          entryPrice: position.entryPrice,
          exitPrice: next.open,
          returnPct: next.open / position.entryPrice - 1,
          entryReason: position.entryReason,
          exitReason: signal.reason,
        });
        position = { shares: 0, entryPrice: null, entryDate: null, stage: 0, entryReason: "", reducedMa20: false, reducedTrend: false, reducedBigWin: false };
      }
    }
    equity.push({ date: bars[i].date, value: cash + position.shares * bars[i].close });
  }

  const last = bars[bars.length - 1];
  if (position.shares > 0) {
    trades.push({
      entryDate: position.entryDate,
      exitDate: "回測結束仍持有",
      entryPrice: position.entryPrice,
      exitPrice: last.close,
      returnPct: last.close / position.entryPrice - 1,
      entryReason: position.entryReason,
      exitReason: "回測結束仍持有",
    });
  }

  const finalEquity = cash + position.shares * last.close;
  const drawdown = equity.reduce((acc, point) => {
    const peak = Math.max(acc.peak, point.value);
    return { peak, drawdown: Math.min(acc.drawdown, point.value / peak - 1) };
  }, { peak: capital, drawdown: 0 }).drawdown;
  const closedTrades = trades.filter((trade) => trade.exitDate !== "回測結束仍持有");
  const wins = closedTrades.filter((trade) => trade.returnPct > 0).length;
  const decision = latestDecision(bars, {
    isOpen: position.shares > 0,
    entryPrice: position.entryPrice,
    market: symbolInfo.market,
    volumeThreshold: threshold,
  });

  return {
    symbolInfo,
    bars,
    trades,
    actions,
    equity,
    finalEquity,
    returnPct: finalEquity / capital - 1,
    buyHoldPct: last.close / bars[0].close - 1,
    drawdown,
    winRate: closedTrades.length ? wins / closedTrades.length : null,
    isOpen: position.shares > 0,
    decision,
  };
}

function toneForStatus(text) {
  if (/適合|可加碼|持有|強|漲/.test(text)) return "good";
  if (/等待|暫不|一般|洗盤/.test(text)) return "warn";
  return "bad";
}

function statusPill(text) {
  return `<span class="pill ${toneForStatus(text)}">${text}</span>`;
}

function addQueryHistory(symbolInfo) {
  const history = readStore(STORAGE.queryHistory, { tw: [], us: [] });
  const item = { symbol: symbolInfo.symbol, name: symbolInfo.name, market: symbolInfo.market, time: new Date().toISOString() };
  history[symbolInfo.market] = [item, ...history[symbolInfo.market].filter((x) => x.symbol !== item.symbol)].slice(0, 12);
  writeStore(STORAGE.queryHistory, history);
  renderHistory();
}

function renderHistory() {
  const history = readStore(STORAGE.queryHistory, { tw: [], us: [] });
  const items = history[state.market] || [];
  $("#queryHistory").innerHTML = items.length ? items.map((item) => `
    <button class="history-item" data-symbol="${item.symbol}" data-market="${item.market}">
      <strong>${item.symbol}</strong><span>${item.name}</span>
    </button>
  `).join("") : `<p class="empty">尚無${MARKET_NAMES[state.market]}歷史。</p>`;
}

function renderQueryResult(result) {
  state.lastResult = result;
  const { symbolInfo, decision } = result;
  $("#resultMarket").textContent = MARKET_NAMES[symbolInfo.market];
  $("#resultTitle").textContent = `${symbolInfo.symbol} ${symbolInfo.name}`;
  $("#stableDate").textContent = `收盤日 ${decision.metrics.date}`;
  const metrics = [
    ["策略報酬", fmtPct(result.returnPct), result.returnPct >= 0 ? "good" : "bad"],
    ["買進持有", fmtPct(result.buyHoldPct), result.buyHoldPct >= 0 ? "good" : "bad"],
    ["最大回撤", fmtPct(result.drawdown), "bad"],
    ["交易 / 勝率", `${result.trades.length} / ${result.winRate === null ? "-" : fmtPct(result.winRate)}`, ""],
    ["20日量比", fmtNum(decision.metrics.volumeRatio20), ""],
    ["5日量比", fmtNum(decision.metrics.volumeRatio5), ""],
    ["成交金額", fmtMoney(decision.metrics.turnover), ""],
    ["20MA 乖離", fmtPct(decision.metrics.ma20Distance), ""],
  ];
  $("#metricGrid").innerHTML = metrics.map(([label, value, tone]) => `<article class="metric ${tone}"><span>${label}</span><strong>${value}</strong></article>`).join("");
  $("#entryCard").className = `highlight ${decision.entryReady ? "good" : "warn"}`;
  $("#addCard").className = `highlight ${toneForStatus(decision.addStatus)}`;
  $("#entryStatus").innerHTML = statusPill(decision.entryReady ? "適合進場" : "暫不進場");
  $("#entryReason").textContent = decision.entryReasons.join("、");
  $("#addStatus").innerHTML = statusPill(decision.addStatus);
  $("#addReason").textContent = decision.addReasons.join("、");
  $("#structureStatus").innerHTML = statusPill(decision.structure);
  $("#conclusionText").textContent = `${TTT_IDENTITY}。目前${result.isOpen ? "策略仍持有" : "策略為空手"}，收盤 ${fmtNum(decision.metrics.close)}，20MA ${fmtNum(decision.metrics.ma20)}。`;
  renderTrades(result.trades);
  renderChart(result);
}

function renderTrades(trades) {
  $("#tradeTable").innerHTML = trades.length ? trades.map((trade) => `
    <tr>
      <td>${trade.entryDate || "-"}</td>
      <td>${trade.exitDate || "-"}</td>
      <td>${fmtNum(trade.entryPrice)}</td>
      <td>${fmtNum(trade.exitPrice)}</td>
      <td>${fmtPct(trade.returnPct)}</td>
      <td>${trade.entryReason || "-"}</td>
      <td>${trade.exitReason || "-"}</td>
    </tr>
  `).join("") : `<tr><td colspan="7">這段資料沒有觸發 TTT 交易。</td></tr>`;
}

function renderChart(result) {
  const svg = $("#priceChart");
  const width = svg.clientWidth || 960;
  const height = 390;
  const pad = { top: 22, right: 22, bottom: 34, left: 56 };
  const bars = result.bars.slice(state.zoom?.start ?? 0, state.zoom?.end ?? result.bars.length);
  const values = bars.flatMap((bar) => [bar.close, bar.ma20].filter(Number.isFinite));
  const min = Math.min(...values) * 0.96;
  const max = Math.max(...values) * 1.04;
  const x = (index) => pad.left + (index / Math.max(1, bars.length - 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (1 - (value - min) / (max - min)) * (height - pad.top - pad.bottom);
  const line = (field) => bars.map((bar, index) => Number.isFinite(bar[field]) ? `${x(index).toFixed(1)},${y(bar[field]).toFixed(1)}` : null).filter(Boolean).join(" ");
  const dateIndex = new Map(bars.map((bar, index) => [bar.date, index]));
  const markers = result.actions.map((action) => {
    const index = dateIndex.get(action.date);
    if (index === undefined) return "";
    const color = action.action === "買進" || action.action === "加碼" ? "#15803d" : "#b91c1c";
    return `<circle cx="${x(index)}" cy="${y(action.price)}" r="5" fill="${color}"><title>${action.date} ${action.action} ${fmtNum(action.price)} ${action.reason}</title></circle>`;
  }).join("");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <rect width="${width}" height="${height}" fill="#fbfcfb"></rect>
    <g stroke="#dbe3ef" stroke-width="1">
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}"></line>
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}"></line>
    </g>
    <text x="12" y="${y(max * 0.985)}" fill="#64748b" font-size="12">${fmtNum(max)}</text>
    <text x="12" y="${y(min * 1.015)}" fill="#64748b" font-size="12">${fmtNum(min)}</text>
    <polyline points="${line("close")}" fill="none" stroke="#1d4ed8" stroke-width="2.4"></polyline>
    <polyline points="${line("ma20")}" fill="none" stroke="#b45309" stroke-width="1.8" stroke-dasharray="5 5"></polyline>
    ${markers}
    <text x="${pad.left}" y="${height - 10}" fill="#64748b" font-size="12">${bars[0]?.date || ""}</text>
    <text x="${width - 104}" y="${height - 10}" fill="#64748b" font-size="12">${bars[bars.length - 1]?.date || ""}</text>
  `;
}

function renderError(message) {
  $("#metricGrid").innerHTML = `<article class="metric bad"><span>資料錯誤</span><strong>抓取失敗</strong></article>`;
  $("#entryStatus").innerHTML = statusPill("暫不進場");
  $("#entryReason").textContent = message;
  $("#addStatus").innerHTML = statusPill("不適合加碼");
  $("#addReason").textContent = "沒有可用的真實 OHLCV 資料。";
  $("#structureStatus").innerHTML = statusPill("資料不足");
  $("#conclusionText").textContent = message;
  $("#priceChart").innerHTML = "";
  $("#tradeTable").innerHTML = `<tr><td colspan="7">${message}</td></tr>`;
}

async function runQuery() {
  const symbolInfo = resolveStock($("#symbolInput").value, state.market);
  $("#runQueryButton").disabled = true;
  $("#runQueryButton").textContent = "抓取資料中";
  $("#resultTitle").textContent = `${symbolInfo.symbol} ${symbolInfo.name}`;
  $("#stableDate").textContent = "讀取 Yahoo Finance OHLCV...";
  try {
    const rawBars = await fetchHistoricalBars(symbolInfo, Number($("#yearsInput").value));
    const result = runBacktest(symbolInfo, rawBars);
    renderQueryResult(result);
    addQueryHistory(symbolInfo);
  } catch (error) {
    renderError(error.message);
  } finally {
    $("#runQueryButton").disabled = false;
    $("#runQueryButton").textContent = "執行 TTT 回測";
  }
}

function scanCacheKey() {
  return [todayKey(), "TTT v2.0 yahoo-real", $("#scanLimitInput").value, $("#yearsInput").value, $("#scanVolumeThreshold").value, $("#scanSymbols").value.trim()].join("|");
}

async function buildScannerRows(useCache = true) {
  const cache = readStore(STORAGE.scanCache, {});
  const key = scanCacheKey();
  if (useCache && cache[key]) {
    $("#scanCacheStatus").textContent = `已讀取今日快取：${cache[key].length} 檔`;
    state.scanRows = cache[key];
    return state.scanRows;
  }
  const symbols = $("#scanSymbols").value.split(/\s+/).filter(Boolean).slice(0, Number($("#scanLimitInput").value));
  const threshold = Number($("#scanVolumeThreshold").value);
  state.scanRows = [];
  $("#scannerTable").innerHTML = `<tr><td colspan="16">正在抓取 Yahoo Finance 真實日 K：0 / ${symbols.length}</td></tr>`;

  for (const [index, input] of symbols.entries()) {
    const info = resolveStock(input, "tw");
    try {
      const rawBars = await fetchHistoricalBars(info, Number($("#yearsInput").value));
      const result = runBacktest(info, rawBars, { years: Number($("#yearsInput").value), volumeThreshold: threshold });
      const d = result.decision;
      state.scanRows.push({
        originalRank: index + 1,
        symbol: info.symbol,
        yahooSymbol: info.yahooSymbol || `${info.symbol}.TW`,
        name: info.name,
        entryReady: d.entryReady,
        addStatus: d.addStatus,
        date: d.metrics.date,
        close: d.metrics.close,
        ma5: d.metrics.ma5,
        ma20: d.metrics.ma20,
        ma60: d.metrics.ma60,
        volumeRatio20: d.metrics.volumeRatio20 || 0,
        volumeRatio5: d.metrics.volumeRatio5 || 0,
        structure: d.structure,
        turnover: d.metrics.turnover,
        ma20Distance: d.metrics.ma20Distance || 0,
        reason: d.entryReady ? d.entryReasons[0] : d.entryReasons.slice(0, 2).join("、"),
      });
    } catch (error) {
      state.scanRows.push({
        originalRank: index + 1,
        symbol: info.symbol,
        yahooSymbol: `${info.symbol}.TW`,
        name: info.name,
        entryReady: false,
        addStatus: "不適合加碼",
        date: "-",
        close: null,
        ma5: null,
        ma20: null,
        ma60: null,
        volumeRatio20: 0,
        volumeRatio5: 0,
        structure: "資料錯誤",
        turnover: 0,
        ma20Distance: 0,
        reason: error.message,
      });
    }
    $("#scanCacheStatus").textContent = `抓取真實資料：${index + 1} / ${symbols.length}`;
  }
  cache[key] = state.scanRows;
  writeStore(STORAGE.scanCache, cache);
  $("#scanCacheStatus").textContent = `已建立今日快取：${state.scanRows.length} 檔`;
  return state.scanRows;
}

function getVisibleScanRows() {
  const minVol = Number($("#scanVolumeThreshold").value);
  const addFilter = $("#scanAddFilter").value;
  let rows = state.scanRows.filter((row) => row.volumeRatio20 >= minVol && (addFilter === "all" || row.addStatus === addFilter));
  if (state.scanSort.key && state.scanSort.dir) {
    const { key, dir } = state.scanSort;
    rows = [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), "zh-Hant") * dir;
    });
  } else {
    rows = [...rows].sort((a, b) => {
      const rank = (value) => value === "可加碼觀察" ? 0 : value === "等待加碼" ? 1 : 2;
      return rank(a.addStatus) - rank(b.addStatus) || b.volumeRatio20 - a.volumeRatio20 || a.ma20Distance - b.ma20Distance || a.originalRank - b.originalRank;
    });
  }
  return rows;
}

function renderScanner() {
  const rows = getVisibleScanRows();
  $("#scannerTable").innerHTML = rows.length ? rows.map((row, index) => `
    <tr data-symbol="${row.symbol}">
      <td>${index + 1}</td>
      <td>${row.yahooSymbol || `${row.symbol}.TW`}</td>
      <td>${row.name}</td>
      <td>${statusPill(row.entryReady ? "適合進場" : "暫不進場")}</td>
      <td>${statusPill(row.addStatus)}</td>
      <td>${row.date}</td>
      <td>${fmtNum(row.close)}</td>
      <td>${fmtNum(row.ma5)}</td>
      <td>${fmtNum(row.ma20)}</td>
      <td>${fmtNum(row.ma60)}</td>
      <td>${fmtNum(row.volumeRatio20)}</td>
      <td>${fmtNum(row.volumeRatio5)}</td>
      <td>${row.structure}</td>
      <td>${fmtMoney(row.turnover)}</td>
      <td>${fmtPct(row.ma20Distance)}</td>
      <td>${row.reason}</td>
    </tr>
  `).join("") : `<tr><td colspan="16">沒有符合條件的股票。</td></tr>`;
}

async function runScan(useCache = true) {
  $("#runScanButton").disabled = true;
  $("#runScanButton").textContent = "掃描中";
  await buildScannerRows(useCache);
  state.scanSort = { key: null, dir: 0 };
  renderScanner();
  $("#runScanButton").disabled = false;
  $("#runScanButton").textContent = "開始掃描";
}

function renderImagePreviews(files) {
  $("#imagePreviewGrid").innerHTML = [...files].map((file, index) => `
    <figure>
      <img src="${URL.createObjectURL(file)}" alt="上傳圖片 ${index + 1}">
      <figcaption>${file.name}</figcaption>
    </figure>
  `).join("");
}

function extractSymbolsFromText(text) {
  return [...new Set((text.match(/[A-Z]{1,5}|\d{4}/g) || []).map((s) => s.trim()))];
}

async function runImageAnalysis() {
  const symbols = extractSymbolsFromText($("#imageSymbols").value);
  $("#runImageAnalysisButton").disabled = true;
  $("#runImageAnalysisButton").textContent = "分析中";
  const rows = [];
  for (const symbol of symbols) {
    const market = /^\d{4}$/.test(symbol) ? "tw" : "us";
    const info = resolveStock(symbol, market);
    try {
      const rawBars = await fetchHistoricalBars(info, Number($("#yearsInput").value));
      const result = runBacktest(info, rawBars, { market });
      const d = result.decision;
      rows.push({ info, result, d, error: null });
    } catch (error) {
      rows.push({ info, result: null, d: null, error: error.message });
    }
  }
  $("#imageResultTable").innerHTML = rows.length ? rows.map(({ info, result, d, error }) => `
    <tr>
      <td>${info.symbol}</td>
      <td>${info.name}</td>
      <td>${d ? statusPill(d.entryReady ? "適合進場" : "暫不進場") : statusPill("資料錯誤")}</td>
      <td>${d ? statusPill(d.addStatus) : "-"}</td>
      <td>${result ? (result.isOpen ? "持有中" : "空手") : "-"}</td>
      <td>${result ? fmtPct(result.returnPct) : "-"}</td>
      <td>${result ? fmtPct(result.buyHoldPct) : "-"}</td>
      <td>${result ? fmtPct(result.drawdown) : "-"}</td>
      <td>${result ? result.trades.length : "-"}</td>
      <td>${d ? d.metrics.date : "-"}</td>
      <td>${d ? fmtNum(d.metrics.close) : "-"}</td>
      <td>${d ? (d.entryReady ? d.entryReasons[0] : d.entryReasons.slice(0, 2).join("、")) : error || "資料抓取失敗"}</td>
    </tr>
  `).join("") : `<tr><td colspan="12">尚未提供可分析的股號。</td></tr>`;
  const history = readStore(STORAGE.imageSymbols, []);
  const merged = [...new Set([...symbols, ...history])].slice(0, 80);
  writeStore(STORAGE.imageSymbols, merged);
  renderImageHistory();
  $("#runImageAnalysisButton").disabled = false;
  $("#runImageAnalysisButton").textContent = "分析股票";
}

function saveImageGroup() {
  const symbols = extractSymbolsFromText($("#imageSymbols").value);
  if (!symbols.length) return;
  const groups = readStore(STORAGE.imageGroups, []);
  groups.unshift({ id: crypto.randomUUID(), date: new Date().toLocaleString("zh-TW"), symbols });
  writeStore(STORAGE.imageGroups, groups.slice(0, 20));
  renderImageHistory();
}

function renderImageHistory() {
  const groups = readStore(STORAGE.imageGroups, []);
  $("#imageGroupHistory").innerHTML = groups.length ? groups.map((group) => `
    <button class="history-item image-group" data-symbols="${group.symbols.join(" ")}">
      <strong>${group.date}</strong><span>${group.symbols.join("、")}</span>
    </button>
  `).join("") : `<p class="empty">尚無圖片組紀錄。</p>`;

  const symbols = readStore(STORAGE.imageSymbols, []);
  $("#imageSymbolHistory").innerHTML = symbols.length ? symbols.map((symbol) => `
    <button class="history-item image-symbol" data-symbol="${symbol}">
      <strong>${symbol}</strong><span>帶回 TTT 查詢</span>
    </button>
  `).join("") : `<p class="empty">尚無圖片股號紀錄。</p>`;
}

function renderFieldGuide() {
  $("#fieldGuide").innerHTML = FIELD_GUIDE.map(([term, desc]) => `
    <div class="field-row"><strong>${term}</strong><span>${desc}</span></div>
  `).join("");
}

function showHelp(kind) {
  const result = state.lastResult;
  const map = {
    entry: ["是否適合進場", result ? result.decision.entryReasons.join("、") : "尚未執行查詢。"],
    add: ["加碼時機", result ? result.decision.addReasons.join("、") : "尚未執行查詢。"],
    conclusion: ["TTT 策略結論", result ? `${TTT_IDENTITY}。最新價量結構：${result.decision.structure}。新買與已持有會分開判斷。` : "尚未執行查詢。"],
  };
  $("#helpTitle").textContent = map[kind][0];
  $("#helpBody").textContent = map[kind][1];
  $("#helpDialog").showModal();
}

function wireEvents() {
  $$(".top-tab").forEach((button) => button.addEventListener("click", () => {
    $$(".top-tab, .view").forEach((el) => el.classList.remove("active"));
    button.classList.add("active");
    $(`#${button.dataset.view}`).classList.add("active");
  }));

  $$(".segment").forEach((button) => button.addEventListener("click", () => {
    $$(".segment").forEach((el) => el.classList.remove("active"));
    button.classList.add("active");
    state.market = button.dataset.market;
    $("#symbolInput").value = state.market === "tw" ? "6217" : "NVDA";
    updateHints();
    renderHistory();
    runQuery();
  }));

  $("#runQueryButton").addEventListener("click", runQuery);
  $("#symbolInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") runQuery();
  });
  $("#refreshNamesButton").addEventListener("click", updateHints);
  $("#clearHistoryButton").addEventListener("click", () => {
    const history = readStore(STORAGE.queryHistory, { tw: [], us: [] });
    history[state.market] = [];
    writeStore(STORAGE.queryHistory, history);
    renderHistory();
  });
  $("#queryHistory").addEventListener("click", (event) => {
    const item = event.target.closest(".history-item");
    if (!item) return;
    state.market = item.dataset.market;
    $("#symbolInput").value = item.dataset.symbol;
    $$(".segment").forEach((el) => el.classList.toggle("active", el.dataset.market === state.market));
    updateHints();
    runQuery();
  });

  $("#runScanButton").addEventListener("click", () => runScan(true));
  $("#scanAddFilter").addEventListener("change", renderScanner);
  $("#scanVolumeThreshold").addEventListener("change", renderScanner);
  $("#clearScanCacheButton").addEventListener("click", () => {
    writeStore(STORAGE.scanCache, {});
    $("#scanCacheStatus").textContent = "掃描快取已清除。";
    runScan(false);
  });
  $$("#scanner th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    state.scanSort = state.scanSort.key === key ? { key, dir: state.scanSort.dir === 1 ? -1 : state.scanSort.dir === -1 ? 0 : 1 } : { key, dir: 1 };
    renderScanner();
  }));
  $("#scannerTable").addEventListener("dblclick", (event) => {
    const row = event.target.closest("tr[data-symbol]");
    if (!row) return;
    state.market = "tw";
    $("#symbolInput").value = row.dataset.symbol;
    $$(".segment").forEach((el) => el.classList.toggle("active", el.dataset.market === "tw"));
    updateHints();
    $$(".top-tab, .view").forEach((el) => el.classList.remove("active"));
    $('.top-tab[data-view="query"]').classList.add("active");
    $("#query").classList.add("active");
    runQuery();
  });

  $("#imageInput").addEventListener("change", (event) => renderImagePreviews(event.target.files));
  $("#mockExtractButton").addEventListener("click", () => {
    const fromFiles = [...$("#imageInput").files].flatMap((file) => extractSymbolsFromText(file.name));
    const fromText = extractSymbolsFromText($("#imageSymbols").value);
    $("#imageSymbols").value = [...new Set([...fromText, ...fromFiles])].join(" ");
  });
  $("#runImageAnalysisButton").addEventListener("click", runImageAnalysis);
  $("#saveImageGroupButton").addEventListener("click", saveImageGroup);
  $("#imageGroupHistory").addEventListener("click", (event) => {
    const item = event.target.closest(".image-group");
    if (!item) return;
    $("#imageSymbols").value = item.dataset.symbols;
    $$(".top-tab, .view").forEach((el) => el.classList.remove("active"));
    $('.top-tab[data-view="image"]').classList.add("active");
    $("#image").classList.add("active");
    runImageAnalysis();
  });
  $("#imageSymbolHistory").addEventListener("dblclick", (event) => {
    const item = event.target.closest(".image-symbol");
    if (!item) return;
    state.market = /^\d{4}$/.test(item.dataset.symbol) ? "tw" : "us";
    $("#symbolInput").value = item.dataset.symbol;
    $$(".segment").forEach((el) => el.classList.toggle("active", el.dataset.market === state.market));
    updateHints();
    $$(".top-tab, .view").forEach((el) => el.classList.remove("active"));
    $('.top-tab[data-view="query"]').classList.add("active");
    $("#query").classList.add("active");
    runQuery();
  });
  $("#clearImageGroupsButton").addEventListener("click", () => {
    writeStore(STORAGE.imageGroups, []);
    renderImageHistory();
  });
  $("#clearImageSymbolsButton").addEventListener("click", () => {
    writeStore(STORAGE.imageSymbols, []);
    renderImageHistory();
  });
  $$(".help-button").forEach((button) => button.addEventListener("click", () => showHelp(button.dataset.help)));
  $("#resetZoomButton").addEventListener("click", () => {
    state.zoom = null;
    if (state.lastResult) renderChart(state.lastResult);
  });
}

function init() {
  updateHints();
  renderHistory();
  renderImageHistory();
  renderFieldGuide();
  wireEvents();
  runQuery();
  runScan(true);
}

init();
