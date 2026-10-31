//! dareskro on NEAR — the escrow is a contract with no owner.
//!
//! On the XRP Ledger, `EscrowCreate` is a native transaction: the ledger holds
//! the money. NEAR has no native escrow, so this contract *is* the escrow. Its
//! guarantees are the same ones dareskro measured on XRPL, written as code:
//!
//! * the money goes to the `destination` written at creation — `finish` has no
//!   field for another address, whoever calls it;
//! * before `finish_after`, `finish` is refused by the contract's clock
//!   (`env::block_timestamp`), not by a promise;
//! * an escrow without `cancel_after` can never be cancelled, not even by the
//!   owner — the payroll shape, one possible outcome;
//! * an escrow with a `condition` (sha256 of a secret) is released only by the
//!   secret, and the secret becomes public on the ledger in that same call;
//! * `create_batch` locks several escrows under one signature, all or nothing,
//!   the NEAR counterpart of the XLS-56 Batch dareskro used for net pay +
//!   contributions + income tax.
//!
//! Who holds the funds: this contract account. Deploy it, then delete its
//! full-access keys (`near account delete-keys`): from then on nobody can change
//! the code or take the balance, and the only moves left are the four methods.
//!
//! Times are nanoseconds since the Unix epoch, as `env::block_timestamp()`.
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near,
    require,
};

const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Locked,
    Finished,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Escrow {
    pub owner: AccountId,
    pub destination: AccountId,
    /// what the destination receives (the deposit minus this record's storage)
    pub amount: NearToken,
    /// no finish before this time (payroll: the pay date)
    pub finish_after: Option<U64>,
    /// from this time on, finish is refused and cancel refunds the owner;
    /// absent = nobody can ever cancel
    pub cancel_after: Option<U64>,
    /// sha256 (hex) of a secret; finish must bring the secret
    pub condition: Option<String>,
    /// free text written at creation: statement hash, fiat line, oracle…
    pub memos: Vec<String>,
    pub status: Status,
    pub created_at: U64,
    pub closed_at: Option<U64>,
    pub closed_by: Option<AccountId>,
    /// the secret, once revealed
    pub fulfillment: Option<String>,
}

/// One line of a batch.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NewEscrow {
    pub destination: AccountId,
    pub amount: NearToken,
    pub finish_after: Option<U64>,
    pub cancel_after: Option<U64>,
    pub condition: Option<String>,
    pub memos: Option<Vec<String>>,
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Escrows,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    escrows: IterableMap<u64, Escrow>,
    next_id: u64,
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "dareskro", "version": "1.0.0", "event": name, "data": [data]})
    ));
}

