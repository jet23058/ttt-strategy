#!/usr/bin/env python3
"""Local TTT web server with a Yahoo Finance OHLCV proxy."""

from __future__ import annotations

import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class TTTHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/history":
            self.handle_history(parsed.query)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def handle_history(self, query: str) -> None:
        params = urllib.parse.parse_qs(query)
        symbol = first(params, "symbol", "2330").strip().upper()
        market = first(params, "market", "tw").strip().lower()
        years = clamp_int(first(params, "years", "3"), 1, 10)

        errors: list[str] = []
        for yahoo_symbol in yahoo_candidates(symbol, market):
            try:
                payload = fetch_yahoo_chart(yahoo_symbol, years)
                bars, name = parse_yahoo_payload(payload)
                if bars:
                    self.write_json({
                        "symbol": symbol,
                        "yahooSymbol": yahoo_symbol,
                        "name": name,
                        "bars": bars,
                    })
                    return
                errors.append(f"{yahoo_symbol}: no bars")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{yahoo_symbol}: {exc}")

        self.write_json({"error": "；".join(errors) or "Yahoo Finance 沒有回傳資料"}, status=502)

    def write_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def first(params: dict[str, list[str]], key: str, default: str) -> str:
    return params.get(key, [default])[0]


def clamp_int(value: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(float(value))
    except ValueError:
        parsed = minimum
    return max(minimum, min(maximum, parsed))


def yahoo_candidates(symbol: str, market: str) -> list[str]:
    raw = symbol.replace(".TW", "").replace(".TWO", "")
    if market == "tw":
        return [f"{raw}.TW", f"{raw}.TWO"]
    return [raw]


def yahoo_range(years: int) -> str:
    if years <= 1:
        return "1y"
    if years <= 2:
        return "2y"
    if years <= 5:
        return "5y"
    return "10y"


def fetch_yahoo_chart(yahoo_symbol: str, years: int) -> dict:
    params = urllib.parse.urlencode({
        "range": yahoo_range(years),
        "interval": "1d",
        "events": "history",
    })
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_symbol)}?{params}"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_yahoo_payload(payload: dict) -> tuple[list[dict], str | None]:
    result = (payload.get("chart", {}).get("result") or [None])[0]
    if not result:
        error = payload.get("chart", {}).get("error")
        raise ValueError(error.get("description") if error else "empty chart result")

    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    meta = result.get("meta") or {}
    bars: list[dict] = []
    for index, timestamp in enumerate(timestamps):
        try:
            bar = {
                "date": time.strftime("%Y-%m-%d", time.gmtime(int(timestamp))),
                "open": float(quote["open"][index]),
                "high": float(quote["high"][index]),
                "low": float(quote["low"][index]),
                "close": float(quote["close"][index]),
                "volume": float(quote["volume"][index]),
            }
        except (TypeError, ValueError, KeyError, IndexError):
            continue
        bars.append(bar)
    return bars, meta.get("longName") or meta.get("shortName")


def main() -> None:
    mimetypes.add_type("text/javascript", ".js")
    server = ThreadingHTTPServer(("127.0.0.1", 4173), TTTHandler)
    print("TTT web server running at http://127.0.0.1:4173")
    server.serve_forever()


if __name__ == "__main__":
    main()
