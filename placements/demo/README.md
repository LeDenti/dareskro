# Demo publications for the BottomRadar placement measurement

Two "posts" served from this public repository through `raw.githubusercontent.com`,
the way any creator's page would be read by the oracle: no key, no account, plain HTTP.

| File | Role in the measurement |
|---|---|
| `post-stays.html` | stays online through the period → the oracle releases the escrow to the creator |
| `post-deleted.html` | removed from the repository (a real `git rm` + push) before the date → the oracle lets the escrow expire, the advertiser is refunded |

`raw.githubusercontent.com` caches for 300 s (`Cache-Control: max-age=300`, measured
31/10/2026): a deletion is seen by the oracle within five minutes, which is why the
period of the measurement is longer than that.
