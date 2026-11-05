//! Sandbox tests: a real NEAR node (near-sandbox), the compiled wasm, real
//! accounts, real clock. Run: `cargo test` (needs cargo-near on the PATH).
//! The last five are the claimable balance: what a transfer the chain refused becomes.
use near_sdk::NearToken;
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ONE: NearToken = NearToken::from_near(1);
/// Enough for a payout and its callback; the full 300 TGas would be charged up front and refunded blocks later,
/// which blurs every balance read right after a call.
const GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(30);

/// The contract, its administrator (the account that sets the fee) and three users.
async fn setup_with_admin() -> anyhow::Result<(Worker<Sandbox>, Contract, Account, Account, Account, Account)> {
    let wasm = near_workspaces::compile_project("./").await?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let admin = worker.dev_create_account().await?;
    contract.call("new").args_json(json!({"admin": admin.id()})).transact().await?.into_result()?;
    let employer = worker.dev_create_account().await?;
    let employee = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;
    Ok((worker, contract, admin, employer, employee, stranger))
}

async fn setup() -> anyhow::Result<(Worker<Sandbox>, Contract, Account, Account, Account)> {
    let (worker, contract, _admin, a, b, c) = setup_with_admin().await?;
    Ok((worker, contract, a, b, c))
}

async fn now_ns(contract: &Contract) -> anyhow::Result<u64> {
    let v: Value = contract.view("now").await?.json()?;
    Ok(v.as_str().unwrap().parse()?)
}

/// Advance the sandbox until the contract's clock passes `t`.
async fn wait_until(worker: &Worker<Sandbox>, contract: &Contract, t: u64) -> anyhow::Result<()> {
    for _ in 0..40 {
        if now_ns(contract).await? >= t {
            return Ok(());
        }
        worker.fast_forward(20).await?;
    }
    anyhow::bail!("clock did not reach the date")
}

fn err_contains(r: near_workspaces::result::ExecutionFinalResult, needle: &str) {
    let e = r.into_result().expect_err("should have failed");
    let s = format!("{e:?}");
    assert!(s.contains(needle), "expected `{needle}` in {s}");
}

#[tokio::test]
async fn payroll_one_possible_outcome() -> anyhow::Result<()> {
    let (worker, contract, employer, employee, stranger) = setup().await?;
    let pay_date = now_ns(&contract).await? + 15_000_000_000; // +15 s
    let id: Value = employer
        .call(contract.id(), "create")
        .args_json(json!({"destination": employee.id(), "finish_after": pay_date.to_string(),
                          "memos": ["sha256:statement", "466.57 EUR", "dareskro/oracle"]}))
        .deposit(ONE)
        .transact()
        .await?
        .json()?;

    // a stranger before the date: refused by the clock
    err_contains(stranger.call(contract.id(), "finish").args_json(json!({"id": id})).gas(GAS).transact().await?, "too early");
    // the employer cannot take it back: there is no cancel date
    err_contains(employer.call(contract.id(), "cancel").args_json(json!({"id": id})).gas(GAS).transact().await?, "nobody can cancel");

    wait_until(&worker, &contract, pay_date).await?;
    let before = employee.view_account().await?.balance;
    // after the date, anyone finishes it: the money goes where it was written
    stranger.call(contract.id(), "finish").args_json(json!({"id": id})).gas(GAS).transact().await?.into_result()?;
    let after = employee.view_account().await?.balance;
    let got = after.saturating_sub(before);
    assert!(got > NearToken::from_millinear(990) && got <= ONE, "employee got {got}");
    let e: Value = contract.view("get").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(e["status"], "Finished");
    assert_eq!(e["closed_by"], json!(stranger.id()));
    // twice: no
    err_contains(stranger.call(contract.id(), "finish").args_json(json!({"id": id})).gas(GAS).transact().await?, "already closed");
    Ok(())
}

