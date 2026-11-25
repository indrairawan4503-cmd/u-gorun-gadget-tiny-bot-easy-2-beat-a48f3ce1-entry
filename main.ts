// Variant B — Mean-reversion + momentum blend (long only).
//
// The idea, in one line: buy oversold bounces, never catch a falling knife, let
// winners run while momentum confirms, and size by recent volatility.
//
// The harness speaks agent-fun/bars-replay/v1: it sends a `hello` line first, then
// one `batch` line per hourly bar (each carrying that bar's bars, the fills of the
// orders we decided on the previous bar, and the account), and finally `done`.
// We answer every batch with exactly one reply line echoing its seq and our
// `orders` for that bar. Orders decided on bar k fill at bar k+1's open, so every
// signal below is read off closes the harness has already sent us — no lookahead,
// no clock, no environment, no randomness: the same bars always give the same
// orders, run after run.
//
// Per symbol, over its own closes only:
//   - RSI(14), Wilder's smoothing (first averages are the means of 14 changes).
//   - Bollinger bands of the last 20 typical prices ((h+l+c)/3), 2 population sigmas.
//   - EMA(12) and SMA(24) for the trend filter; 24h log-return volatility for sizing.
//
// Entry (a symbol we do not hold): RSI below 30 AND the close below the lower
// Bollinger band — a genuinely oversold dip — AND the trend filter passes: the
// close is no more than 10% under its SMA(24) and the 12h return is above -10%,
// so we only buy dips inside a weak-or-better tape and never into a waterfall.
// The filter is deliberately light: on the dev window the strict version blocked
// the best bounces, while this one only keeps us out of true free falls.
// Exit (the whole position): RSI above 58 (overbought), or +5% profit target, or
// -6% stop, or a 20-bar time cap — extended to 48 bars while momentum confirms
// (RSI above 55, close above EMA(12), 6h return above +2%), so winners are held
// while they keep working instead of being sold into strength.
// Sizing: equity / 7 slots, scaled inversely to recent hourly volatility (target
// 0.8%/h, clamped 0.5x-1.5x), capped at 25% of equity per position; new stakes are
// halved while equity sits more than 3% under its session peak (drawdown guard).
// Sells go first in every reply, then buys, at most caps.max_orders_per_bar in
// all; each order caps slippage at 100 bps past the close it was decided on.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const RSI_BARS = 14;
const BAND_BARS = 20;
const BAND_SIGMAS = 2;
const EMA_BARS = 12;
const SMA_BARS = 24;
const VOL_BARS = 24;
const RSI_ENTRY_BELOW = 30;
const RSI_EXIT_ABOVE = 58;
const RSI_MOMENTUM = 55;
const TREND_SMA_TOL = 0.9; // close must be >= 90% of SMA(24): blocks only waterfalls
const TREND_12H_MIN = -0.1; // 12h return must be above -10%
const MOMENTUM_6H_MIN = 0.02; // 6h return above +2% to extend the hold
const ROI_NUM = 105n; // +5% profit target
const ROI_DEN = 100n;
const STOP_NUM = 94n; // -6% stop loss
const STOP_DEN = 100n;
const HOLD_BARS = 20; // time-based exit
const HOLD_BARS_MOMENTUM = 48; // extended hold while momentum confirms
const TARGET_VOL = 0.008; // 0.8% per hour
const VOL_MIN_FACTOR = 0.5;
const VOL_MAX_FACTOR = 1.5;
const DD_GUARD = 0.03; // halve new stakes past 3% drawdown from peak
const MAX_SLIPPAGE_BPS = 100;

interface Series {
  closes: number[];
  typical: number[];
  last: number | null;
  first: number[];
  gain: number | null;
  loss: number | null;
  ema: number | null;
}

const series = new Map<string, Series>();
/** Bar seq at which each held position was entered (from the buy fill). */
const enteredAt = new Map<string, number>();
let peakEquity = 0n;

function push(bar: Bar): void {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = { closes: [], typical: [], last: null, first: [], gain: null, loss: null, ema: null }));
  const c = Number(bar.c);
  s.closes.push(c);
  if (s.closes.length > 60) s.closes.shift();
  s.typical.push((Number(bar.h) + Number(bar.l) + c) / 3);
  if (s.typical.length > BAND_BARS) s.typical.shift();
  const k = 2 / (EMA_BARS + 1);
  s.ema = s.ema === null ? c : c * k + s.ema * (1 - k);
  if (s.last !== null) {
    const change = c - s.last;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    if (s.gain === null || s.loss === null) {
      s.first.push(change);
      if (s.first.length === RSI_BARS) {
        s.gain = s.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
        s.loss = s.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
      }
    } else {
      s.gain = (s.gain * (RSI_BARS - 1) + up) / RSI_BARS;
      s.loss = (s.loss * (RSI_BARS - 1) + down) / RSI_BARS;
    }
  }
  s.last = c;
}

