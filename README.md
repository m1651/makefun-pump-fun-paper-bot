# Pump.fun Paper Sprint — Burst and Rotate

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/m1651/makefun-pump-fun-paper-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/m1651/makefun-pump-fun-paper-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It paper-trades pump.fun bonding curves on a recorded replay — no real funds, ever. Highest net PnL on the 6-hour final window wins the $2 pot.

## Strategy: burst and rotate

- **Buy only after the first burst.** A fresh coin (created ≤ 600 slots ago) qualifies when it has printed ≥ 4 trades, its price is up ≥ 6% over its first print, buy volume beats sell volume, and its real SOL reserve is big enough that the size cap allows a ≥ 0.02 SOL buy. One buy per coin, 0.30 SOL at most, never more than 5 open positions.
- **Rotate out fast.** Each holding exits on whichever comes first: +40% take-profit, −20% stop-loss, or 2,400 slots (~16 minutes) held. Sells are for the whole holding.
- **Deterministic.** Every decision comes from the slot number and the state the harness sends. No clock, no environment, no randomness — the two grading runs produce byte-identical action logs.

## Files

- `main.ts` — the strategy (Node 22, stdlib only, TypeScript stripped at run time).
- `vendor/makefun-bot.ts` — the kit's own `agent-fun/replay/v2` wire shim, copied as its docstring directs.

## Run

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`. The bot speaks `agent-fun/replay/v2` on stdin/stdout: a `hello` line, then one `batch` per slot, answered with one `reply` per batch.