fn check_shape(e: &NewEscrow) {
    if let Some(c) = &e.condition {
        require!(
            c.len() == 64 && c.bytes().all(|b| b.is_ascii_hexdigit()),
            "condition must be a sha256 in hex (64 characters)"
        );
    }
    if let (Some(f), Some(c)) = (e.finish_after, e.cancel_after) {
        require!(c.0 > f.0, "cancel_after must be later than finish_after");
    }
    require!(
        e.destination != env::current_account_id(),
        "the escrow cannot pay the contract itself"
    );
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self { escrows: IterableMap::new(StorageKey::Escrows), next_id: 1 }
    }

    // ------------------------------------------------------------------ writes

    /// Lock the attached deposit for `destination`. The record's storage is paid
    /// out of the deposit; the rest is the escrow's amount.
    #[payable]
    pub fn create(
        &mut self,
        destination: AccountId,
        finish_after: Option<U64>,
        cancel_after: Option<U64>,
        condition: Option<String>,
        memos: Option<Vec<String>>,
    ) -> U64 {
        let deposit = env::attached_deposit();
        let item = NewEscrow { destination, amount: deposit, finish_after, cancel_after, condition, memos };
        let before = env::storage_usage();
        let id = self.insert(&item);
        self.escrows.flush(); // store:: collections write lazily; measure what was really written
        let storage = env::storage_byte_cost()
            .saturating_mul((env::storage_usage() - before) as u128);
        require!(deposit > storage, "deposit does not even cover the record's storage");
        let amount = deposit.saturating_sub(storage);
        let e = self.escrows.get_mut(&id).unwrap();
        e.amount = amount;
        let snapshot = e.clone();
        event("create", json!({"id": U64(id), "escrow": snapshot}));
        U64(id)
    }

    /// Several escrows under one signature, all or nothing. The attached deposit
    /// must cover every amount plus the records' storage; the surplus goes back
    /// to the caller.
    #[payable]
    pub fn create_batch(&mut self, items: Vec<NewEscrow>) -> Vec<U64> {
        require!(!items.is_empty(), "empty batch");
        let deposit = env::attached_deposit();
        let before = env::storage_usage();
        let mut total = NearToken::from_yoctonear(0);
        let mut ids = Vec::with_capacity(items.len());
        for item in &items {
            require!(item.amount.as_yoctonear() > 0, "an escrow of zero");
            total = total.saturating_add(item.amount);
            ids.push(self.insert(item));
        }
        self.escrows.flush();
        let storage = env::storage_byte_cost()
            .saturating_mul((env::storage_usage() - before) as u128);
        let needed = total.saturating_add(storage);
        require!(
            deposit >= needed,
            format!("deposit {} does not cover the batch: {} + storage {}", deposit, total, storage)
        );
        for id in &ids {
            let e = self.escrows.get(id).unwrap().clone();
            event("create", json!({"id": U64(*id), "escrow": e}));
        }
        let surplus = deposit.saturating_sub(needed);
        if surplus.as_yoctonear() > 0 {
            Promise::new(env::predecessor_account_id()).transfer(surplus).detach();
        }
        ids.into_iter().map(U64).collect()
    }

    /// Release the escrow to its destination. Anyone may call it; the only
    /// questions are *when* (the clock) and, with a condition, *whether* (the
    /// secret). There is no parameter for where the money goes.
    pub fn finish(&mut self, id: U64, fulfillment: Option<String>) -> Promise {
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let e = self.escrows.get_mut(&id.0).unwrap_or_else(|| env::panic_str("unknown escrow"));
        require!(e.status == Status::Locked, "escrow already closed");
        if let Some(f) = e.finish_after {
            require!(now >= f.0, "too early: the contract's clock has not reached finish_after");
        }
        if let Some(c) = e.cancel_after {
            require!(now < c.0, "too late: past cancel_after only cancel is possible");
        }
        match (&e.condition, &fulfillment) {
            (None, None) => {}
            (None, Some(_)) => env::panic_str("this escrow has no condition"),
            (Some(_), None) => env::panic_str("this escrow is locked by a condition: bring the fulfillment"),
            (Some(cond), Some(f)) => {
                let bytes = hex::decode(f).unwrap_or_else(|_| env::panic_str("fulfillment must be hex"));
                let digest = hex::encode(env::sha256(&bytes));
                require!(&digest == cond, "fulfillment does not match the condition");
            }
        }
        e.status = Status::Finished;
        e.closed_at = Some(U64(now));
        e.closed_by = Some(caller.clone());
        e.fulfillment = fulfillment.clone();
        let (destination, amount) = (e.destination.clone(), e.amount);
        event("finish", json!({"id": id, "by": caller, "to": destination, "amount": amount, "fulfillment": fulfillment}));
        Promise::new(destination).transfer(amount).then(
            Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer(id),
        )
    }

    /// Refund the owner, only after `cancel_after`. An escrow created without
    /// `cancel_after` cannot be cancelled by anyone, the owner included.
    pub fn cancel(&mut self, id: U64) -> Promise {
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let e = self.escrows.get_mut(&id.0).unwrap_or_else(|| env::panic_str("unknown escrow"));
        require!(e.status == Status::Locked, "escrow already closed");
        let c = e.cancel_after.unwrap_or_else(|| env::panic_str("this escrow has no cancel_after: nobody can cancel it"));
        require!(now >= c.0, "too early: cancel_after not reached");
        e.status = Status::Cancelled;
        e.closed_at = Some(U64(now));
        e.closed_by = Some(caller.clone());
        let (owner, amount) = (e.owner.clone(), e.amount);
        event("cancel", json!({"id": id, "by": caller, "to": owner, "amount": amount}));
        Promise::new(owner).transfer(amount).then(
            Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer(id),
        )
    }

    /// If the transfer itself failed (destination account gone), reopen the
    /// escrow so the money is not stranded as "paid".
    #[private]
    pub fn on_transfer(&mut self, id: U64, #[callback_result] result: Result<(), PromiseError>) -> bool {
        match result {
            Ok(()) => true,
            Err(_) => {
                if let Some(e) = self.escrows.get_mut(&id.0) {
                    e.status = Status::Locked;
                    e.closed_at = None;
                    e.closed_by = None;
                    e.fulfillment = None;
                }
                event("transfer_failed", json!({"id": id}));
                false
            }
        }
    }

    // ------------------------------------------------------------------- views

    pub fn get(&self, id: U64) -> Option<Escrow> {
        self.escrows.get(&id.0).cloned()
    }

    pub fn list(&self, from_index: Option<U64>, limit: Option<u32>) -> Vec<(U64, Escrow)> {
        let from = from_index.map(|v| v.0).unwrap_or(1);
        let limit = limit.unwrap_or(50) as usize;
        self.escrows
            .iter()
            .filter(|(k, _)| **k >= from)
            .take(limit)
            .map(|(k, v)| (U64(*k), v.clone()))
            .collect()
    }

    pub fn count(&self) -> U64 {
        U64(self.next_id - 1)
    }

    /// The contract's clock, for the desk and the oracle.
    pub fn now(&self) -> U64 {
        U64(env::block_timestamp())
    }

    // --------------------------------------------------------------- internals

    fn insert(&mut self, item: &NewEscrow) -> u64 {
        check_shape(item);
        let id = self.next_id;
        self.next_id += 1;
        self.escrows.insert(
            id,
            Escrow {
                owner: env::predecessor_account_id(),
                destination: item.destination.clone(),
                amount: item.amount,
                finish_after: item.finish_after,
                cancel_after: item.cancel_after,
                condition: item.condition.clone().map(|c| c.to_ascii_lowercase()),
                memos: item.memos.clone().unwrap_or_default(),
                status: Status::Locked,
                created_at: U64(env::block_timestamp()),
                closed_at: None,
                closed_by: None,
                fulfillment: None,
            },
        );
        id
    }
}

