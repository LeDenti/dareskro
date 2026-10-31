import { newMission, memosFor, totalXrp, milestoneView, rippleTime, fromRippleTime } from "./mission.mjs";
let failed = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); if (!cond) failed++; };
const expectBad = (name, input, re) => { try { newMission(input); check(name, false, "accepted"); } catch (e) { check(name, re.test(e.message), e.message); } };
const C = "rpzsyCvfUThLwJY46frCuwjDWstTarpALH", F = "rsJeK2Vcyk8MGsWFR2dFjXoo5HKNkhy4Vt";
const soon = new Date(Date.now() + 3600_000).toISOString();
const sha = "a".repeat(64);

const m = newMission({ title: "Landing page copy", client: C, freelancer: F, amountXrp: "40", deadline: soon, proofMode: "hash", url: "https://github.com/x/y/releases/download/v1/copy.md", sha256: sha.toUpperCase() });
check("single-milestone mission from flat fields", m.milestones.length === 1 && m.milestones[0].proof.sha256 === sha && m.milestones[0].title === "Delivery");
check("share token and ids", /^[0-9a-f]{32}$/.test(m.shareToken) && /^[0-9a-f]{12}$/.test(m.id));
check("cancelAfter is the deadline in ripple time", fromRippleTime(m.milestones[0].cancelAfter).toISOString().slice(0, 19) === soon.slice(0, 19));
const memos = memosFor(m, m.milestones[0], "rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW");
check("memos: case, mission, proof, oracle", memos.map((x) => x.type).join() === "dareskro/case,dareskro/mission,dareskro/proof,dareskro/oracle" && memos[2].data.startsWith("sha256:aaaa"));

const m2 = newMission({ title: "Logo", client: C, freelancer: F, milestones: [
  { title: "Sketches", amountXrp: "10.5", deadline: soon, proof: { mode: "acceptance" } },
  { title: "Final files", amountXrp: "29.5", deadline: soon, proof: { mode: "acceptance", url: "https://drive.example/folder" } },
] });
check("two acceptance milestones", m2.milestones.length === 2 && m2.milestones[1].proof.url && !m2.milestones[0].proof.url);
check("total", totalXrp(m2) === "40");
check("acceptance memo names the client", memosFor(m2, m2.milestones[0]).find((x) => x.type === "dareskro/proof").data === `acceptance-by:${C}`);

expectBad("missing title", { client: C, freelancer: F, amountXrp: "1", deadline: soon, url: "https://a/b", sha256: sha }, /title/);
expectBad("bad client address", { title: "t", client: "rNOPE", freelancer: F, amountXrp: "1", deadline: soon, url: "https://a/b", sha256: sha }, /client's XRPL address/);
expectBad("same addresses", { title: "t", client: C, freelancer: C, amountXrp: "1", deadline: soon, url: "https://a/b", sha256: sha }, /same address/);
expectBad("zero amount", { title: "t", client: C, freelancer: F, amountXrp: "0", deadline: soon, url: "https://a/b", sha256: sha }, /amount/);
expectBad("7 decimals", { title: "t", client: C, freelancer: F, amountXrp: "1.1234567", deadline: soon, url: "https://a/b", sha256: sha }, /amount/);
expectBad("deadline in the past", { title: "t", client: C, freelancer: F, amountXrp: "1", deadline: "2020-01-01", url: "https://a/b", sha256: sha }, /deadline/);
expectBad("hash mode without URL", { title: "t", client: C, freelancer: F, amountXrp: "1", deadline: soon, sha256: sha }, /proof URL/);
expectBad("hash mode with ftp URL", { title: "t", client: C, freelancer: F, amountXrp: "1", deadline: soon, url: "ftp://a/b", sha256: sha }, /http/);
expectBad("hash mode with short hash", { title: "t", client: C, freelancer: F, amountXrp: "1", deadline: soon, url: "https://a/b", sha256: "abc" }, /64 hex/);
expectBad("unknown mode", { title: "t", client: C, freelancer: F, amountXrp: "1", deadline: soon, proofMode: "arbiter" }, /hash or acceptance/);

const v = milestoneView({ ...m.milestones[0], status: "locked" }, { status: "finished", finishHash: "F".repeat(64), checks: 7, lastWhy: "match (75 bytes)" });
check("view: finished → paid with the oracle's word", v.status === "paid" && v.oracle.finishHash && v.oracle.checks === 7);
check("view: expired → refunded", milestoneView({ ...m.milestones[0], status: "locked" }, { status: "expired-refunded", refundHash: "A".repeat(64) }).status === "refunded");
check("ripple time round trip", fromRippleTime(rippleTime("2026-10-31T12:00:00Z")).toISOString() === "2026-10-31T12:00:00.000Z");
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
