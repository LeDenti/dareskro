//! Sandbox tests: a real NEAR node (near-sandbox), the compiled wasm, real
//! accounts, real clock. Run: `cargo test` (needs cargo-near on the PATH).
use near_sdk::NearToken;
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ONE: NearToken = NearToken::from_near(1);

async fn setup() -> anyhow::Result<(Worker<Sandbox>, Contract, Account, Account, Account)> {
    let wasm = near_workspaces::compile_project("./").await?;
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;
    contract.call("new").transact().await?.into_result()?;
    let employer = worker.dev_create_account().await?;
    let employee = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;
    Ok((worker, contract, employer, employee, stranger))
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
