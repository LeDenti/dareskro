/**
 * dareskro pay desk — the agent reads, the code calculates, a human signs on a
 * Ledger device, the XRP Ledger pays.
 *
 * The device scaffolding (connect, address, sign, submit, Card, ActionStatus, ErrorBox)
 * comes from LedgerHQ/device-management-kit-ts-workshop (Apache-2.0) and was modified
 * here; see THIRD_PARTY_NOTICES.md. The pay desk itself is dareskro's.
 *
 * Steps on screen:
 *   1. The statement: computed by code from the evidence (bulletin.json).
 *      A named human validates it. Nothing is locked while it is a PROPOSITION.
 *   2. The employer's Ledger: connect, get the address, fund it (testnet).
 *   3. The employee and the pay date.
 *   4. Lock on the device: EscrowCreate, FinishAfter only, hash in the memo.
 *   5. Proof: early finish fails, the employer's cancel fails, a third party
 *      releases at the date.
 */
import {
  DeviceActionStatus,
  DeviceModelId,
  type DeviceActionState,
  type DeviceManagementKit,
  type DeviceSessionId,
  type DeviceSessionState,
} from "@ledgerhq/device-management-kit";
import type {
  GetAddressDAError,
  GetAddressDAIntermediateValue,
  GetAddressDAOutput,
  SignTransactionDAError,
  SignTransactionDAIntermediateValue,
  SignTransactionDAOutput,
  SignerXrp,
} from "@ledgerhq/device-signer-kit-xrp";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EscrowCancel, EscrowCreate, Wallet } from "xrpl";
import * as ledger from "./ledger";
import * as oracle from "./oracle";
import { SpeculosScreen } from "./SpeculosScreen";
import { useDeviceAction } from "./useDeviceAction";
import * as xrpl from "./xrpl";
import "./App.css";

type Statement = {
  statement_id: string;
  employee: { label: string; badge: string };
  period: string;
  evidence: {
    schedule: { date: string; slot: string; type: string; week_hours_before: string };
    badge: { arrivee: string; depart: string; heures_badgees: string; heures_retenues: string; regle: string };
    anomalies: string[];
  };
  lines: { item: string; detail: string; amount: string }[];
  total: string;
  currency: string;
  rest_hours_outside_escrow: string;
  rest_note: string;
  sources: string[];
  rules_source?: {
    how: string;
    provider?: string;
    paid_rlusd?: string;
    channel_cap_rlusd?: string;
    redemption_tx?: string;
    redemption_explorer?: string;
    receipt_url?: string | null;
    purchased_at?: string;
  };
  computed_by: string;
  computed_at: string;
  sha256: string;
  status: string;
};

type Validation = { by: string; at: string };
type Attempt = { label: string; result: string; hash?: string; expected: string };

/** How the employer signs. "software" is a faucet wallet signed by xrpl.js: for rehearsals only, never for the bounty. */
type Mode = ledger.Transport | "software";

const transports: { id: Mode; label: string }[] = [
  { id: "usb", label: "Ledger USB" },
  { id: "ble", label: "Ledger Bluetooth" },
  { id: "speculos", label: "Speculos (emulator)" },
  { id: "software", label: "Test wallet (no device)" },
];

const speculosModels: { id: DeviceModelId; label: string }[] = [
  { id: DeviceModelId.STAX, label: "Stax" },
  { id: DeviceModelId.FLEX, label: "Flex" },
  { id: DeviceModelId.APEX, label: "Nano Gen5" },
  { id: DeviceModelId.NANO_X, label: "Nano X" },
  { id: DeviceModelId.NANO_SP, label: "Nano S Plus" },
];

export default function App() {
  const [transport, setTransport] = useState<Mode>("usb");
  const [speculosUrl, setSpeculosUrl] = useState("http://127.0.0.1:5000");

  return (
    <>
      <header className="header">
        <div>
          <h1>dareskro — pay desk</h1>
          <p>
            The agent reads the evidence. The code computes the amount. A human
            signs on a Ledger device. The XRP Ledger pays at the date. Testnet.
          </p>
        </div>
      </header>
      <div className={transport === "speculos" ? "layout with-screen" : "layout"}>
        <Desk
          transport={transport}
          setTransport={setTransport}
          speculosUrl={speculosUrl}
          setSpeculosUrl={setSpeculosUrl}
        />
        {transport === "speculos" && (
          <aside className="screen">
            <h2>Speculos screen</h2>
            <SpeculosScreen url={speculosUrl} />
          </aside>
        )}
      </div>
    </>
  );
}

