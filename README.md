# makefun-token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/hadestxt1/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/hadestxt1/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar that reads a frozen DefiLlama snapshot and ranks every protocol without a token yet by what its launch would be worth — calibrated on the trading protocols in the same snapshot, not on a guessed constant — with a static dashboard, a farm plan per protocol, and a live-token view.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

The program reads the sealed snapshot, writes the ranked board to `board.json`, the dashboard data to `data.js`, and copies `dashboard/` and `screenshots/` into the output directory before writing `dossier.json` from them.

The board ranks 160 protocols: the whole 40-protocol watchlist plus 120 early finds below the $50M floor, topped by Steakhouse Financial at $620.6M implied value.

---

<sub>Entered on [make.fun](https://make.fun/?ref=h6rdc0dr&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