#[tokio::test]
async fn delivery_released_by_the_secret_refunded_at_the_deadline() -> anyhow::Result<()> {
    let (worker, contract, buyer, seller, stranger) = setup().await?;
    let key = b"K-the-box-key";
    let condition = hex::encode(Sha256::digest(key));
    let deadline = now_ns(&contract).await? + 20_000_000_000;
    let id: Value = buyer
        .call(contract.id(), "create")
        .args_json(json!({"destination": seller.id(), "cancel_after": deadline.to_string(), "condition": condition}))
        .deposit(ONE)
        .transact()
        .await?
        .json()?;
    err_contains(seller.call(contract.id(), "finish").args_json(json!({"id": id})).gas(GAS).transact().await?, "bring the fulfillment");
    err_contains(seller.call(contract.id(), "finish").args_json(json!({"id": id, "fulfillment": hex::encode(b"wrong")})).gas(GAS).transact().await?, "does not match");
    err_contains(buyer.call(contract.id(), "cancel").args_json(json!({"id": id})).gas(GAS).transact().await?, "too early");
    let r = seller.call(contract.id(), "finish").args_json(json!({"id": id, "fulfillment": hex::encode(key)})).gas(GAS).transact().await?;
    let logs = r.logs().join("\n");
    r.into_result()?;
    assert!(logs.contains(&hex::encode(key)), "the secret is public in the logs: {logs}");

    // a second one nobody pays: refunded at the deadline, by anyone
    let id2: Value = buyer
        .call(contract.id(), "create")
        .args_json(json!({"destination": seller.id(), "cancel_after": deadline.to_string(), "condition": hex::encode(Sha256::digest(b"other"))}))
        .deposit(ONE)
        .transact()
        .await?
        .json()?;
    wait_until(&worker, &contract, deadline).await?;
    err_contains(seller.call(contract.id(), "finish").args_json(json!({"id": id2, "fulfillment": hex::encode(b"other")})).gas(GAS).transact().await?, "too late");
    let before = buyer.view_account().await?.balance;
    stranger.call(contract.id(), "cancel").args_json(json!({"id": id2})).gas(GAS).transact().await?.into_result()?;
    let got = buyer.view_account().await?.balance.saturating_sub(before);
    assert!(got > NearToken::from_millinear(990), "buyer refunded {got}");
    Ok(())
}

#[tokio::test]
async fn batch_all_or_nothing_and_surplus_back() -> anyhow::Result<()> {
    let (worker, contract, employer, employee, urssaf) = setup().await?;
    let date = (now_ns(&contract).await? + 10_000_000_000).to_string();
    let lines = |a: u128, b: u128| json!({"items": [
        {"destination": employee.id(), "amount": NearToken::from_millinear(a), "finish_after": date, "memos": ["net 440.36"]},
        {"destination": urssaf.id(),   "amount": NearToken::from_millinear(b), "finish_after": date, "memos": ["URSSAF 361.32"]},
    ]});
    // not enough: nothing created
    err_contains(employer.call(contract.id(), "create_batch").args_json(lines(800, 800)).deposit(ONE).gas(GAS).transact().await?, "does not cover the batch");
    let n: Value = contract.view("count").await?.json()?;
    assert_eq!(n, "0");
    // enough, with surplus: both created, surplus refunded
    let before = employer.view_account().await?.balance;
    let ids: Vec<Value> = employer.call(contract.id(), "create_batch").args_json(lines(400, 300)).deposit(ONE).gas(GAS).transact().await?.json()?;
    assert_eq!(ids.len(), 2);
    let spent = before.saturating_sub(settled(&worker, employer.id(), before.saturating_sub(NearToken::from_millinear(720))).await?);
    assert!(spent < NearToken::from_millinear(720), "spent {spent}, surplus was not returned");
    let _ = worker;
    Ok(())
}

