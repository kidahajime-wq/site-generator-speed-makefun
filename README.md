# site-generator-speed-makefun

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/kidahajime-wq/site-generator-speed-makefun/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/kidahajime-wq/site-generator-speed-makefun/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for makefun-site 1.0.0, a static site generator. It answers exactly as makefun-site does on every case — the same output tree, byte for byte — by removing the baseline's structural bottlenecks instead of micro-optimizing it: templates are compiled once per case and reused across all 200–600 pages, Markdown is rendered by a single-pass scanner that never re-parses shared structure, and output strings are built with as few allocations as the spec allows.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver docker
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=4wdzbnwz&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
