/**
 * Invoice-advance desk — the seventh case: a supplier is paid before the due date, the final client
 * repays the pool. Today's honest version: the pool is a 2-of-3 account (AI proposer, deterministic
 * risk policy, human operator) on testnet, through facture/service.mjs. The desk shows who refuses
 * what: a refusal by the risk policy is a signer's refusal (the ledger would still pay with two other
 * signatures, and the "override" button proves it); the due date of an XRP escrow is the ledger's.
 *
 * Cards: the pool (signers, capital, caps, what each debtor owes) → the invoice (dossier, fingerprint,
 * token) → the three seats (AI analyses and anchors, the policy decides, two signatures pay) → the
 * client's side (lock the repayment, pay, or not) → the due date (cash, settle, or default).
 */
import { useEffect, useState, type ReactNode } from "react";
import * as fac from "./factures";

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
const when = (iso?: string) => (iso ? iso.slice(11, 19) + " UTC" : "");

export function FactureDesk() {
  const [up, setUp] = useState<boolean>();
  const [etat, setEtat] = useState<fac.Etat>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [sel, setSel] = useState<string>();
  const [client, setClient] = useState("client1");
  const [montant, setMontant] = useState("50");
  const [dueS, setDueS] = useState("180");
  const [signataires, setSignataires] = useState<Record<string, boolean>>({ ia: true, politique: true, operateur: false });
  const [now, setNow] = useState(Date.now());

  const refresh = async () => {
    const ok = await fac.alive();
    setUp(ok);
    if (ok) setEtat(await fac.etat());
  };
  useEffect(() => { refresh(); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(undefined);
    try { await fn(); await refresh(); } catch (e) { setError(e); } finally { setBusy(undefined); }
  };
  const f = etat?.factures.find((x) => x.id === sel);
  const act = (a: Parameters<typeof fac.action>[1], body?: unknown) => f && run(a, () => fac.action(f.id, a, body));
  const due = f ? new Date(f.dossier.echeance).getTime() : 0;
  const pastDue = f ? now >= due : false;
  const txLink = (r?: fac.TxResult, text?: string) => r?.hash ? <a href={`${etat?.explorer}/transactions/${r.hash}`} target="_blank">{text ?? short(r.hash)}</a> : null;
  const Res = ({ r, what }: { r?: fac.TxResult; what: string }) => r ? (
    <p className={r.result === "tesSUCCESS" ? "ok" : "ko"}>{what}: {r.result} {txLink(r, "explorer")} {r.message && <span className="muted">— {r.message}</span>} {r.signers && <span className="muted">· signed by {r.signers.map(short).join(" + ")}</span>} <span className="muted">{when(r.close)}</span></p>
  ) : null;
  // the policy's box only counts when its verdict is yes: it never signs otherwise, whatever the box says
  const effectifs = { ia: !!signataires.ia, politique: !!signataires.politique && !!f?.politique?.ok, operateur: !!signataires.operateur };
  const choisis = (Object.entries(effectifs).filter(([, v]) => v).map(([k]) => k));
  const nSig = choisis.length;

  return (
    <>
      <Card n="2" title="The pool — one account, three seats, two signatures">
        {up === false && <p className="ko">Service not running: <code>cd facture && node service.mjs</code> (127.0.0.1:8783, testnet).</p>}
        {etat && !etat.pool && (
          <div className="row">
            <button className="primary" onClick={() => run("init", fac.init)} disabled={!!busy}>{busy === "init" ? "Asking the faucet, creating the pool (≈ 90 s)…" : "Create the pool on testnet (8 faucet accounts, SignerListSet 2/3, master disabled, 80 + 80 XRP)"}</button>
          </div>
        )}
        {etat?.pool && (
          <dl>
            <dt>Pool account</dt>
            <dd><a href={etat.pool.url} target="_blank"><code>{etat.pool.adresse}</code></a> · master key disabled · balance {etat.soldes.pool ?? "?"} XRP · capital {etat.pool.capital} XRP from two lenders (the rest is the reserve and the fees kept)</dd>
            <dt>Signers (quorum 2 of 3)</dt>
            <dd>
              <div>AI proposer <code>{etat.pool.signataires.ia}</code> <span className="muted">— gathers evidence, writes and anchors its analysis, proposes</span></div>
              <div>Risk policy <code>{etat.pool.signataires.politique}</code> <span className="muted">— deterministic code: {etat.limites.partDebiteurMax * 100} % of capital per debtor, {etat.limites.plafondDebiteur} XRP absolute, advance ≤ {etat.limites.tauxAvanceMax * 100} %, due ≤ {etat.limites.echeanceMaxJours} days, anchored analysis required</span></div>
              <div>Operator <code>{etat.pool.signataires.operateur}</code> <span className="muted">— the human (a test key here; a Ledger device on mainnet)</span></div>
            </dd>
            <dt>Outstanding per debtor</dt>
            <dd>{Object.keys(etat.encours).length === 0 ? <span className="muted">nothing advanced</span> : Object.entries(etat.encours).map(([a, v]) => <div key={a}><code>{short(a)}</code> owes {v} XRP ({((Number(v) / etat.pool!.capital) * 100).toFixed(1)} % of capital)</div>)}</dd>
          </dl>
        )}
        <p className="hint">Who holds what: the lenders funded the pool; the pool holds it under 2 of 3; none of the three seats can move it alone; dareskro never has it alone. What the ledger imposes: the signatures, the escrow's date. What a signer imposes: the caps.</p>
      </Card>

      <Card n="3" title="The invoice — a dossier, its fingerprint, a one-unit token" disabled={!etat?.pool}>
        <div className="row">
          <label>Final client (debtor)
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="client1">Pharmacie du Port (test) · {etat?.comptes.client1 ? short(etat.comptes.client1) : ""}</option>
              <option value="client2">Clinique des Pins (test) · {etat?.comptes.client2 ? short(etat.comptes.client2) : ""}</option>
            </select>
          </label>
          <label>Invoice amount (XRP, stands for euros)<input value={montant} onChange={(e) => setMontant(e.target.value)} size={8} /></label>
          <label>Due in (seconds; 30–90 days in production)<input value={dueS} onChange={(e) => setDueS(e.target.value)} size={6} /></label>
          <button className="primary" disabled={!!busy || !etat?.pool} onClick={() => run("creer", async () => { const x = await fac.creer({ client, montant, dueS: Number(dueS) }); setSel(x.id); })}>
            {busy === "creer" ? "Sealing, issuing the token…" : "Create the invoice (dossier sealed, MPT issued by the supplier)"}
          </button>
        </div>
        <p className="hint">Supplier: Atelier Nord (test) <code>{etat?.comptes.fournisseur ? short(etat.comptes.fournisseur) : ""}</code>. Advance 90 %, fee 2 %, balance to the supplier after collection. The dossier (names, documents) stays off-chain; its SHA-256 goes in the token's metadata and in every memo.</p>
        {etat && etat.factures.length > 0 && (
          <table className="lines"><tbody>
            {etat.factures.slice().reverse().map((x) => (
              <tr key={x.id}>
                <td><code>{x.id}</code></td>
                <td>{x.dossier.client.nom}</td>
                <td className="num">{x.dossier.montant} XRP → advance {x.dossier.avance.montant}</td>
                <td className="muted">due {x.dossier.echeance.slice(11, 19)}Z</td>
                <td>{fac.statut(x)}</td>
                <td><button onClick={() => setSel(x.id)} disabled={sel === x.id}>{sel === x.id ? "open" : "Open"}</button></td>
              </tr>
            ))}
          </tbody></table>
        )}
        {f && (
          <dl>
            <dt>Dossier</dt>
            <dd><code>{f.id}</code> · {f.dossier.client.nom} owes {f.dossier.montant} XRP on {f.dossier.echeance.replace("T", " ").replace("Z", " UTC")} · piece <code>{f.piece.nom}</code> sha256 {short(f.piece.sha256)}</dd>
            <dt>Fingerprint (SHA-256 of the canonical JSON)</dt>
            <dd><code>{f.dossier.sha256}</code></dd>
            <dt>Invoice token (XLS-33 MPT, 1 unit, issued by the supplier)</dt>
            <dd><code>{f.jeton.issuanceId}</code> · {txLink(f.jeton, "MPTokenIssuanceCreate")} · metadata <code>{f.jeton.metadata}</code></dd>
            <dt>Status</dt><dd className={f.politique && !f.politique.ok && !f.avance ? "ko" : "ok"}>{fac.statut(f)}</dd>
          </dl>
        )}
      </Card>

      <Card n="4" title="The three seats — the AI proposes, the policy decides, two signatures pay" disabled={!f}>
        {f && (<>
          <div className="row">
            <button onClick={() => act("proposer")} disabled={!!busy || !!f.analyse}>{busy === "proposer" ? "Reading the ledger, anchoring…" : "1. AI: gather evidence, write the analysis, anchor its hash"}</button>
            <button onClick={() => act("politique")} disabled={!!busy || !f.analyse || !!f.avance}>{busy === "politique" ? "…" : "2. Risk policy: decide (code, no transaction)"}</button>
          </div>
          {f.analyse && (
            <dl>
              <dt>AI analysis</dt>
              <dd>recommends <b>{f.analyse.recommandation}</b> · memo sha256 <code>{short(f.analyse.sha256)}</code> anchored by <a href={f.analyse.ancrageUrl} target="_blank">AccountSet {short(f.analyse.ancrage)}</a> (ledger {f.analyse.ledger}) · file <code>{f.analyse.fichier}</code>
                <ul>{f.analyse.faits.map((x, i) => <li key={i} className="muted">{x}</li>)}</ul>
                {f.analyse.reserves.length > 0 && <div className="pending">reservations: {f.analyse.reserves.join(" ; ")}</div>}
              </dd>
            </dl>
          )}
          {f.politique && (
            <p className={f.politique.ok ? "ok" : "ko"}>
              Risk policy: {f.politique.ok ? "ACCEPTS and will sign" : "REFUSES — will not sign"}{f.politique.raisons.length > 0 && <> — {f.politique.raisons.join(" ; ")}</>}
              <br /><span className="muted">{f.politique.ok ? "A signer's yes: the ledger itself only counts signatures." : "A signer's refusal, not the ledger's: the same payment with two other signatures goes through (the override below proves it). The XLS-66 version puts the cap in the ledger (facture/devnet_xls65_66.mjs)."}</span>
            </p>
          )}
          <div className="row">
            {(["ia", "politique", "operateur"] as const).map((s) => (
              <label key={s} className="check"><input type="checkbox" checked={!!effectifs[s]} disabled={s === "politique" && !f.politique?.ok} onChange={(e) => setSignataires({ ...signataires, [s]: e.target.checked })} />&nbsp;{s === "ia" ? "AI" : s === "politique" ? `risk policy${f.politique?.ok ? "" : " (refuses)"}` : "operator (human)"}</label>
            ))}
            <button className="primary" onClick={() => act("avancer", { signataires: choisis })} disabled={!!busy || !!f.avance || nSig === 0}>
              {busy === "avancer" ? "Submitting…" : nSig < 2 ? `3. Try to pay with ${nSig} signature (the ledger will refuse)` : `3. Pay the advance ${f.dossier.avance.montant} XRP with ${nSig} signatures${effectifs.politique ? "" : " — OVERRIDING the policy"}`}
            </button>
          </div>
          {f.tentatives?.filter((t) => t.signataires).map((t, i) => <Res key={i} r={t} what={`attempt with ${t.signataires!.join(" + ")}`} />)}
          <Res r={f.authorize} what="pool accepts the token (MPTokenAuthorize, 2/3)" />
          <Res r={f.cession} what="receivable assigned: 1 token supplier → pool" />
          <Res r={f.avance} what={`advance ${f.dossier.avance.montant} XRP pool → supplier, signed ${f.avance?.signataires.join(" + ")}${f.avance?.horsPolitique ? " — the policy had refused; the ledger did not" : ""}`} />
        </>)}
      </Card>

      <Card n="5" title="The client's side — lock the repayment in XRP, or just promise" disabled={!f?.avance}>
        {f?.avance && (<>
          <p className="hint">Only XRP can be escrowed: no euro token on XRPL carries the issuer flag (EURØP, RLUSD measured 08/09 and 27/10/2026). The escrow pays the pool at the due date whatever the client does then; a promise pays only if the client does.</p>
          <div className="row">
            <button onClick={() => act("verrouiller")} disabled={!!busy || !!f.escrow || !!f.encaissement || pastDue}>{busy === "verrouiller" ? "…" : `Client locks ${f.dossier.montant} XRP in an escrow to the pool (FinishAfter = due date)`}</button>
            <button onClick={() => act("rembourser")} disabled={!!busy || !!f.encaissement}>{busy === "rembourser" ? "…" : `Client pays ${f.dossier.montant} XRP now (ordinary Payment)`}</button>
          </div>
          <Res r={f.escrow} what={`EscrowCreate #${f.escrow?.sequence} by the client`} />
          {f.escrow && !f.encaissement && <p className="hint">Due {pastDue ? "passed" : `in ${Math.max(0, Math.ceil((due - now) / 1000))} s`} · the operator may try to cash it before: the ledger answers tecNO_PERMISSION.</p>}
        </>)}
      </Card>

      <Card n="6" title="The due date — cash, settle, or default" disabled={!f?.avance}>
        {f?.avance && (<>
          <div className="row">
            <button onClick={() => act("encaisser")} disabled={!!busy || !f.escrow || !!f.encaissement}>{busy === "encaisser" ? "…" : pastDue ? "Operator cashes the escrow (EscrowFinish)" : "Operator tries EscrowFinish before the date"}</button>
            <button onClick={() => act("solder")} disabled={!!busy || !f.encaissement || !!f.solde}>{busy === "solder" ? "…" : `Settle: ${f.dossier.solde_fournisseur} XRP to the supplier (policy + operator), token back to the issuer`}</button>
            <button onClick={() => act("defaut")} disabled={!!busy || !pastDue || !!f.encaissement || !!f.defaut}>{busy === "defaut" ? "…" : "Nothing received at the date: write the default (AI + operator)"}</button>
            <button onClick={() => act("rachat")} disabled={!!busy || !f.defaut || !!f.rachat}>{busy === "rachat" ? "…" : `Recourse: the supplier buys the receivable back (${f.dossier.avance.montant} XRP)`}</button>
          </div>
          {f.tentatives?.filter((t) => t.encaissementAvantEcheance).map((t, i) => <Res key={i} r={t} what="EscrowFinish before the due date" />)}
          <Res r={f.encaissement} what={f.escrow ? "EscrowFinish at the due date: the pool is repaid" : "Payment by the client: the pool is repaid"} />
          <Res r={f.solde} what={`balance ${f.dossier.solde_fournisseur} XRP to the supplier (fee ${f.dossier.frais.montant} kept by the pool)`} />
          <Res r={f.defaut} what="default written by the pool (AccountSet 2/3, memo)" />
          {f.defaut && <p className="hint">What the pool cannot do on the ledger: take anything from the client. No transaction type lets a creditor pull funds; the recourse is in the contract with the supplier.</p>}
          <Res r={f.rachat} what="the supplier buys the receivable back (Payment)" />
          <Res r={f.eteinte} what="token back to its issuer: the receivable is extinguished" />
        </>)}
      </Card>
      <ErrorBox error={error} />
    </>
  );
}

function Card(props: { n: string; title: string; disabled?: boolean; children: ReactNode }) {
  return (
    <section className={props.disabled ? "card disabled" : "card"}>
      <h2><span className="step">Step {props.n}</span> {props.title}</h2>
      {props.children}
    </section>
  );
}
function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string };
  return <pre className="error wrap">{e.message ?? String(error)}</pre>;
}