#[tokio::test]
async fn payslip_token_owned_by_the_employee_not_transferable() -> anyhow::Result<()> {
    let (_worker, contract, employer, employee, stranger) = setup().await?;
    let sha = hex::encode(Sha256::digest(b"the clear statement"));
    let sealed = "x".repeat(2000);
    let before = employer.view_account().await?.balance;
    let t: Value = employer
        .call(contract.id(), "issue_payslip")
        .args_json(json!({"owner_id": employee.id(), "period": "2026-10", "sha256": sha, "readers": ["employee", "urssaf", "retraite", "dgfip"], "sealed": sealed}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .json()?;
    assert_eq!(t["token_id"], "payslip-1");
    assert_eq!(t["owner_id"], json!(employee.id()));
    // the record costs its storage, not the whole deposit
    let spent = before.saturating_sub(employer.view_account().await?.balance);
    assert!(spent < NearToken::from_millinear(60), "spent {spent}");
    let mine: Vec<Value> = contract.view("nft_tokens_for_owner").args_json(json!({"account_id": employee.id()})).await?.json()?;
    assert_eq!(mine.len(), 1);
    // anyone reads the sealed file; it is only bytes to them
    let p: Value = contract.view("payslip").args_json(json!({"token_id": "payslip-1"})).await?.json()?;
    assert_eq!(p["sealed"].as_str().unwrap().len(), 2000);
    // the employee cannot give it away, nor can a stranger take it
    err_contains(employee.call(contract.id(), "nft_transfer").args_json(json!({"receiver_id": stranger.id(), "token_id": "payslip-1"})).deposit(NearToken::from_yoctonear(1)).transact().await?, "not transferable");
    err_contains(stranger.call(contract.id(), "nft_transfer").args_json(json!({"receiver_id": stranger.id(), "token_id": "payslip-1"})).deposit(NearToken::from_yoctonear(1)).transact().await?, "not transferable");
    Ok(())
}

#[tokio::test]
async fn deposit_decided_by_two_of_three_or_returned_at_the_deadline() -> anyhow::Result<()> {
    let (worker, contract, landlord, tenant, mediator) = setup().await?;
    let passerby = worker.dev_create_account().await?;
    let deadline = now_ns(&contract).await? + 600_000_000_000;
    let parties = json!([tenant.id(), landlord.id(), mediator.id()]);
    let id: Value = tenant
        .call(contract.id(), "vault_create")
        .args_json(json!({"beneficiary": landlord.id(), "parties": parties, "threshold": 2, "deadline": deadline.to_string(),
                          "memos": ["lease:L-2026-11", "inventory_out:sha256:abc", "quote:sha256:def 180 EUR"]}))
        .deposit(ONE)
        .transact()
        .await?
        .json()?;
    let landlord_before = landlord.view_account().await?.balance;
    let tenant_before = tenant.view_account().await?.balance;
    let cut = NearToken::from_millinear(150);

    // not a party
    err_contains(passerby.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).gas(GAS).transact().await?, "not a party");
    // the landlord alone: recorded, nothing moves
    let r: Value = landlord.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).gas(GAS).transact().await?.json()?;
    assert_eq!(r, json!(false));
    let v: Value = contract.view("vault").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(v["status"], "Locked");
    // the tenant disagrees
    tenant.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": NearToken::from_yoctonear(0)})).gas(GAS).transact().await?.into_result()?;
    // the mediator sides with the quote: paid, both legs
    mediator.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).deposit(NearToken::from_yoctonear(0)).gas(GAS).transact().await?.into_result()?;
    let v: Value = contract.view("vault").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(v["status"], "Finished");
    assert_eq!(v["paid_to_beneficiary"], json!(cut));
    let landlord_after = landlord.view_account().await?.balance;
    let tenant_after = tenant.view_account().await?.balance;
    let got = landlord_after.saturating_sub(landlord_before);
    assert!(got > NearToken::from_millinear(149) && got <= cut, "landlord got {got}");
    let back = tenant_after.saturating_sub(tenant_before);
    assert!(back > NearToken::from_millinear(830) && back < NearToken::from_millinear(870), "tenant got back {back}"); // 0.85 ± gas refunds still landing
    // closed
    err_contains(landlord.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).gas(GAS).transact().await?, "already closed");

    // a deposit nobody decides
    let soon = now_ns(&contract).await? + 8_000_000_000;
    let id2: Value = tenant
        .call(contract.id(), "vault_create")
        .args_json(json!({"beneficiary": landlord.id(), "parties": parties, "threshold": 2, "deadline": soon.to_string()}))
        .deposit(ONE)
        .transact()
        .await?
        .json()?;
    err_contains(passerby.call(contract.id(), "vault_timeout").args_json(json!({"id": id2})).gas(GAS).transact().await?, "deadline not reached");
    wait_until(&worker, &contract, soon).await?;
    let before = tenant.view_account().await?.balance;
    passerby.call(contract.id(), "vault_timeout").args_json(json!({"id": id2})).gas(GAS).transact().await?.into_result()?;
    let v: Value = contract.view("vault").args_json(json!({"id": id2})).await?.json()?;
    assert_eq!(v["status"], "Cancelled");
    assert_eq!(v["closed_by"], json!(passerby.id()));
    let back = tenant.view_account().await?.balance.saturating_sub(before);
    assert!(back > NearToken::from_millinear(990), "tenant got back {back}");
    Ok(())
}