#[cfg(test)]
mod unit {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    fn ctx(pred: usize, deposit: u128, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(accounts(0))
            .predecessor_account_id(accounts(pred))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts);
        b
    }

    #[test]
    fn payroll_shape_rules() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new();
        let id = c.create(accounts(2), Some(U64(5_000)), None, None, Some(vec!["sha256:abc".into()]));
        let e = c.get(id).unwrap();
        assert_eq!(e.status, Status::Locked);
        assert!(e.amount < NearToken::from_near(1));
        assert!(e.amount > NearToken::from_millinear(990));
        assert_eq!(c.count(), U64(1));
    }

    #[test]
    #[should_panic(expected = "too early")]
    fn finish_before_date_is_refused() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new();
        let id = c.create(accounts(2), Some(U64(5_000)), None, None, None);
        testing_env!(ctx(3, 0, 2_000).build());
        let _ = c.finish(id, None);
    }

    #[test]
    #[should_panic(expected = "nobody can cancel")]
    fn payroll_cannot_be_cancelled_by_owner() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new();
        let id = c.create(accounts(2), Some(U64(5_000)), None, None, None);
        testing_env!(ctx(1, 0, 9_000).build());
        let _ = c.cancel(id);
    }

    #[test]
    #[should_panic(expected = "does not match")]
    fn wrong_secret_is_refused() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new();
        let cond = hex::encode(env::sha256(b"the right key"));
        let id = c.create(accounts(2), None, Some(U64(900_000)), Some(cond), None);
        testing_env!(ctx(3, 0, 2_000).build());
        let _ = c.finish(id, Some(hex::encode(b"a wrong key")));
    }

    #[test]
    fn right_secret_releases_and_is_recorded() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new();
        let cond = hex::encode(env::sha256(b"the right key"));
        let id = c.create(accounts(2), None, Some(U64(900_000)), Some(cond), None);
        testing_env!(ctx(3, 0, 2_000).build());
        let _ = c.finish(id, Some(hex::encode(b"the right key")));
        let e = c.get(id).unwrap();
        assert_eq!(e.status, Status::Finished);
        assert_eq!(e.fulfillment.unwrap(), hex::encode(b"the right key"));
        assert_eq!(e.closed_by.unwrap(), accounts(3));
    }

    #[test]
    #[should_panic(expected = "does not cover the batch")]
    fn batch_is_all_or_nothing() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new();
        let line = |a: u128| NewEscrow {
            destination: accounts(2),
            amount: NearToken::from_millinear(a),
            finish_after: Some(U64(5_000)),
            cancel_after: None,
            condition: None,
            memos: None,
        };
        c.create_batch(vec![line(600), line(600)]);
    }
}