function rsi(s: Series): number | null {
  if (s.gain === null || s.loss === null) return null;
  const moved = s.gain + s.loss;
  return moved === 0 ? 50 : (100 * s.gain) / moved;
}

function lowerBand(s: Series): number | null {
  if (s.typical.length < BAND_BARS) return null;
  const mean = s.typical.reduce((a, x) => a + x, 0) / BAND_BARS;
  const variance = s.typical.reduce((a, x) => a + (x - mean) * (x - mean), 0) / BAND_BARS;
  return mean - BAND_SIGMAS * Math.sqrt(variance);
}

function sma(s: Series, n: number): number | null {
  if (s.closes.length < n) return null;
  const tail = s.closes.slice(-n);
  return tail.reduce((a, x) => a + x, 0) / n;
}

/** Return over the last n bars, or null without enough closes. */
function ret(s: Series, n: number): number | null {
  if (s.closes.length <= n) return null;
  const now = s.closes[s.closes.length - 1];
  const then = s.closes[s.closes.length - 1 - n];
  return then === 0 ? null : now / then - 1;
}

/** Std dev of the last VOL_BARS hourly log returns, or null without enough closes. */
function hourlyVol(s: Series): number | null {
  if (s.closes.length <= VOL_BARS) return null;
  const logs: number[] = [];
  for (let i = s.closes.length - VOL_BARS; i < s.closes.length; i++) logs.push(Math.log(s.closes[i] / s.closes[i - 1]));
  const mean = logs.reduce((a, x) => a + x, 0) / logs.length;
  const variance = logs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / logs.length;
  return Math.sqrt(variance);
}

/** Momentum still confirms the winner: strong RSI, price above EMA(12), 6h up. */
function momentumConfirms(s: Series, r: number | null): boolean {
  const r6 = ret(s, 6);
  return r !== null && r > RSI_MOMENTUM && s.ema !== null && s.last !== null && s.last > s.ema && r6 !== null && r6 > MOMENTUM_6H_MIN;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) push(bar);
    // Record entries from this batch's fills so the time-based exit knows the age.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') enteredAt.set(f.symbol, batch.seq);
      else enteredAt.delete(f.symbol);
    }
    if (state.warmingUp) return [];
    if (state.equity > peakEquity) peakEquity = state.equity;
    const inDrawdown = peakEquity > 0n && Number(peakEquity - state.equity) / Number(peakEquity) > DD_GUARD;

    const fresh = new Set(batch.bars.map((b) => b.symbol));
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      if (s === undefined || !fresh.has(symbol)) continue;
      const r = rsi(s);
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const value = state.value(symbol, held.qty);
        const roi = value * ROI_DEN >= held.cost * ROI_NUM;
        const stop = value * STOP_DEN <= held.cost * STOP_NUM;
        const age = batch.seq - (enteredAt.get(symbol) ?? batch.seq);
        const cap = momentumConfirms(s, r) ? HOLD_BARS_MOMENTUM : HOLD_BARS;
        if ((r !== null && r > RSI_EXIT_ABOVE) || roi || stop || age >= cap) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }
      const lower = lowerBand(s);
      const sma24 = sma(s, SMA_BARS);
      const r12 = ret(s, 12);
      const trendOk =
        s.last !== null && sma24 !== null && s.last >= sma24 * TREND_SMA_TOL && r12 !== null && r12 > TREND_12H_MIN;
      if (r !== null && lower !== null && r < RSI_ENTRY_BELOW && s.last !== null && s.last < lower && trendOk) {
        entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const baseStake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      const s = series.get(symbol)!;
      const vol = hourlyVol(s);
      let factor = 1;
      if (vol !== null && vol > 0) factor = Math.min(VOL_MAX_FACTOR, Math.max(VOL_MIN_FACTOR, TARGET_VOL / vol));
      if (inDrawdown) factor *= 0.5;
      let slice = (baseStake * BigInt(Math.round(factor * 1000))) / 1000n;
      if (slice > byWeight) slice = byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