#[tokio::test]
async fn fee_per_act_zero_by_default_set_by_the_administrator_held_and_withdrawn() -> anyhow::Result<()> {
    let (_worker, contract, admin, employer, employee, stranger) = setup_with_admin().await?;
    let far = (now_ns(&contract).await? + 3_600_000_000_000).to_string();
    let create = |who: &Account| {
        who.call(contract.id(), "create")
            .args_json(json!({"destination": employee.id(), "cancel_after": &far}))
            .deposit(ONE)
    };
    async fn amount_of(contract: &Contract, id: &Value) -> anyhow::Result<u128> {
        let e: Value = contract.view("get").args_json(json!({"id": id})).await?.json()?;
        Ok(e["amount"].as_str().unwrap().parse::<u128>()?)
    }
    async fn fees_of(contract: &Contract) -> anyhow::Result<Value> {
        Ok(contract.view("fees").await?.json()?)
    }
    let floor = NearToken::from_millinear(10).as_yoctonear().to_string();

    // zero by default: 1 NEAR in, more than 0.99 locked
    let id: Value = create(&employer).transact().await?.json()?;
    let free = amount_of(&contract, &id).await?;
    assert!(free > NearToken::from_millinear(990).as_yoctonear());
    assert_eq!(fees_of(&contract).await?["acts"], "0");

    // a stranger cannot set the schedule; the administrator cannot go above the ceiling
    err_contains(stranger.call(contract.id(), "set_fee").args_json(json!({"bps": 50, "min": floor})).transact().await?, "only the administrator");
    err_contains(admin.call(contract.id(), "set_fee").args_json(json!({"bps": 101, "min": "0"})).transact().await?, "at most");
    admin.call(contract.id(), "set_fee").args_json(json!({"bps": 50, "min": floor})).transact().await?.into_result()?;

    // 1 NEAR locked at 0.5 % with a 0.01 floor: the floor, taken from the deposit
    let id2: Value = create(&employer).transact().await?.json()?;
    let charged = amount_of(&contract, &id2).await?;
    assert_eq!(free - charged, NearToken::from_millinear(10).as_yoctonear());
    let f = fees_of(&contract).await?;
    assert_eq!(f["held"], floor);
    assert_eq!(f["acts"], "1");

    // the payslip locks nothing: it pays the floor too
    employer
        .call(contract.id(), "issue_payslip")
        .args_json(json!({"owner_id": employee.id(), "period": "2026-10", "sha256": hex::encode(Sha256::digest(b"s")),
                          "readers": ["employee"], "sealed": "sealed"}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    let f = fees_of(&contract).await?;
    assert_eq!(f["held"], NearToken::from_millinear(20).as_yoctonear().to_string());
    assert_eq!(f["acts"], "2");

    // the administrator withdraws: the fees leave the contract, the total stays
    let before = admin.view_account().await?.balance;
    admin.call(contract.id(), "withdraw_fees").args_json(json!({})).gas(GAS).transact().await?.into_result()?;
    let got = settled(&_worker, admin.id(), before.saturating_add(NearToken::from_millinear(5))).await?.saturating_sub(before);
    // the sandbox refunds gas later than it burns it: what shows at once is the fees minus the call
    assert!(got > NearToken::from_millinear(5) && got <= NearToken::from_millinear(20), "administrator got {got}");
    let f = fees_of(&contract).await?;
    assert_eq!(f["held"], "0");
    assert_eq!(f["total"], NearToken::from_millinear(20).as_yoctonear().to_string());
    err_contains(admin.call(contract.id(), "withdraw_fees").args_json(json!({})).gas(GAS).transact().await?, "nothing to withdraw");

    // back to zero: the next act is free again
    admin.call(contract.id(), "set_fee").args_json(json!({"bps": 0, "min": "0"})).transact().await?.into_result()?;
    let id3: Value = create(&employer).transact().await?.json()?;
    assert_eq!(amount_of(&contract, &id3).await?, free);
    Ok(())
}

#[tokio::test]
async fn pool_filled_by_three_payers_paid_at_the_date_or_shares_returned() -> anyhow::Result<()> {
    let (worker, contract, tenant, guarantor, stranger) = setup().await?;
    let landlord = worker.dev_create_account().await?;
    let half = NearToken::from_millinear(500);
    let date = now_ns(&contract).await? + 15_000_000_000;
    let far = (now_ns(&contract).await? + 3_600_000_000_000).to_string();
    // the tenant opens a 1 NEAR pool for the landlord, 0.01 for the record, no share yet
    let id: Value = tenant
        .call(contract.id(), "pool_create")
        .args_json(json!({"destination": landlord.id(), "target": NearToken::from_near(1), "deadline": far,
                          "finish_after": date.to_string(), "memos": ["lease:L-9", "deposit shared with a guarantor"]}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .json()?;
    // the guarantor brings 0.5, the tenant 0.3 on top of its first few millinear: ≈ 0.81, still open, two lines
    guarantor.call(contract.id(), "pool_fund").args_json(json!({"id": id})).deposit(half).gas(GAS).transact().await?.into_result()?;
    tenant.call(contract.id(), "pool_fund").args_json(json!({"id": id})).deposit(NearToken::from_millinear(300)).gas(GAS).transact().await?.into_result()?;
    let p: Value = contract.view("pool").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(p["status"], "Open");
    assert_eq!(p["shares"].as_array().unwrap().len(), 2);
    // nothing to return before the deadline, nothing to pay before it is full
    err_contains(stranger.call(contract.id(), "pool_refund").args_json(json!({"id": id})).gas(GAS).transact().await?, "deadline not reached");
    err_contains(stranger.call(contract.id(), "pool_finish").args_json(json!({"id": id})).gas(GAS).transact().await?, "not full yet");
    // a stranger fills it with 0.5 for the ≈ 0.19 missing: trimmed, the surplus comes back, the pool locks
    let before = stranger.view_account().await?.balance;
    let r = stranger.call(contract.id(), "pool_fund").args_json(json!({"id": id})).deposit(half).gas(GAS).transact().await?;
    let dump = format!("{:?}", r.receipt_outcomes());
    r.into_result()?;
    // the surplus comes back by a receipt of its own: a view right after the call can be a block behind
    let spent = before.saturating_sub(settled(&worker, stranger.id(), before.saturating_sub(NearToken::from_millinear(250))).await?);
    assert!(spent > NearToken::from_millinear(150) && spent < NearToken::from_millinear(250), "the stranger spent {spent}: the surplus did not come back; {dump}");
    let p: Value = contract.view("pool").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(p["status"], "Locked");
    assert_eq!(p["funded"], NearToken::from_near(1).as_yoctonear().to_string());
    assert_eq!(p["shares"].as_array().unwrap().len(), 3);
    err_contains(guarantor.call(contract.id(), "pool_fund").args_json(json!({"id": id})).deposit(half).gas(GAS).transact().await?, "already full");
    err_contains(stranger.call(contract.id(), "pool_finish").args_json(json!({"id": id})).gas(GAS).transact().await?, "too early");
    // at the date, anyone pays the landlord
    wait_until(&worker, &contract, date).await?;
    let before = landlord.view_account().await?.balance;
    stranger.call(contract.id(), "pool_finish").args_json(json!({"id": id})).gas(GAS).transact().await?.into_result()?;
    let got = landlord.view_account().await?.balance.saturating_sub(before);
    assert_eq!(got, NearToken::from_near(1), "landlord got {got}");

    // a second pool nobody fills: at the deadline a passer-by returns every share
    let deadline = now_ns(&contract).await? + 10_000_000_000;
    let id2: Value = tenant
        .call(contract.id(), "pool_create")
        .args_json(json!({"destination": landlord.id(), "target": NearToken::from_near(2), "deadline": deadline.to_string()}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .json()?;
    guarantor.call(contract.id(), "pool_fund").args_json(json!({"id": id2})).deposit(half).gas(GAS).transact().await?.into_result()?;
    wait_until(&worker, &contract, deadline).await?;
    err_contains(tenant.call(contract.id(), "pool_fund").args_json(json!({"id": id2})).deposit(half).gas(GAS).transact().await?, "deadline passed");
    let before = guarantor.view_account().await?.balance;
    stranger.call(contract.id(), "pool_refund").args_json(json!({"id": id2})).gas(GAS).transact().await?.into_result()?;
    let back = guarantor.view_account().await?.balance.saturating_sub(before);
    assert!(back > NearToken::from_millinear(490) && back <= half, "guarantor got back {back}");
    let p: Value = contract.view("pool").args_json(json!({"id": id2})).await?.json()?;
    assert_eq!(p["status"], "Cancelled");
    assert_eq!(p["closed_by"], json!(stranger.id()));
    err_contains(stranger.call(contract.id(), "pool_refund").args_json(json!({"id": id2})).gas(GAS).transact().await?, "nothing to return");
    Ok(())
}

// ------------------------------------------------------------------- the claimable balance

/// A named account that exists now and may not later: the receiver of near-sdk-rs#1666.
async fn named(worker: &Worker<Sandbox>, name: &str) -> anyhow::Result<Account> {
    Ok(worker.root_account()?.create_subaccount(name).initial_balance(NearToken::from_near(5)).transact().await?.into_result()?)
}

async fn claimable_of(contract: &Contract, id: &near_workspaces::AccountId) -> anyhow::Result<NearToken> {
    let v: Value = contract.view("claimable_of").args_json(json!({"account": id})).await?.json()?;
    Ok(NearToken::from_yoctonear(v.as_str().unwrap().parse()?))
}

/// The balance of `id` once it has moved above `before`: a view right after a transaction can be a block behind.
async fn settled(worker: &Worker<Sandbox>, id: &near_workspaces::AccountId, before: NearToken) -> anyhow::Result<NearToken> {
    let mut b = worker.view_account(id).await?.balance;
    for _ in 0..20 {
        if b > before {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        b = worker.view_account(id).await?.balance;
    }
    Ok(b)
}

/// Rewrite the date of the one credit line of `account`, `from` → `to`: the state key is the `Claimable` prefix
/// (storage key 5) followed by the borsh account id; the value is a borsh `Vec<Claimable>` whose `since`
/// sits after the count (4), the amount (16) and the payer (4 + its length).
async fn set_credit_date(worker: &Worker<Sandbox>, contract: &Contract, account: &near_workspaces::AccountId, from: u64, to: u64) -> anyhow::Result<()> {
    let mut key = vec![5u8];
    key.extend((account.as_str().len() as u32).to_le_bytes());
    key.extend(account.as_str().as_bytes());
    let state = contract.view_state().prefix(&key).await?;
    let mut value = state.get(&key).cloned().ok_or_else(|| anyhow::anyhow!("no credit line for {account}"))?;
    let count = u32::from_le_bytes(value[0..4].try_into()?);
    anyhow::ensure!(count == 1, "one line expected, {count} found");
    let payer_len = u32::from_le_bytes(value[20..24].try_into()?) as usize;
    let at = 24 + payer_len;
    anyhow::ensure!(u64::from_le_bytes(value[at..at + 8].try_into()?) == from, "the date is not where expected");
    value[at..at + 8].copy_from_slice(&to.to_le_bytes());
    worker.patch_state(contract.id(), &key, &value).await?;
    Ok(())
}

async fn claimable_total(contract: &Contract) -> anyhow::Result<NearToken> {
    let v: Value = contract.view("claimable_total").await?.json()?;
    Ok(NearToken::from_yoctonear(v.as_str().unwrap().parse()?))
}

/// An escrow for `ghost`, who is then deleted; `finish` by a stranger. Returns the escrow id and its amount.
async fn escrow_to_a_ghost(contract: &Contract, employer: &Account, ghost: Account, stranger: &Account) -> anyhow::Result<(Value, NearToken)> {
    let ghost_id = ghost.id().clone();
    let id: Value = employer.call(contract.id(), "create").args_json(json!({"destination": ghost_id})).deposit(ONE).transact().await?.json()?;
    let e: Value = contract.view("get").args_json(json!({"id": id})).await?.json()?;
    let amount = NearToken::from_yoctonear(e["amount"].as_str().unwrap().parse()?);
    ghost.delete_account(stranger.id()).await?.into_result()?;
    let before = contract.view_account().await?.balance;
    let r = stranger.call(contract.id(), "finish").args_json(json!({"id": id})).gas(GAS).transact().await?;
    let logs = r.logs().join("\n");
    let ok: bool = r.json()?;
    assert!(!ok, "the callback reports the refused leg");
    assert!(logs.contains("transfer_failed") && logs.contains("credit_claimable"), "{logs}");
    // the record stays closed; the money stays in the contract, credited to the name
    let e: Value = contract.view("get").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(e["status"], "Finished");
    assert_eq!(claimable_of(contract, &ghost_id).await?, amount);
    assert_eq!(claimable_total(contract).await?, amount);
    let after = contract.view_account().await?.balance;
    assert!(after >= before && after.saturating_sub(before) < NearToken::from_millinear(10), "contract {before} → {after}: the money did not leave");
    Ok((id, amount))
}

#[tokio::test]
async fn a_finish_to_a_deleted_account_is_credited_and_the_name_claims_it() -> anyhow::Result<()> {
    let (worker, contract, employer, _employee, stranger) = setup().await?;
    let ghost = named(&worker, "ghost").await?;
    let ghost_id = ghost.id().clone();
    let (_id, amount) = escrow_to_a_ghost(&contract, &employer, ghost, &stranger).await?;
    // nobody else can claim it
    err_contains(stranger.call(contract.id(), "claim").gas(GAS).transact().await?, "nothing to claim");
    // the name is registered again (by whoever: here the same root) and claims
    let again = named(&worker, "ghost").await?;
    assert_eq!(again.id(), &ghost_id);
    let before = again.view_account().await?.balance;
    let r = again.call(contract.id(), "claim").gas(GAS).transact().await?;
    let logs = r.logs().join("\n");
    let outcomes = format!("{:?}", r.receipt_outcomes());
    assert!(r.json::<bool>()?, "{logs}");
    assert!(logs.contains("\"event\":\"claim\"") && logs.contains("claimed"), "{logs}");
    let got = settled(&worker, &ghost_id, before).await?.saturating_sub(before);
    // the claim's own gas (30 TGas prepaid, refunded blocks later) shows at once
    assert!(got > amount.saturating_sub(NearToken::from_millinear(50)) && got <= amount, "claimed {got} of {amount}; {logs}; {outcomes}");
    assert_eq!(claimable_of(&contract, &ghost_id).await?, NearToken::from_yoctonear(0));
    assert_eq!(claimable_total(&contract).await?, NearToken::from_yoctonear(0));
    err_contains(again.call(contract.id(), "claim").gas(GAS).transact().await?, "nothing to claim");
    Ok(())
}

#[tokio::test]
async fn the_payer_takes_the_credit_back_after_thirty_days_not_before() -> anyhow::Result<()> {
    let (worker, contract, employer, _employee, stranger) = setup().await?;
    let ghost = named(&worker, "ghost2").await?;
    let ghost_id = ghost.id().clone();
    let (_id, amount) = escrow_to_a_ghost(&contract, &employer, ghost, &stranger).await?;
    err_contains(stranger.call(contract.id(), "claim_for").args_json(json!({"account": ghost_id})).gas(GAS).transact().await?, "not the payer");
    err_contains(employer.call(contract.id(), "claim_for").args_json(json!({"account": ghost_id})).gas(GAS).transact().await?, "too early");
    assert_eq!(claimable_of(&contract, &ghost_id).await?, amount);
    // thirty days: the sandbox clock gains 0.3 s per fast-forwarded block (measured: 10 000 blocks = 2 979 s,
    // 86 s of wall time), so thirty days would be 8.6 million blocks. The credit's date is moved back
    // instead, in the contract's state, by exactly the delay the contract publishes.
    let lines: Vec<Value> = contract.view("claimable_lines").args_json(json!({"account": ghost_id})).await?.json()?;
    let since: u64 = lines[0]["since"].as_str().unwrap().parse()?;
    let delay: u64 = contract.view("claim_delay").await?.json::<Value>()?.as_str().unwrap().parse()?;
    assert_eq!(delay, 30 * 24 * 3600 * 1_000_000_000);
    // one day short, still refused
    let day = 86_400_000_000_000;
    set_credit_date(&worker, &contract, &ghost_id, since, since - delay + day).await?;
    err_contains(employer.call(contract.id(), "claim_for").args_json(json!({"account": ghost_id})).gas(GAS).transact().await?, "too early");
    set_credit_date(&worker, &contract, &ghost_id, since - delay + day, since - delay).await?;
    let lines: Vec<Value> = contract.view("claimable_lines").args_json(json!({"account": ghost_id})).await?.json()?;
    assert_eq!(lines[0]["since"].as_str().unwrap().parse::<u64>()?, since - delay);
    let before = employer.view_account().await?.balance;
    let r = employer.call(contract.id(), "claim_for").args_json(json!({"account": ghost_id})).gas(GAS).transact().await?;
    let logs = r.logs().join("\n");
    assert!(r.json::<bool>()?, "{logs}");
    assert!(logs.contains("claim_for"), "{logs}");
    let got = settled(&worker, employer.id(), before).await?.saturating_sub(before);
    assert!(got > amount.saturating_sub(NearToken::from_millinear(50)) && got <= amount, "payer got {got} of {amount}");
    assert_eq!(claimable_of(&contract, &ghost_id).await?, NearToken::from_yoctonear(0));
    assert_eq!(claimable_total(&contract).await?, NearToken::from_yoctonear(0));
    Ok(())
}

#[tokio::test]
async fn a_vault_payout_with_one_leg_refused_pays_the_other_and_credits_the_refused() -> anyhow::Result<()> {
    let (worker, contract, tenant, mediator, stranger) = setup().await?;
    let landlord = named(&worker, "landlord").await?;
    let landlord_id = landlord.id().clone();
    let parties = json!([tenant.id(), mediator.id(), stranger.id()]);
    let id: Value = tenant
        .call(contract.id(), "vault_create")
        .args_json(json!({"beneficiary": landlord_id, "parties": parties, "threshold": 2, "memos": ["lease:L-ghost"]}))
        .deposit(ONE)
        .transact()
        .await?
        .json()?;
    landlord.delete_account(stranger.id()).await?.into_result()?;
    let cut = NearToken::from_millinear(150);
    let tenant_before = tenant.view_account().await?.balance;
    mediator.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).gas(GAS).transact().await?.into_result()?;
    let r = stranger.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).gas(GAS).transact().await?;
    let logs = r.logs().join("\n");
    assert!(!r.json::<bool>()?, "one leg refused: {logs}");
    // the tenant's leg went through; the landlord's is credited to the name
    let back = tenant.view_account().await?.balance.saturating_sub(tenant_before);
    assert!(back > NearToken::from_millinear(830) && back < NearToken::from_millinear(870), "tenant got back {back}");
    assert_eq!(claimable_of(&contract, &landlord_id).await?, cut);
    assert_eq!(claimable_of(&contract, tenant.id()).await?, NearToken::from_yoctonear(0));
    let v: Value = contract.view("vault").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(v["status"], "Finished");
    assert_eq!(v["paid_to_beneficiary"], json!(cut));
    let lines: Vec<Value> = contract.view("claimable_lines").args_json(json!({"account": landlord_id})).await?.json()?;
    assert_eq!(lines[0]["payer"], json!(tenant.id()));
    assert_eq!(lines[0]["act"], json!(format!("vault:{}", id.as_str().unwrap())));
    Ok(())
}

#[tokio::test]
async fn a_claim_whose_transfer_fails_is_credited_again() -> anyhow::Result<()> {
    let (worker, contract, employer, _employee, stranger) = setup().await?;
    let ghost = named(&worker, "ghost3").await?;
    let ghost_id = ghost.id().clone();
    let (_id, amount) = escrow_to_a_ghost(&contract, &employer, ghost, &stranger).await?;
    // the name comes back, claims, and is deleted again before the transfer lands: the deletion is
    // signed with a second key of the account, so the two transactions do not share a nonce
    let again = named(&worker, "ghost3").await?;
    let sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    again.batch(again.id()).add_key(sk.public_key(), near_workspaces::types::AccessKey::full_access()).transact().await?.into_result()?;
    let twin = Account::from_secret_key(ghost_id.clone(), sk, &worker);
    let pending = again.call(contract.id(), "claim").gas(GAS).transact_async().await?;
    twin.delete_account(stranger.id()).await?.into_result()?;
    let r = pending.await?;
    let logs = r.logs().join("\n");
    assert!(!r.json::<bool>()?, "the claim's transfer was refused: {logs}");
    assert!(logs.contains("claim_failed"), "{logs}");
    assert_eq!(claimable_of(&contract, &ghost_id).await?, amount, "credited again, nothing lost");
    assert_eq!(claimable_total(&contract).await?, amount);
    Ok(())
}

#[tokio::test]
async fn a_pool_refund_with_one_payer_gone_returns_the_others_and_credits_the_gone() -> anyhow::Result<()> {
    let (worker, contract, tenant, guarantor, stranger) = setup().await?;
    let gone = named(&worker, "gone").await?;
    let gone_id = gone.id().clone();
    let half = NearToken::from_millinear(500);
    let deadline = now_ns(&contract).await? + 10_000_000_000;
    let id: Value = tenant
        .call(contract.id(), "pool_create")
        .args_json(json!({"destination": stranger.id(), "target": NearToken::from_near(3), "deadline": deadline.to_string()}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .json()?;
    guarantor.call(contract.id(), "pool_fund").args_json(json!({"id": id})).deposit(half).gas(GAS).transact().await?.into_result()?;
    gone.call(contract.id(), "pool_fund").args_json(json!({"id": id})).deposit(half).gas(GAS).transact().await?.into_result()?;
    gone.delete_account(stranger.id()).await?.into_result()?;
    wait_until(&worker, &contract, deadline).await?;
    let g_before = guarantor.view_account().await?.balance;
    let r = stranger.call(contract.id(), "pool_refund").args_json(json!({"id": id})).gas(GAS).transact().await?;
    assert!(!r.json::<bool>()?);
    let back = guarantor.view_account().await?.balance.saturating_sub(g_before);
    assert!(back > NearToken::from_millinear(490) && back <= half, "guarantor got back {back}");
    let credited = claimable_of(&contract, &gone_id).await?;
    assert!(credited > NearToken::from_millinear(490) && credited <= half, "gone credited {credited}");
    assert_eq!(claimable_total(&contract).await?, credited);
    Ok(())
}
