// Pump.fun paper sprint — "burst and rotate".
//
// The harness opens with a hello message (capital, caps, fees), then sends one
// batch per slot: that slot's events, the marks on curves we hold, and the fills
// of orders we sent. Our reply to each batch is the orders decided on that slot.
//
// Strategy, in one line: buy a coin only right after its first burst, then
// rotate out fast and move on to the next coin.
//
// Entry — a coin qualifies on the first batch where ALL of these hold:
//   * it was created at most ENTRY_WINDOW_SLOTS slots ago (a fresh coin),
//   * at least MIN_TRADES trades have printed on it,
//   * its price is up at least MIN_RISE_BPS over its first print (early buyers
//     are pushing it up, not dumping it),
//   * buy volume so far beats sell volume (net inflow, not churn),
//   * its real SOL reserve is big enough that the per-reply size cap lets us
//     buy at least MIN_BUY (so the round trip clears the 0.01 SOL guardrail).
// We then buy min(STAKE, cap). One buy per coin, ever — no re-entry, no
// averaging down. At most MAX_OPEN positions and at most one batch of orders
// per reply, sized against free cash (cash minus what in-flight orders take).
//
// Exit — every batch we check each holding against the price we actually
// filled at (recorded from the buy fill, never from a guess):
//   * a trailing stop: once a coin runs up, we exit when it gives back 12%
//     from its peak since entry (the peak starts at the entry price, so this
//     doubles as the stop loss),
//   * or a time stop after MAX_HOLD_SLOTS slots, whichever comes first.
// Sells are for the whole holding. A completed curve is closed by the
// harness itself, so we never order on one.
//
// Everything is deterministic: every decision comes from the slot number and
// the state the harness sent us. No clock, no environment, no randomness.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n; // 0.30 SOL per coin
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL: clears the guardrail
const MAX_SLIPPAGE_BPS = 10_000; // wide open: never refuse a fill for a moved price
const ENTRY_WINDOW_SLOTS = 600; // ~4 minutes of slots after creation
const MIN_TRADES = 6;
const MIN_RISE_BPS = 1200; // +12% over the coin's first print: only real bursts
const TRAIL_BPS = 8_800; // exit when the price falls 12% below its peak since entry
const MAX_HOLD_SLOTS = 3_600; // ~24 minutes, then rotate out regardless
const MIN_REAL_RESERVE_LAMPORTS = 2n * LAMPORTS_PER_SOL; // cap >= 1% of this = MIN_BUY

/** What we remember about one curve, from its own events. */
interface Tape {
  createdSlot: number;
  firstVq: bigint; // virtual quote reserves at its first print
  firstVt: bigint; // virtual token reserves at its first print
  lastVq: bigint;
  lastVt: bigint;
  trades: number;
  buySol: bigint;
  sellSol: bigint;
  decided: boolean; // an entry decision was made for this coin (bought or skipped)
  entrySlot: number; // slot our buy filled (-1: no fill yet)
  entryQuote: bigint; // lamports spent on the tokens still held
  entryTokens: bigint; // tokens received for them
  peakVq: bigint; // virtual quote reserves at the highest price since entry
  peakVt: bigint; // virtual token reserves at the highest price since entry
}

const tapes = new Map<string, Tape>();

/** Compare two prices (quote-per-token) in basis points: true when a/b >= c/d * bps/10000. */
function priceAtLeast(aVq: bigint, aVt: bigint, bVq: bigint, bVt: bigint, bps: number): boolean {
  return aVq * bVt * BigInt(bps) >= bVq * aVt * 10_000n;
}

function priceAtMost(aVq: bigint, aVt: bigint, bVq: bigint, bVt: bigint, bps: number): boolean {
  return aVq * bVt * BigInt(bps) <= bVq * aVt * 10_000n;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // 1. Fold our fills in: a buy fill records the price we actually paid.
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      const tape = tapes.get(f.mint);
      if (tape === undefined) continue;
      if (f.side === 'buy') {
        tape.entrySlot = f.slot;
        tape.entryQuote = BigInt(f.quote_lamports);
        tape.entryTokens = BigInt(f.token_amount);
        tape.peakVq = tape.lastVq;
        tape.peakVt = tape.lastVt;
      } else {
        // Our sell filled: this coin is done, forget its tape.
        tapes.delete(f.mint);
      }
    }

    // 2. Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!tapes.has(e.mint)) {
          tapes.set(e.mint, {
            createdSlot: e.slot,
            firstVq: BigInt(e.virtual_quote_reserves),
            firstVt: BigInt(e.virtual_token_reserves),
            lastVq: BigInt(e.virtual_quote_reserves),
            lastVt: BigInt(e.virtual_token_reserves),
            trades: 0,
            buySol: 0n,
            sellSol: 0n,
            decided: false,
            entrySlot: -1,
            entryQuote: 0n,
            entryTokens: 0n,
            peakVq: 0n,
            peakVt: 0n,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const tape = tapes.get(e.mint);
        if (tape === undefined) continue;
        tape.lastVq = BigInt(e.virtual_quote_reserves);
        tape.lastVt = BigInt(e.virtual_token_reserves);
        tape.trades += 1;
        if (e.is_buy) tape.buySol += BigInt(e.sol_amount);
        else tape.sellSol += BigInt(e.sol_amount);
      } else {
        // CompleteEvent: the curve is over; drop it so we never order on it.
        tapes.delete(e.mint);
      }
    }

    // 3. Exits first: the trailing stop (12% below the peak since entry),
    // or the time stop.
    for (const [mint, holding] of state.positions) {
      const tape = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (tape === undefined || curve === undefined || curve.complete) continue;
      if (tape.entrySlot < 0 || tape.entryTokens === 0n) continue;
      const held = BigInt(holding.token_amount);
      if (held === 0n) continue;
      // Raise the peak when the price makes a new high since entry.
      if (tape.peakVt !== 0n && priceAtLeast(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        tape.peakVq,
        tape.peakVt,
        10_000,
      )) {
        tape.peakVq = curve.virtual_quote_reserves;
        tape.peakVt = curve.virtual_token_reserves;
      }
      const trailed = tape.peakVt !== 0n && priceAtMost(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        tape.peakVq,
        tape.peakVt,
        TRAIL_BPS,
      );
      const stale = batch.slot - tape.entrySlot > MAX_HOLD_SLOTS;
      if (trailed || stale) {
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: held,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        orders.push(sell);
      }
    }

    // 4. Entries: fresh coins, in the order their events arrived this batch.
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      const tape = tapes.get(e.mint);
      if (tape === undefined || tape.decided) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      if (batch.slot - tape.createdSlot > ENTRY_WINDOW_SLOTS) {
        tape.decided = true; // too old to chase now
        continue;
      }
      if (tape.trades < MIN_TRADES) continue;
      if (tape.buySol < tape.sellSol * 2n) continue; // demand clear net inflow, not churn
      if (tape.firstVt === 0n || tape.lastVt === 0n) continue;
      if (!priceAtLeast(tape.lastVq, tape.lastVt, tape.firstVq, tape.firstVt, 10_000 + MIN_RISE_BPS)) {
        continue; // no burst yet — wait for a later batch
      }
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      tape.decided = true;
      const buy: BuyInput = {
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
