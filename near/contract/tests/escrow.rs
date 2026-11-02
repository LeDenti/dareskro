//! Sandbox tests: a real NEAR node (near-sandbox), the compiled wasm, real
//! accounts, real clock. Run: `cargo test` (needs cargo-near on the PATH).
use near_sdk::NearToken;
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ONE: NearToken = NearToken::from_near(1);

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
    err_contains(stranger.call(contract.id(), "finish").args_json(json!({"id": id})).transact().await?, "too early");
    // the employer cannot take it back: there is no cancel date
    err_contains(employer.call(contract.id(), "cancel").args_json(json!({"id": id})).transact().await?, "nobody can cancel");

    wait_until(&worker, &contract, pay_date).await?;
    let before = employee.view_account().await?.balance;
    // after the date, anyone finishes it: the money goes where it was written
    stranger.call(contract.id(), "finish").args_json(json!({"id": id})).transact().await?.into_result()?;
    let after = employee.view_account().await?.balance;
    let got = after.saturating_sub(before);
    assert!(got > NearToken::from_millinear(990) && got <= ONE, "employee got {got}");
    let e: Value = contract.view("get").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(e["status"], "Finished");
    assert_eq!(e["closed_by"], json!(stranger.id()));
    // twice: no
    err_contains(stranger.call(contract.id(), "finish").args_json(json!({"id": id})).transact().await?, "already closed");
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
    err_contains(seller.call(contract.id(), "finish").args_json(json!({"id": id})).transact().await?, "bring the fulfillment");
    err_contains(seller.call(contract.id(), "finish").args_json(json!({"id": id, "fulfillment": hex::encode(b"wrong")})).transact().await?, "does not match");
    err_contains(buyer.call(contract.id(), "cancel").args_json(json!({"id": id})).transact().await?, "too early");
    let r = seller.call(contract.id(), "finish").args_json(json!({"id": id, "fulfillment": hex::encode(key)})).transact().await?;
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
    err_contains(seller.call(contract.id(), "finish").args_json(json!({"id": id2, "fulfillment": hex::encode(b"other")})).transact().await?, "too late");
    let before = buyer.view_account().await?.balance;
    stranger.call(contract.id(), "cancel").args_json(json!({"id": id2})).transact().await?.into_result()?;
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
    err_contains(employer.call(contract.id(), "create_batch").args_json(lines(800, 800)).deposit(ONE).transact().await?, "does not cover the batch");
    let n: Value = contract.view("count").await?.json()?;
    assert_eq!(n, "0");
    // enough, with surplus: both created, surplus refunded
    let before = employer.view_account().await?.balance;
    let ids: Vec<Value> = employer.call(contract.id(), "create_batch").args_json(lines(400, 300)).deposit(ONE).transact().await?.json()?;
    assert_eq!(ids.len(), 2);
    let spent = before.saturating_sub(employer.view_account().await?.balance);
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
    err_contains(passerby.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).transact().await?, "not a party");
    // the landlord alone: recorded, nothing moves
    let r: Value = landlord.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).transact().await?.json()?;
    assert_eq!(r, json!(false));
    let v: Value = contract.view("vault").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(v["status"], "Locked");
    // the tenant disagrees
    tenant.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": NearToken::from_yoctonear(0)})).transact().await?.into_result()?;
    // the mediator sides with the quote: paid, both legs
    mediator.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).deposit(NearToken::from_yoctonear(0)).max_gas().transact().await?.into_result()?;
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
    err_contains(landlord.call(contract.id(), "vault_vote").args_json(json!({"id": id, "to_beneficiary": cut})).transact().await?, "already closed");

    // a deposit nobody decides
    let soon = now_ns(&contract).await? + 8_000_000_000;
    let id2: Value = tenant
        .call(contract.id(), "vault_create")
        .args_json(json!({"beneficiary": landlord.id(), "parties": parties, "threshold": 2, "deadline": soon.to_string()}))
        .deposit(ONE)
        .transact()
        .await?
        .json()?;
    err_contains(passerby.call(contract.id(), "vault_timeout").args_json(json!({"id": id2})).transact().await?, "deadline not reached");
    wait_until(&worker, &contract, soon).await?;
    let before = tenant.view_account().await?.balance;
    passerby.call(contract.id(), "vault_timeout").args_json(json!({"id": id2})).max_gas().transact().await?.into_result()?;
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
    admin.call(contract.id(), "withdraw_fees").args_json(json!({})).transact().await?.into_result()?;
    let got = admin.view_account().await?.balance.saturating_sub(before);
    // the sandbox refunds gas later than it burns it: what shows at once is the fees minus the call
    assert!(got > NearToken::from_millinear(5) && got <= NearToken::from_millinear(20), "administrator got {got}");
    let f = fees_of(&contract).await?;
    assert_eq!(f["held"], "0");
    assert_eq!(f["total"], NearToken::from_millinear(20).as_yoctonear().to_string());
    err_contains(admin.call(contract.id(), "withdraw_fees").args_json(json!({})).transact().await?, "nothing to withdraw");

    // back to zero: the next act is free again
    admin.call(contract.id(), "set_fee").args_json(json!({"bps": 0, "min": "0"})).transact().await?.into_result()?;
    let id3: Value = create(&employer).transact().await?.json()?;
    assert_eq!(amount_of(&contract, &id3).await?, free);
    Ok(())
}