function Desk(props: {
  transport: Mode;
  setTransport: (t: Mode) => void;
  speculosUrl: string;
  setSpeculosUrl: (url: string) => void;
}) {
  const { transport } = props;

  // ---- 1. the statement
  const [statement, setStatement] = useState<Statement>();
  const [statementError, setStatementError] = useState<unknown>();
  const [validatorName, setValidatorName] = useState("");
  const [validation, setValidation] = useState<Validation>();
  // the pay is in euros; the escrow is in XRP at the rate of the moment
  const [rate, setRate] = useState<xrpl.Rate>();
  const [rateError, setRateError] = useState<unknown>();
  const amountXrp = statement && rate ? xrpl.eurToXrp(statement.total, rate.eurPerXrp) : undefined;
  const sym = statement?.currency === "EUR" ? "€" : "$";
  // how the employee wants to be paid: the XRP the ledger releases, or dollars (RLUSD) through Mastercard AP4M
  const [payoutMode, setPayoutMode] = useState<"crypto" | "usd">("usd");

  const refreshRate = async () => {
    setRateError(undefined);
    try {
      setRate(await xrpl.xrpEurRate(statement?.currency ?? "USD"));
    } catch (e) {
      setRateError(e);
    }
  };

  useEffect(() => {
    refreshRate();
  }, []);

  // ---- 2. the employer's Ledger
  const [speculosModel, setSpeculosModel] = useState(DeviceModelId.STAX);
  const dmkRef = useRef<DeviceManagementKit | undefined>(undefined);
  // Either a Ledger session (id + signer) or, for rehearsals, a software wallet.
  const [session, setSession] = useState<{ id?: DeviceSessionId; deviceName: string; signer?: SignerXrp; wallet?: Wallet }>();
  const [sessionState, setSessionState] = useState<DeviceSessionState>();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<unknown>();
  const [checkOnDevice, setCheckOnDevice] = useState(false);
  const addressAction = useDeviceAction<GetAddressDAOutput, GetAddressDAError, GetAddressDAIntermediateValue>();
  const [employer, setEmployer] = useState<{ address: string; publicKey: string }>();
  const [balance, setBalance] = useState<number | null>();
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetError, setFaucetError] = useState<unknown>();

  // ---- 3. the employee and the date
  const [employee, setEmployee] = useState("");
  const [employeeWallet, setEmployeeWallet] = useState<Wallet>();
  const [employeeBusy, setEmployeeBusy] = useState(false);
  const [employeeError, setEmployeeError] = useState<unknown>();
  const [payDelaySec, setPayDelaySec] = useState("90");

  // ---- 4. lock on the device
  const [tx, setTx] = useState<EscrowCreate>();
  const [prepareError, setPrepareError] = useState<unknown>();
  const signAction = useDeviceAction<SignTransactionDAOutput, SignTransactionDAError, SignTransactionDAIntermediateValue>();
  const [signedTxHex, setSignedTxHex] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>();
  const [escrow, setEscrow] = useState<{ owner: string; sequence: number; hash: string; result: string; finishAfter: Date }>();

  // ---- 5. proof
  const cancelAction = useDeviceAction<SignTransactionDAOutput, SignTransactionDAError, SignTransactionDAIntermediateValue>();
  const [thirdParty, setThirdParty] = useState<Wallet>();
  const [proofBusy, setProofBusy] = useState<string>();
  const [proofError, setProofError] = useState<unknown>();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [employeeBalance, setEmployeeBalance] = useState<number | null>();
  const [now, setNow] = useState(Date.now());

  // ---- the oracle: the named third party that finishes at the date (optional)
  const [oracleId, setOracleId] = useState<oracle.OracleIdentity>();
  const [watched, setWatched] = useState<oracle.WatchedEscrow>();
  const [oracleError, setOracleError] = useState<unknown>();

  useEffect(() => {
    oracle.identity().then(setOracleId);
  }, []);

  useEffect(() => {
    if (!escrow || !oracleId) return;
    let stop = false;
    const poll = async () => {
      const mine = (await oracle.escrows()).find(
        (e) => e.owner === escrow.owner && e.sequence === escrow.sequence,
      );
      if (!stop && mine) setWatched(mine);
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [escrow, oracleId]);

  useEffect(() => {
    if (watched?.status === "finished" && employeeBalance === undefined) {
      xrpl.getBalance(employee).then(setEmployeeBalance);
      if (escrow) refreshBalance(escrow.owner);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched?.status]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadStatement();
  }, []);

  useEffect(() => () => dmkRef.current?.close(), []);

  useEffect(() => {
    const dmk = dmkRef.current;
    if (!dmk || !session?.id) return;
    const sub = dmk
      .getDeviceSessionState({ sessionId: session.id })
      .subscribe({ next: setSessionState, error: () => setSessionState(undefined) });
    return () => sub.unsubscribe();
  }, [session]);

  const loadStatement = async () => {
    setStatementError(undefined);
    setValidation(undefined);
    try {
      const res = await fetch(`/bulletin.json?t=${Date.now()}`);
      if (!res.ok) throw new Error(`bulletin.json: ${res.status}`);
      setStatement(await res.json());
    } catch (e) {
      setStatementError(e);
    }
  };

  const validate = () => {
    if (!validatorName.trim()) return;
    setValidation({ by: validatorName.trim(), at: new Date().toISOString() });
  };

  const resetLock = () => {
    setTx(undefined);
    setPrepareError(undefined);
    signAction.reset();
    setSignedTxHex(undefined);
    setSubmitError(undefined);
    setEscrow(undefined);
    cancelAction.reset();
    setAttempts([]);
    setEmployeeBalance(undefined);
    setWatched(undefined);
    setOracleError(undefined);
  };

  const connect = async () => {
    setConnecting(true);
    setConnectError(undefined);
    setSession(undefined);
    setSessionState(undefined);
    addressAction.reset();
    setEmployer(undefined);
    setBalance(undefined);
    resetLock();
    try {
      dmkRef.current?.close();
      dmkRef.current = undefined;
      if (transport === "software") {
        const w = await xrpl.newFundedWallet();
        await xrpl.fundUntil(w.classicAddress, neededXrp);
        setSession({ deviceName: "Software test wallet (xrpl.js) — rehearsal only", wallet: w });
        return;
      }
      const dmk = ledger.createDmk({ url: props.speculosUrl, model: speculosModel });
      dmkRef.current = dmk;
      const id = await ledger.connect(dmk, transport);
      const signer = ledger.createSigner(dmk, id);
      setSession({ id, deviceName: dmk.getConnectedDevice({ sessionId: id }).name, signer });
    } catch (e) {
      setConnectError(e);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (session?.id) await dmkRef.current?.disconnect({ sessionId: session.id });
    setSession(undefined);
    setSessionState(undefined);
    setEmployer(undefined);
    setBalance(undefined);
    resetLock();
  };

  const getAddress = async () => {
    if (!session) return;
    setEmployer(undefined);
    setBalance(undefined);
    resetLock();
    if (session.wallet) {
      setEmployer({ address: session.wallet.classicAddress, publicKey: session.wallet.publicKey });
      refreshBalance(session.wallet.classicAddress);
      return;
    }
    if (!session.signer) return;
    const signer = session.signer;
    const out = await addressAction.run(() =>
      ledger.getAddress(signer, ledger.DERIVATION_PATH, checkOnDevice),
    );
    if (out) {
      setEmployer({ address: out.address, publicKey: out.publicKey });
      refreshBalance(out.address);
    }
  };

  const refreshBalance = async (address: string) => {
    setBalance(undefined);
    setBalance(await xrpl.getBalance(address));
  };

  /** Escrow amount in XRP plus the reserve and fees: what the employer must hold. */
  const neededXrp = Math.ceil(Number(amountXrp ?? 0)) + 5;

  const fund = async () => {
    if (!employer) return;
    setFaucetBusy(true);
    setFaucetError(undefined);
    try {
      setBalance(undefined);
      setBalance(await xrpl.fundUntil(employer.address, neededXrp));
    } catch (e) {
      setFaucetError(e);
    } finally {
      setFaucetBusy(false);
    }
  };

  const createEmployee = async () => {
    setEmployeeBusy(true);
    setEmployeeError(undefined);
    try {
      const w = await xrpl.newFundedWallet();
      setEmployeeWallet(w);
      setEmployee(w.classicAddress);
    } catch (e) {
      setEmployeeError(e);
    } finally {
      setEmployeeBusy(false);
    }
  };

  const prepare = async () => {
    if (!employer || !statement || !validation) return;
    resetLock();
    try {
      // the rate of the moment of signing, not of the page load
      const fresh = await xrpl.xrpEurRate(statement.currency);
      setRate(fresh);
      const xrp = xrpl.eurToXrp(statement.total, fresh.eurPerXrp);
      const finishAfter = new Date(Date.now() + Number(payDelaySec) * 1000);
      setTx(
        await xrpl.prepareEscrowCreate({
          account: employer.address,
          publicKey: employer.publicKey,
          destination: employee,
          amountXrp: xrp,
          eur: statement.total,
          rate: fresh,
          finishAfter,
          statementSha256: statement.sha256,
          statementId: statement.statement_id,
          oracle: oracleId?.address,
          compact: transport === "usb" || transport === "ble",
        }),
      );
    } catch (e) {
      setPrepareError(e);
    }
  };

  const sign = async () => {
    if (!session || !tx) return;
    setSignedTxHex(undefined);
    if (session.wallet) {
      setSignedTxHex(session.wallet.sign(tx).tx_blob);
      return;
    }
    if (!session.signer) return;
    const signer = session.signer;
    const signature = await signAction.run(() =>
      ledger.signOnDevice(signer, ledger.DERIVATION_PATH, xrpl.encodeUnsigned(tx)),
    );
    if (signature) setSignedTxHex(xrpl.encodeSigned(tx, signature));
  };

  const submit = async () => {
    if (!signedTxHex || !tx || !employer) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const out = await xrpl.submit(signedTxHex);
      setEscrow({
        owner: employer.address,
        sequence: tx.Sequence!,
        hash: out.hash,
        result: out.result,
        finishAfter: xrpl.fromRippleTime(tx.FinishAfter!),
      });
      refreshBalance(employer.address);
      // Hand the escrow to the oracle. If this fails, nothing is lost: anyone can finish it.
      if (out.result === "tesSUCCESS" && oracleId && statement) {
        try {
          await oracle.watch({
            owner: employer.address,
            sequence: tx.Sequence!,
            finishAfter: tx.FinishAfter!,
            destination: employee,
            amountXrp: amountXrp ?? statement.total,
            payout: payoutMode,
            amount: statement.total,
            currency: statement.currency,
            statementSha256: statement.sha256,
            createHash: out.hash,
          });
        } catch (e) {
          setOracleError(e);
        }
      }
    } catch (e) {
      setSubmitError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const ensureThirdParty = async (): Promise<Wallet> => {
    if (thirdParty) return thirdParty;
    setProofBusy("Creating a third-party account (faucet)…");
    const w = await xrpl.newFundedWallet();
    setThirdParty(w);
    return w;
  };

  const tryFinish = async (label: string, expected: string) => {
    if (!escrow) return;
    setProofError(undefined);
    try {
      const third = await ensureThirdParty();
      setProofBusy(`${label}…`);
      const out = await xrpl.finishAsThirdParty({
        owner: escrow.owner,
        offerSequence: escrow.sequence,
        third,
      });
      setAttempts((a) => [...a, { label, result: out.result, hash: out.hash, expected }]);
      if (out.result === "tesSUCCESS") {
        setEmployeeBalance(await xrpl.getBalance(employee));
        refreshBalance(escrow.owner);
      }
    } catch (e) {
      setProofError(e);
    } finally {
      setProofBusy(undefined);
    }
  };

  const tryCancel = async () => {
    if (!escrow || !session || !employer) return;
    setProofError(undefined);
    const label = "Employer cancels (signed on device)";
    try {
      setProofBusy("Preparing EscrowCancel…");
      const cancelTx: EscrowCancel = await xrpl.prepareEscrowCancel({
        account: employer.address,
        publicKey: employer.publicKey,
        offerSequence: escrow.sequence,
      });
      setProofBusy(undefined);
      let signedHex: string;
      if (session.wallet) {
        signedHex = session.wallet.sign(cancelTx).tx_blob;
      } else {
        if (!session.signer) return;
        const signer = session.signer;
        const signature = await cancelAction.run(() =>
          ledger.signOnDevice(signer, ledger.DERIVATION_PATH, xrpl.encodeUnsigned(cancelTx)),
        );
        if (!signature) return;
        signedHex = xrpl.encodeSigned(cancelTx, signature);
      }
      setProofBusy("Submitting EscrowCancel…");
      const out = await xrpl.submit(signedHex);
      setAttempts((a) => [...a, { label, result: out.result, hash: out.hash, expected: "tecNO_PERMISSION" }]);
    } catch (e) {
      setProofError(e);
    } finally {
      setProofBusy(undefined);
    }
  };

  const secondsToDate = escrow ? Math.ceil((escrow.finishAfter.getTime() - now) / 1000) : undefined;

  return (
    <main className="steps">
      <Card n="1" title="The statement — computed by code, validated by a human">
        <p className="hint">
          Evidence: the schedule qualifies the hours, the badge proves presence.
          The amount comes from <code>officine.garde</code>, replayable to the cent.
          Only the SHA-256 of this statement goes on the ledger, never the statement.
        </p>
        <div className="row">
          <button onClick={loadStatement}>Reload bulletin.json</button>
        </div>
        <ErrorBox error={statementError} />
        {statement && (
          <>
            <dl>
              <dt>Employee</dt>
              <dd>{statement.employee.label}</dd>
              <dt>Schedule</dt>
              <dd>
                {statement.evidence.schedule.date} · {statement.evidence.schedule.slot} ·{" "}
                {statement.evidence.schedule.type} · {statement.evidence.schedule.week_hours_before} h already worked this week
              </dd>
              <dt>Badge</dt>
              <dd>
                {statement.evidence.badge.heures_badgees} h badged → {statement.evidence.badge.heures_retenues} h retained ({statement.evidence.badge.regle})
              </dd>
              {statement.evidence.anomalies.length > 0 && (
                <>
                  <dt>To decide</dt>
                  <dd>{statement.evidence.anomalies.join(" · ")}</dd>
                </>
              )}
            </dl>
            <table className="lines">
              <tbody>
                {statement.lines.map((l) => (
                  <tr key={l.item}>
                    <td>{l.item}</td>
                    <td className="muted">{l.detail}</td>
                    <td className="num">{l.amount} {sym}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>TOTAL TO LOCK</td>
                  <td className="muted">+ {statement.rest_hours_outside_escrow} h of rest, outside the escrow: {statement.rest_note}</td>
                  <td className="num">{statement.total} {sym}</td>
                </tr>
                <tr>
                  <td>in XRP, at the rate of the moment</td>
                  <td className="muted">
                    {rate
                      ? `${rate.eurPerXrp} ${rate.currency}/XRP · ${rate.source} · ${rate.at.slice(11, 19)} UTC — refreshed again when you prepare the escrow`
                      : rateError
                        ? `no rate: ${String((rateError as { message?: string }).message ?? rateError)}`
                        : "fetching the rate…"}{" "}
                    <button onClick={refreshRate}>Refresh rate</button>
                  </td>
                  <td className="num">{amountXrp ? `${amountXrp} XRP` : "…"}</td>
                </tr>
              </tbody>
            </table>
            <dl>
              <dt>Sources</dt>
              <dd>{statement.sources.join(" — ")}</dd>
              <dt>Rules</dt>
              <dd>
                {statement.rules_source?.redemption_tx ? (
                  <>
                    <span className="ok">bought by the agent on Mastercard AP4M</span>: {statement.rules_source.paid_rlusd} RLUSD on XRPL EVM
                    testnet, inside a {statement.rules_source.channel_cap_rlusd} RLUSD cap approved by the employer ·{" "}
                    <a href={statement.rules_source.redemption_explorer} target="_blank">
                      VoucherRedeemed
                    </a>
                    {statement.rules_source.receipt_url && (
                      <>
                        {" · "}
                        <a href={statement.rules_source.receipt_url} target="_blank">
                          receipt
                        </a>
                      </>
                    )}
                  </>
                ) : (
                  <span className="muted">{statement.rules_source?.how ?? "local"}</span>
                )}
              </dd>
              <dt>SHA-256</dt>
              <dd>
                <code>{statement.sha256}</code>
              </dd>
              <dt>Status</dt>
              <dd>
                {validation ? (
                  <span className="ok">VALIDATED by {validation.by} at {validation.at.slice(11, 19)} UTC</span>
                ) : (
                  <span className="ko">PROPOSITION — nobody has validated it yet</span>
                )}
              </dd>
            </dl>
            {!validation && (
              <div className="row">
                <label className="grow">
                  Validator (name of the person who answers for this amount)
                  <input value={validatorName} onChange={(e) => setValidatorName(e.target.value)} placeholder="C. Meunier, HR" />
                </label>
                <button className="primary" onClick={validate} disabled={!validatorName.trim()}>
                  Validate
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      <Card n="2" title="The employer's Ledger" disabled={!validation}>
        <div className="segmented">
          {transports.map((t) => (
            <button key={t.id} className={transport === t.id ? "active" : ""} onClick={() => props.setTransport(t.id)} disabled={!!session}>
              {t.label}
            </button>
          ))}
        </div>
        {transport === "speculos" && (
          <div className="row">
            <label>
              URL
              <input value={props.speculosUrl} onChange={(e) => props.setSpeculosUrl(e.target.value)} disabled={!!session} />
            </label>
            <label>
              Model
              <select value={speculosModel} onChange={(e) => setSpeculosModel(e.target.value as DeviceModelId)} disabled={!!session}>
                {speculosModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="row">
          {session ? (
            <button onClick={disconnect}>Disconnect</button>
          ) : (
            <button className="primary" onClick={connect} disabled={connecting || !validation}>
              {connecting ? "Connecting…" : "Connect the Ledger"}
            </button>
          )}
          <button onClick={getAddress} disabled={!session}>
            Get the employer's address
          </button>
          <label className="check">
            <input type="checkbox" checked={checkOnDevice} onChange={(e) => setCheckOnDevice(e.target.checked)} />
            Verify on device
          </label>
        </div>
        <ErrorBox error={connectError} />
        {session && (
          <dl>
            <dt>Device</dt>
            <dd>
              {session.deviceName} · {sessionState?.deviceStatus ?? "…"}
              {sessionState && "currentApp" in sessionState && ` · app ${sessionState.currentApp.name} ${sessionState.currentApp.version}`}
            </dd>
          </dl>
        )}
        <ActionStatus state={addressAction.state} error={addressAction.error} />
        {employer && (
          <dl>
            <dt>Employer</dt>
            <dd>
              <a href={xrpl.explorerAccountUrl(employer.address)} target="_blank">
                {employer.address}
              </a>
            </dd>
            <dt>Balance</dt>
            <dd>
              {balance === undefined ? "…" : balance === null ? "Not funded yet" : `${balance} XRP (testnet)`}{" "}
              <button onClick={fund} disabled={faucetBusy}>
                {faucetBusy ? "Funding (about 100 XRP per faucet call)…" : `Get test XRP (needs ${neededXrp})`}
              </button>
              {balance !== undefined && balance !== null && balance < neededXrp && (
                <span className="ko"> · too low to lock {amountXrp} XRP</span>
              )}
            </dd>
          </dl>
        )}
        <ErrorBox error={faucetError} />
      </Card>

      <Card n="3" title="The employee and the pay date" disabled={!employer}>
        <div className="row">
          <label className="grow">
            Employee's XRPL address (destination)
            <input value={employee} onChange={(e) => setEmployee(e.target.value)} placeholder="r…" />
          </label>
          <button onClick={createEmployee} disabled={employeeBusy}>
            {employeeBusy ? "Creating…" : "Create a test employee"}
          </button>
          <label>
            Payable in (seconds)
            <input value={payDelaySec} onChange={(e) => setPayDelaySec(e.target.value)} size={6} />
          </label>
        </div>
        <p className="hint">
          In production the pay date is the 5th of the month. Here, a short delay, so the release can be shown live.
          {employeeWallet && " The test employee is a fresh faucet account: nobody holds its key but this page."}
        </p>
        <div className="row">
          <label className="check">
            <input type="radio" name="payout" checked={payoutMode === "crypto"} onChange={() => setPayoutMode("crypto")} />
            &nbsp;Paid in crypto: the employee keeps the XRP the ledger releases
          </label>
          <label className="check">
            <input type="radio" name="payout" checked={payoutMode === "usd"} onChange={() => setPayoutMode("usd")} />
            &nbsp;Paid in dollars: RLUSD through Mastercard Agent Pay for Machines, once the ledger has released
          </label>
        </div>
        <ErrorBox error={employeeError} />
      </Card>

      <Card n="4" title="Lock on the device — EscrowCreate, FinishAfter only" disabled={!employer || !employee}>
        <p className="hint">
          What the device shows: the amount, the destination, the pay date and the memo with the statement hash.
          No Condition, no CancelAfter: once signed, the employer has no transaction to take the money back.
        </p>
        <p className="hint">
          {oracleId ? (
            <>
              Oracle cited in the escrow: <a href={oracleId.explorer} target="_blank">{oracleId.address}</a> ({oracleId.name},{" "}
              <a href={oracleId.birthExplorer} target="_blank">birth certificate</a>). It will finish the escrow at the date.
              Citing it gives it no power: it pays the fee, never holds the funds, and anyone else can finish after the date.
            </>
          ) : (
            <>
              No oracle running (<code>cd oracle && node oracle.mjs watch</code>): the escrow is not cited to one, and the release below is manual.
            </>
          )}
        </p>
        <div className="row">
          <button onClick={prepare} disabled={!employer || !employee || !validation}>
            1. Prepare
          </button>
          <button className="primary" onClick={sign} disabled={!tx}>
            2. Sign on the Ledger
          </button>
          <button onClick={submit} disabled={!signedTxHex || submitting}>
            {submitting ? "Submitting…" : "3. Submit to XRPL"}
          </button>
        </div>
        <ErrorBox error={prepareError} />
        {tx && (
          <details>
            <summary>
              Unsigned EscrowCreate · {xrpl.dropsToXrpString(tx.Amount as string)} XRP = {statement?.total} {sym} at {rate?.eurPerXrp} {rate?.currency}/XRP · payable{" "}
              {xrpl.fromRippleTime(tx.FinishAfter!).toLocaleTimeString()}
            </summary>
            <pre>{JSON.stringify(tx, null, 2)}</pre>
          </details>
        )}
        <ActionStatus state={signAction.state} error={signAction.error} />
        {signedTxHex && (
          <details>
            <summary>Signed by the device (hex)</summary>
            <pre className="wrap">{signedTxHex}</pre>
          </details>
        )}
        <ErrorBox error={submitError} />
        {escrow && (
          <p className={escrow.result === "tesSUCCESS" ? "ok" : "ko"}>
            {escrow.result} · escrow #{escrow.sequence} ·{" "}
            <a href={xrpl.explorerTxUrl(escrow.hash)} target="_blank">
              see it on the explorer
            </a>
          </p>
        )}
      </Card>

      <Card n="5" title="Proof — what must fail, and the release" disabled={!escrow}>
        {escrow && (
          <p className="hint">
            Pay date {escrow.finishAfter.toLocaleTimeString()} ·{" "}
            {secondsToDate !== undefined && secondsToDate > 0 ? `${secondsToDate} s to go` : "the date has passed"}.
            The third party is a fresh account: it pays the fee, the funds go to the employee.
          </p>
        )}
        {escrow && oracleId && (
          <p className={watched?.status === "finished" ? "ok" : "pending"}>
            Oracle {oracleId.address.slice(0, 8)}…:{" "}
            {!watched && "not watching this escrow yet"}
            {watched?.status === "waiting" &&
              `watching escrow #${watched.sequence}, will finish once the ledger is past ${escrow.finishAfter.toLocaleTimeString()}` +
                (watched.lastResult ? ` (last try ${watched.lastResult})` : "")}
            {watched?.status === "finished" && (
              <>
                finished it at {watched.finishedAt?.slice(11, 19)} UTC ·{" "}
                <a href={xrpl.explorerTxUrl(watched.finishHash!)} target="_blank">
                  EscrowFinish signed by the oracle
                </a>
              </>
            )}
            {watched?.status === "gone" && `nothing left to do: ${watched.note}`}
            {watched?.status === "failed" && `gave up after ${watched.attempts} tries (${watched.lastResult}); anyone can still finish it`}
          </p>
        )}
        {watched?.status === "finished" && watched.payout === "usd" && (
          <p className={watched.payoutResult && !("error" in watched.payoutResult) ? "ok" : "pending"}>
            Dollars via Mastercard:{" "}
            {!watched.payoutResult && "the oracle is settling RLUSD to the employee's payout wallet through AP4M…"}
            {watched.payoutResult && "error" in watched.payoutResult && `failed: ${watched.payoutResult.error}`}
            {watched.payoutResult && !("error" in watched.payoutResult) && (
              <>
                {watched.payoutResult.amount_rlusd} RLUSD paid (1/{watched.payoutResult.scale} of the pay, sandbox budget) ·{" "}
                <a href={watched.payoutResult.redemption_explorer} target="_blank">VoucherRedeemed</a>
                {watched.payoutResult.receipt_url && (
                  <>
                    {" · "}
                    <a href={watched.payoutResult.receipt_url} target="_blank">Mastercard receipt</a>
                  </>
                )}
              </>
            )}
          </p>
        )}
        {watched?.status === "finished" && watched.payout === "crypto" && (
          <p className="ok">Paid in crypto: the employee keeps the XRP the ledger released.</p>
        )}
        <ErrorBox error={oracleError} />
        <div className="row">
          <button onClick={() => tryFinish("Finish before the date (third party)", "tecNO_PERMISSION")} disabled={!escrow || !!proofBusy}>
            Try to pay early
          </button>
          <button onClick={tryCancel} disabled={!escrow || !!proofBusy || !session}>
            Employer tries to cancel
          </button>
          <button className="primary" onClick={() => tryFinish("Release at the date (third party)", "tesSUCCESS")} disabled={!escrow || !!proofBusy}>
            Release at the date
          </button>
        </div>
        {proofBusy && <p className="pending">{proofBusy}</p>}
        <ActionStatus state={cancelAction.state} error={cancelAction.error} />
        <ErrorBox error={proofError} />
        {attempts.length > 0 && (
          <table className="lines">
            <tbody>
              {attempts.map((a, i) => {
                // tecNO_TARGET on a cancel means the escrow is already paid: nothing left to cancel.
                const paidAlready = a.label.startsWith("Employer cancels") && a.result === "tecNO_TARGET";
                const fine = a.result === a.expected || paidAlready;
                return (
                <tr key={i}>
                  <td>{a.label}</td>
                  <td className={fine ? "ok" : "ko"}>
                    {a.result}{" "}
                    {paidAlready ? "(already paid: nothing left to cancel)" : fine ? "(as expected)" : `(expected ${a.expected})`}
                  </td>
                  <td>
                    {a.hash && (
                      <a href={xrpl.explorerTxUrl(a.hash)} target="_blank">
                        explorer
                      </a>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {employeeBalance !== undefined && (
          <p className="ok">
            Employee balance: {employeeBalance === null ? "?" : `${employeeBalance} XRP`} ·{" "}
            <a href={xrpl.explorerAccountUrl(employee)} target="_blank">
              account
            </a>
          </p>
        )}
      </Card>
    </main>
  );
}

function Card(props: { n: string; title: string; disabled?: boolean; children: ReactNode }) {
  return (
    <section className={props.disabled ? "card disabled" : "card"}>
      <h2>
        <span className="step">Step {props.n}</span> {props.title}
      </h2>
      {props.children}
    </section>
  );
}

const userInteractionText: Record<string, string> = {
  none: "Talking to the device…",
  "unlock-device": "Unlock the device",
  "confirm-open-app": "Approve opening the XRP app on the device",
  "verify-address": "Check the address on the device, then approve",
  "sign-transaction": "Review the escrow on the device, then sign",
};

function ActionStatus(props: {
  state?: DeviceActionState<unknown, unknown, { requiredUserInteraction: string }>;
  error: unknown;
}) {
  const { state, error } = props;
  if (error) return <ErrorBox error={error} />;
  if (!state) return null;
  switch (state.status) {
    case DeviceActionStatus.NotStarted:
      return <p className="pending">Starting…</p>;
    case DeviceActionStatus.Pending: {
      const i = state.intermediateValue.requiredUserInteraction;
      return <p className="pending">{userInteractionText[i] ?? i}</p>;
    }
    case DeviceActionStatus.Stopped:
      return <p className="ko">Cancelled on the device</p>;
    case DeviceActionStatus.Completed:
      return <p className="ok">Signed on the device</p>;
    default:
      return null;
  }
}

function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <pre className="error wrap">{formatError(error)}</pre>;
}

/** DMK errors are objects with a _tag, a message and sometimes an errorCode. */
function formatError(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const e = error as { _tag?: string; message?: string; errorCode?: string; originalError?: unknown };
  const parts = [e._tag, e.message, e.errorCode && `(status ${e.errorCode})`].filter(Boolean);
  if (e.originalError instanceof Error) parts.push(`← ${e.originalError.message}`);
  return parts.length ? parts.join(" ") : JSON.stringify(error);
}
