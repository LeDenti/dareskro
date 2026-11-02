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
//! Two more records live here: the sealed payslip (a NEP-171 token nobody can transfer)
//! and the shared deposit, a vault decided by a threshold of parties (the rental deposit).
//!
//! The service may charge a fee per act (an escrow, a line of a batch, a payslip, a
//! deposit), zero unless the administrator account sets it, and bounded by the code
//! whoever the administrator is: at most 1 % of what is locked, with a floor of at most
//! 0.1 NEAR. It is taken from the deposit at creation, stays in the contract's balance
//! and is withdrawn by the administrator in one call; releasing, cancelling, voting and
//! the deadline cost nothing. The administrator can change the schedule and nothing else.
//!
//! Who holds the funds: this contract account. Deploy it, then delete its
//! full-access keys (`near account delete-keys`): from then on nobody can change
//! the code or take the balance beyond the fees already charged.
//!
//! Times are nanoseconds since the Unix epoch, as `env::block_timestamp()`.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
    PromiseResult, env, near, require,
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
    Payslips,
    PayslipsByOwner,
    Vaults,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    escrows: IterableMap<u64, Escrow>,
    next_id: u64,
    /// the sealed payslips, NEP-171 tokens nobody can transfer; token id = "payslip-<n>"
    payslips: IterableMap<String, Payslip>,
    next_payslip: u64,
    payslips_by_owner: LookupMap<AccountId, Vec<String>>,
    /// the shared deposits, decided by a threshold of parties
    vaults: IterableMap<u64, Vault>,
    next_vault: u64,
    /// the only account that may set the fee and withdraw it (dareskro.near on mainnet)
    admin: AccountId,
    fee: Fee,
    /// charged and not yet withdrawn: part of this account's balance
    fees_held: NearToken,
    /// charged since the first deployment
    fees_total: NearToken,
    acts_charged: u64,
}

/// The state before the fee existed (migrated 01/11/2026 21:54 UTC); `migrate` reads it.
#[near(serializers = [borsh])]
pub struct ContractV2 {
    escrows: IterableMap<u64, Escrow>,
    next_id: u64,
    payslips: IterableMap<String, Payslip>,
    next_payslip: u64,
    payslips_by_owner: LookupMap<AccountId, Vec<String>>,
    vaults: IterableMap<u64, Vault>,
    next_vault: u64,
}

// ------------------------------------------------------------------------------------------
// The fee per act. A percentage of what is locked, with a floor; the payslip, which locks
// nothing, pays the floor. Both are bounded by constants compiled into the contract, so a
// user reading the code knows the most the service can ever take, whoever administers it.
// ------------------------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Fee {
    /// basis points of the amount locked: 1 = 0.01 %, 100 = 1 %
    pub bps: u16,
    /// the least charged per act, in yoctoNEAR
    pub min: NearToken,
}

/// What `fees` returns.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Fees {
    pub admin: AccountId,
    pub fee: Fee,
    pub held: NearToken,
    pub total: NearToken,
    pub acts: U64,
    pub max_bps: u16,
    pub max_min: NearToken,
}

/// The ceiling of the schedule: the administrator cannot go above 1 % or a floor of 0.1 NEAR.
const MAX_FEE_BPS: u16 = 100;
const MAX_FEE_MIN: NearToken = NearToken::from_millinear(100);

// ------------------------------------------------------------------------------------------
// The sealed payslip. The chain is public and permanent, so the payslip never goes on it in
// clear: it is sealed off-chain (AES-256-GCM under a fresh content key, that key wrapped for
// each reader with X25519 — see ../scelle.mjs, the same scheme as agent/confidentiel.mjs on
// XRPL) and what is stored here is the sealed file, the sha256 of the clear statement and the
// list of readers who hold a capsule: the employee, URSSAF, the pension fund, the tax office.
// Anyone can read the record; only a reader's private key turns it back into a payslip.
// It is issued as a NEP-171 token owned by the employee, so wallets and explorers show
// "my payslips", and it cannot be transferred: a payslip stays with the person it names.
// ------------------------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payslip {
    pub owner_id: AccountId,
    pub issuer: AccountId,
    pub escrow_id: Option<U64>,
    pub period: String,
    /// sha256 (hex) of the clear statement — the same value the escrow's memo carries
    pub sha256: String,
    /// who holds a key capsule inside `sealed`
    pub readers: Vec<String>,
    /// the sealed file, opaque to everyone who is not a reader
    pub sealed: String,
    pub issued_at: U64,
}

/// NEP-177 token metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<Base64VecU8>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<Base64VecU8>,
}

/// NEP-171 token view.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Token {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

/// NEP-177 contract metadata.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NFTContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<Base64VecU8>,
}

// ------------------------------------------------------------------------------------------
// The shared deposit (coffre). A rental deposit is held in euros and usually returned in
// part, so it is not an escrow: nobody should be able to pay it out alone, and any split
// must be possible. On XRPL dareskro gave each lease an account under a 2-of-3 signer list
// (depot/). Here the vault is a record of this contract: the tenant (owner) funds it, the
// landlord is the beneficiary, a mediator is the third party. Each party votes the amount
// that goes to the beneficiary — the rest returns to the owner — and the vote that reaches
// the threshold pays, in the same call. Past the deadline with no decision, anyone may
// return everything to the owner. The memos carry the lease id and the sha256 of the
// inventories and quotes: the public trace a judge can read.
// ------------------------------------------------------------------------------------------

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Vote {
    pub party: AccountId,
    pub to_beneficiary: NearToken,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Vault {
    /// who funded it and gets back what the beneficiary is not awarded (the tenant)
    pub owner: AccountId,
    /// who the votes award money to (the landlord)
    pub beneficiary: AccountId,
    /// what is held (the deposit minus this record's storage)
    pub amount: NearToken,
    /// who may vote, 2 to 8 accounts
    pub parties: Vec<AccountId>,
    /// how many parties must vote the same amount
    pub threshold: u8,
    pub votes: Vec<Vote>,
    /// after this time, with no decision, anyone may return everything to the owner
    pub deadline: Option<U64>,
    pub memos: Vec<String>,
    pub status: Status,
    pub paid_to_beneficiary: NearToken,
    pub created_at: U64,
    pub closed_at: Option<U64>,
    pub closed_by: Option<AccountId>,
}

const MAX_PARTIES: usize = 8;

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
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
    /// `admin` is the account that will set the fee and withdraw it. The fee starts at zero.
    #[init]
    pub fn new(admin: AccountId) -> Self {
        Self {
            escrows: IterableMap::new(StorageKey::Escrows),
            next_id: 1,
            payslips: IterableMap::new(StorageKey::Payslips),
            next_payslip: 1,
            payslips_by_owner: LookupMap::new(StorageKey::PayslipsByOwner),
            vaults: IterableMap::new(StorageKey::Vaults),
            next_vault: 1,
            admin,
            fee: Fee { bps: 0, min: NearToken::from_yoctonear(0) },
            fees_held: NearToken::from_yoctonear(0),
            fees_total: NearToken::from_yoctonear(0),
            acts_charged: 0,
        }
    }

    /// From the second deployment (escrows, payslips, deposits) to this one. Keeps every
    /// record; the fee starts at zero.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(admin: AccountId) -> Self {
        let old: ContractV2 = env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"));
        Self {
            escrows: old.escrows,
            next_id: old.next_id,
            payslips: old.payslips,
            next_payslip: old.next_payslip,
            payslips_by_owner: old.payslips_by_owner,
            vaults: old.vaults,
            next_vault: old.next_vault,
            admin,
            fee: Fee { bps: 0, min: NearToken::from_yoctonear(0) },
            fees_held: NearToken::from_yoctonear(0),
            fees_total: NearToken::from_yoctonear(0),
            acts_charged: 0,
        }
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
        let fee = self.fee_for(deposit.saturating_sub(storage));
        require!(deposit > storage.saturating_add(fee), format!("deposit does not cover the fee of {fee}"));
        let amount = deposit.saturating_sub(storage).saturating_sub(fee);
        let e = self.escrows.get_mut(&id).unwrap();
        e.amount = amount;
        let snapshot = e.clone();
        event("create", json!({"id": U64(id), "escrow": snapshot}));
        self.charge("escrow", &id.to_string(), fee);
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
        let mut fees = NearToken::from_yoctonear(0);
        let mut ids = Vec::with_capacity(items.len());
        for item in &items {
            require!(item.amount.as_yoctonear() > 0, "an escrow of zero");
            total = total.saturating_add(item.amount);
            fees = fees.saturating_add(self.fee_for(item.amount));
            ids.push(self.insert(item));
        }
        self.escrows.flush();
        let storage = env::storage_byte_cost()
            .saturating_mul((env::storage_usage() - before) as u128);
        let needed = total.saturating_add(storage).saturating_add(fees);
        require!(
            deposit >= needed,
            format!("deposit {} does not cover the batch: {} + storage {} + fees {}", deposit, total, storage, fees)
        );
        for id in &ids {
            let e = self.escrows.get(id).unwrap().clone();
            event("create", json!({"id": U64(*id), "escrow": e}));
            let fee = self.fee_for(e.amount);
            self.charge("escrow", &id.to_string(), fee);
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

    // ------------------------------------------------------- the sealed payslip

    /// Issue the sealed payslip of a period to the employee, as a token they own and
    /// nobody can transfer. The attached deposit pays the record's storage; the surplus
    /// goes back. `sha256` is the clear statement's; `sealed` is opaque except to `readers`.
    #[payable]
    pub fn issue_payslip(
        &mut self,
        owner_id: AccountId,
        escrow_id: Option<U64>,
        period: String,
        sha256: String,
        readers: Vec<String>,
        sealed: String,
    ) -> Token {
        require!(is_hex(&sha256, 64), "sha256 must be 64 hex characters");
        require!(!readers.is_empty(), "a payslip nobody can read is not a payslip");
        require!(!sealed.is_empty() && sealed.len() <= 64 * 1024, "sealed file: 1 byte to 64 KiB");
        require!(!period.is_empty() && period.len() <= 16, "period, e.g. 2026-10");
        if let Some(id) = escrow_id {
            require!(self.escrows.contains_key(&id.0), "unknown escrow");
        }
        let deposit = env::attached_deposit();
        let before = env::storage_usage();
        let token_id = format!("payslip-{}", self.next_payslip);
        self.next_payslip += 1;
        let p = Payslip {
            owner_id: owner_id.clone(),
            issuer: env::predecessor_account_id(),
            escrow_id,
            period,
            sha256: sha256.to_ascii_lowercase(),
            readers,
            sealed,
            issued_at: U64(env::block_timestamp()),
        };
        self.payslips.insert(token_id.clone(), p);
        let mut list = self.payslips_by_owner.get(&owner_id).cloned().unwrap_or_default();
        list.push(token_id.clone());
        self.payslips_by_owner.insert(owner_id.clone(), list);
        self.payslips.flush();
        self.payslips_by_owner.flush();
        let storage = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        let fee = self.fee_for(NearToken::from_yoctonear(0)); // nothing is locked: the floor
        let needed = storage.saturating_add(fee);
        require!(deposit >= needed, format!("attach at least {} for this record's storage and the fee {}", needed, fee));
        let surplus = deposit.saturating_sub(needed);
        if surplus.as_yoctonear() > 0 {
            Promise::new(env::predecessor_account_id()).transfer(surplus).detach();
        }
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({"standard": "nep171", "version": "1.2.0", "event": "nft_mint",
                   "data": [{"owner_id": owner_id, "token_ids": [token_id]}]})
        ));
        event("payslip", json!({"token_id": token_id, "owner_id": owner_id, "sha256": sha256, "storage": storage}));
        self.charge("payslip", &token_id, fee);
        self.token(&token_id).unwrap()
    }

    /// The whole record, sealed file included.
    pub fn payslip(&self, token_id: String) -> Option<Payslip> {
        self.payslips.get(&token_id).cloned()
    }

    // NEP-171 / NEP-177 views, so wallets and explorers list the payslips.

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "dareskro — sealed payslips".into(),
            symbol: "PAYSLIP".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        self.token(&token_id)
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128((self.next_payslip - 1) as u128)
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.payslips_by_owner.get(&account_id).map(|v| v.len()).unwrap_or(0) as u128)
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let from = from_index.map(|v| v.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50) as usize;
        self.payslips_by_owner
            .get(&account_id)
            .map(|ids| ids.iter().skip(from).take(limit).filter_map(|id| self.token(id)).collect())
            .unwrap_or_default()
    }

    /// A payslip stays with the person it names. Both NEP-171 transfer entry points refuse.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        let _ = (receiver_id, approval_id, memo);
        require!(self.payslips.contains_key(&token_id), "unknown token");
        env::panic_str("a payslip is not transferable: it stays with the person it was issued to");
    }

    #[payable]
    pub fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>, msg: String) -> bool {
        let _ = (receiver_id, approval_id, memo, msg);
        require!(self.payslips.contains_key(&token_id), "unknown token");
        env::panic_str("a payslip is not transferable: it stays with the person it was issued to");
    }

    fn token(&self, token_id: &str) -> Option<Token> {
        let p = self.payslips.get(token_id)?;
        let hash = hex::decode(&p.sha256).unwrap_or_default();
        Some(Token {
            token_id: token_id.to_string(),
            owner_id: p.owner_id.clone(),
            metadata: TokenMetadata {
                title: Some(format!("Payslip {}", p.period)),
                description: Some(format!(
                    "Sealed payslip for {}: readable by {} only; sha256 of the clear statement in reference_hash.",
                    p.period,
                    p.readers.join(", ")
                )),
                media: None,
                media_hash: None,
                copies: Some(1),
                issued_at: Some((p.issued_at.0 / 1_000_000).to_string()),
                expires_at: None,
                starts_at: None,
                updated_at: None,
                extra: Some(
                    json!({"escrow_id": p.escrow_id, "readers": p.readers, "sealed_bytes": p.sealed.len(), "issuer": p.issuer, "transferable": false})
                        .to_string(),
                ),
                reference: None,
                reference_hash: Some(Base64VecU8(hash)),
            },
        })
    }

    // ------------------------------------------------------- the shared deposit

    /// Lock the attached deposit for `beneficiary`, to be decided by `threshold` of
    /// `parties`. The caller is the owner. The record's storage is paid out of the deposit.
    #[payable]
    pub fn vault_create(
        &mut self,
        beneficiary: AccountId,
        parties: Vec<AccountId>,
        threshold: u8,
        deadline: Option<U64>,
        memos: Option<Vec<String>>,
    ) -> U64 {
        let owner = env::predecessor_account_id();
        require!(beneficiary != env::current_account_id(), "the vault cannot pay the contract itself");
        require!(beneficiary != owner, "owner and beneficiary are the two sides of a deposit");
        require!(parties.len() >= 2 && parties.len() <= MAX_PARTIES, "2 to 8 parties");
        require!(
            threshold >= 1 && (threshold as usize) <= parties.len(),
            "threshold must be between 1 and the number of parties"
        );
        for (i, p) in parties.iter().enumerate() {
            require!(!parties[..i].contains(p), "a party is listed twice");
        }
        let now = env::block_timestamp();
        if let Some(d) = deadline {
            require!(d.0 > now, "deadline already passed");
        }
        let deposit = env::attached_deposit();
        let before = env::storage_usage();
        let id = self.next_vault;
        self.next_vault += 1;
        self.vaults.insert(
            id,
            Vault {
                owner,
                beneficiary,
                amount: deposit,
                parties,
                threshold,
                votes: Vec::new(),
                deadline,
                memos: memos.unwrap_or_default(),
                status: Status::Locked,
                paid_to_beneficiary: NearToken::from_yoctonear(0),
                created_at: U64(now),
                closed_at: None,
                closed_by: None,
            },
        );
        self.vaults.flush();
        let storage = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        require!(deposit > storage, "deposit does not even cover the record's storage");
        let fee = self.fee_for(deposit.saturating_sub(storage));
        require!(deposit > storage.saturating_add(fee), format!("deposit does not cover the fee of {fee}"));
        let v = self.vaults.get_mut(&id).unwrap();
        v.amount = deposit.saturating_sub(storage).saturating_sub(fee);
        let snapshot = v.clone();
        event("vault_create", json!({"id": U64(id), "vault": snapshot}));
        self.charge("vault", &id.to_string(), fee);
        U64(id)
    }

    /// One party's vote: `to_beneficiary` for the beneficiary, the rest back to the owner.
    /// A party may change its vote while the vault is locked. The vote that reaches the
    /// threshold pays both sides in this same call; until then nothing moves.
    pub fn vault_vote(&mut self, id: U64, to_beneficiary: NearToken) -> PromiseOrValue<bool> {
        let now = env::block_timestamp();
        let party = env::predecessor_account_id();
        let v = self.vaults.get_mut(&id.0).unwrap_or_else(|| env::panic_str("unknown vault"));
        require!(v.status == Status::Locked, "vault already closed");
        require!(v.parties.contains(&party), "not a party to this deposit");
        require!(to_beneficiary <= v.amount, "vote exceeds the deposit");
        v.votes.retain(|x| x.party != party);
        v.votes.push(Vote { party: party.clone(), to_beneficiary });
        let agree = v.votes.iter().filter(|x| x.to_beneficiary == to_beneficiary).count();
        event("vault_vote", json!({"id": id, "party": party, "to_beneficiary": to_beneficiary, "agree": agree, "threshold": v.threshold}));
        if agree < v.threshold as usize {
            return PromiseOrValue::Value(false);
        }
        let to_owner = v.amount.saturating_sub(to_beneficiary);
        v.status = Status::Finished;
        v.closed_at = Some(U64(now));
        v.closed_by = Some(party.clone());
        v.paid_to_beneficiary = to_beneficiary;
        let (owner, beneficiary) = (v.owner.clone(), v.beneficiary.clone());
        event("vault_decided", json!({"id": id, "by": party, "to_beneficiary": to_beneficiary, "to_owner": to_owner, "votes": agree, "timeout": false}));
        PromiseOrValue::Promise(Self::pay_out(id, beneficiary, to_beneficiary, owner, to_owner))
    }

    /// Past the deadline with no decision: anyone may return the whole deposit to the owner.
    pub fn vault_timeout(&mut self, id: U64) -> Promise {
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let v = self.vaults.get_mut(&id.0).unwrap_or_else(|| env::panic_str("unknown vault"));
        require!(v.status == Status::Locked, "vault already closed");
        let d = v.deadline.unwrap_or_else(|| env::panic_str("this vault has no deadline: only the parties can decide"));
        require!(now >= d.0, "deadline not reached: the parties can still decide");
        v.status = Status::Cancelled;
        v.closed_at = Some(U64(now));
        v.closed_by = Some(caller.clone());
        let (owner, amount) = (v.owner.clone(), v.amount);
        event("vault_decided", json!({"id": id, "by": caller, "to_beneficiary": NearToken::from_yoctonear(0), "to_owner": amount, "votes": 0, "timeout": true}));
        Promise::new(owner).transfer(amount).then(
            Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_vault_paid(id),
        )
    }

    /// After the payout: if a leg failed (an account deleted meanwhile), say so on the ledger.
    /// The vault stays decided; the memo of the failed leg is the trace to act on.
    #[private]
    pub fn on_vault_paid(&mut self, id: U64) -> bool {
        let mut ok = true;
        for i in 0..env::promise_results_count() {
            if !matches!(env::promise_result(i), PromiseResult::Successful(_)) {
                ok = false;
            }
        }
        if !ok {
            event("vault_transfer_failed", json!({"id": id}));
        }
        ok
    }

    pub fn vault(&self, id: U64) -> Option<Vault> {
        self.vaults.get(&id.0).cloned()
    }

    pub fn vaults(&self, from_index: Option<U64>, limit: Option<u32>) -> Vec<(U64, Vault)> {
        let from = from_index.map(|v| v.0).unwrap_or(1);
        let limit = limit.unwrap_or(50) as usize;
        self.vaults
            .iter()
            .filter(|(k, _)| **k >= from)
            .take(limit)
            .map(|(k, v)| (U64(*k), v.clone()))
            .collect()
    }

    pub fn vault_count(&self) -> U64 {
        U64(self.next_vault - 1)
    }

    fn pay_out(id: U64, beneficiary: AccountId, to_beneficiary: NearToken, owner: AccountId, to_owner: NearToken) -> Promise {
        let mut p: Option<Promise> = None;
        if to_beneficiary.as_yoctonear() > 0 {
            p = Some(Promise::new(beneficiary).transfer(to_beneficiary));
        }
        if to_owner.as_yoctonear() > 0 {
            let q = Promise::new(owner).transfer(to_owner);
            p = Some(match p {
                Some(a) => a.and(q),
                None => q,
            });
        }
        p.unwrap().then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_vault_paid(id))
    }

    // ---------------------------------------------------------- the fee per act

    /// The administrator sets the schedule, within the code's ceiling. Zero and zero
    /// makes every act free again.
    pub fn set_fee(&mut self, bps: u16, min: NearToken) -> Fee {
        self.only_admin();
        require!(bps <= MAX_FEE_BPS, format!("the fee is at most {MAX_FEE_BPS} basis points"));
        require!(min <= MAX_FEE_MIN, format!("the floor is at most {MAX_FEE_MIN}"));
        self.fee = Fee { bps, min };
        event("fee_set", json!({"by": env::predecessor_account_id(), "fee": self.fee}));
        self.fee.clone()
    }

    /// The administrator hands the role to another account.
    pub fn set_admin(&mut self, admin: AccountId) {
        self.only_admin();
        event("admin_set", json!({"by": env::predecessor_account_id(), "admin": admin}));
        self.admin = admin;
    }

    /// Everything charged and not yet withdrawn goes to `to` (the administrator by default).
    pub fn withdraw_fees(&mut self, to: Option<AccountId>) -> Promise {
        self.only_admin();
        let amount = self.fees_held;
        require!(amount.as_yoctonear() > 0, "nothing to withdraw");
        let to = to.unwrap_or_else(|| self.admin.clone());
        self.fees_held = NearToken::from_yoctonear(0);
        event("fees_withdrawn", json!({"by": env::predecessor_account_id(), "to": to, "amount": amount}));
        Promise::new(to).transfer(amount).then(
            Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_fees_withdrawn(amount),
        )
    }

    /// If the transfer failed (the account is gone), the fees are held again.
    #[private]
    pub fn on_fees_withdrawn(&mut self, amount: NearToken, #[callback_result] result: Result<(), PromiseError>) -> bool {
        match result {
            Ok(()) => true,
            Err(_) => {
                self.fees_held = self.fees_held.saturating_add(amount);
                event("fees_withdraw_failed", json!({"amount": amount}));
                false
            }
        }
    }

    pub fn fee(&self) -> Fee {
        self.fee.clone()
    }

    pub fn fees(&self) -> Fees {
        Fees {
            admin: self.admin.clone(),
            fee: self.fee.clone(),
            held: self.fees_held,
            total: self.fees_total,
            acts: U64(self.acts_charged),
            max_bps: MAX_FEE_BPS,
            max_min: MAX_FEE_MIN,
        }
    }

    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "only the administrator may do this");
    }

    /// The fee for an act that locks `base`: the percentage, never under the floor.
    fn fee_for(&self, base: NearToken) -> NearToken {
        let pct = base.saturating_mul(self.fee.bps as u128).saturating_div(10_000);
        if pct > self.fee.min { pct } else { self.fee.min }
    }

    /// Book a fee taken from the act's deposit; it stays in this account's balance.
    fn charge(&mut self, act: &str, id: &str, fee: NearToken) {
        if fee.as_yoctonear() == 0 {
            return;
        }
        self.fees_held = self.fees_held.saturating_add(fee);
        self.fees_total = self.fees_total.saturating_add(fee);
        self.acts_charged += 1;
        event("fee", json!({"act": act, "id": id, "fee": fee, "held": self.fees_held}));
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
        let mut c = Contract::new(accounts(5));
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
        let mut c = Contract::new(accounts(5));
        let id = c.create(accounts(2), Some(U64(5_000)), None, None, None);
        testing_env!(ctx(3, 0, 2_000).build());
        let _ = c.finish(id, None);
    }

    #[test]
    #[should_panic(expected = "nobody can cancel")]
    fn payroll_cannot_be_cancelled_by_owner() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new(accounts(5));
        let id = c.create(accounts(2), Some(U64(5_000)), None, None, None);
        testing_env!(ctx(1, 0, 9_000).build());
        let _ = c.cancel(id);
    }

    #[test]
    #[should_panic(expected = "does not match")]
    fn wrong_secret_is_refused() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new(accounts(5));
        let cond = hex::encode(env::sha256(b"the right key"));
        let id = c.create(accounts(2), None, Some(U64(900_000)), Some(cond), None);
        testing_env!(ctx(3, 0, 2_000).build());
        let _ = c.finish(id, Some(hex::encode(b"a wrong key")));
    }

    #[test]
    fn right_secret_releases_and_is_recorded() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new(accounts(5));
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
    fn payslip_is_issued_and_listed() {
        testing_env!(ctx(1, NearToken::from_millinear(50).as_yoctonear(), 1_000).build());
        let mut c = Contract::new(accounts(5));
        let sha = hex::encode(env::sha256(b"the clear statement"));
        let t = c.issue_payslip(accounts(2), None, "2026-10".into(), sha.clone(), vec!["employee".into(), "retraite".into()], "sealed…".into());
        assert_eq!(t.token_id, "payslip-1");
        assert_eq!(t.owner_id, accounts(2));
        assert_eq!(t.metadata.reference_hash.unwrap().0, hex::decode(&sha).unwrap());
        assert_eq!(c.nft_supply_for_owner(accounts(2)), U128(1));
        assert_eq!(c.nft_tokens_for_owner(accounts(2), None, None).len(), 1);
        assert_eq!(c.payslip("payslip-1".into()).unwrap().sealed, "sealed…");
        assert_eq!(c.nft_total_supply(), U128(1));
    }

    #[test]
    #[should_panic(expected = "not transferable")]
    fn payslip_cannot_be_transferred() {
        testing_env!(ctx(1, NearToken::from_millinear(50).as_yoctonear(), 1_000).build());
        let mut c = Contract::new(accounts(5));
        let sha = hex::encode(env::sha256(b"x"));
        c.issue_payslip(accounts(2), None, "2026-10".into(), sha, vec!["employee".into()], "s".into());
        testing_env!(ctx(2, 1, 2_000).build());
        c.nft_transfer(accounts(3), "payslip-1".into(), None, None);
    }

    fn vault_2_of_3() -> (Contract, U64) {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new(accounts(5));
        let id = c.vault_create(accounts(2), vec![accounts(1), accounts(2), accounts(3)], 2, Some(U64(900_000)), Some(vec!["lease:L-1".into()]));
        (c, id)
    }

    #[test]
    fn vault_pays_when_two_of_three_agree() {
        let (mut c, id) = vault_2_of_3();
        let v = c.vault(id).unwrap();
        assert_eq!(v.status, Status::Locked);
        assert!(v.amount > NearToken::from_millinear(990));
        // the landlord alone moves nothing
        testing_env!(ctx(2, 0, 2_000).build());
        assert!(matches!(c.vault_vote(id, NearToken::from_millinear(150)), PromiseOrValue::Value(false)));
        assert_eq!(c.vault(id).unwrap().status, Status::Locked);
        // the tenant disagrees: still nothing
        testing_env!(ctx(1, 0, 3_000).build());
        assert!(matches!(c.vault_vote(id, NearToken::from_millinear(0)), PromiseOrValue::Value(false)));
        assert_eq!(c.vault(id).unwrap().votes.len(), 2);
        // the mediator sides with the landlord: paid
        testing_env!(ctx(3, 0, 4_000).build());
        assert!(matches!(c.vault_vote(id, NearToken::from_millinear(150)), PromiseOrValue::Promise(_)));
        let v = c.vault(id).unwrap();
        assert_eq!(v.status, Status::Finished);
        assert_eq!(v.paid_to_beneficiary, NearToken::from_millinear(150));
        assert_eq!(v.closed_by.unwrap(), accounts(3));
        assert_eq!(c.vault_count(), U64(1));
    }

    #[test]
    #[should_panic(expected = "not a party")]
    fn vault_stranger_cannot_vote() {
        let (mut c, id) = vault_2_of_3();
        testing_env!(ctx(4, 0, 2_000).build());
        let _ = c.vault_vote(id, NearToken::from_millinear(0));
    }

    #[test]
    #[should_panic(expected = "deadline not reached")]
    fn vault_timeout_waits_for_the_deadline() {
        let (mut c, id) = vault_2_of_3();
        testing_env!(ctx(4, 0, 2_000).build());
        let _ = c.vault_timeout(id);
    }

    #[test]
    fn vault_timeout_after_the_deadline_by_anyone() {
        let (mut c, id) = vault_2_of_3();
        testing_env!(ctx(4, 0, 900_001).build());
        let _ = c.vault_timeout(id);
        let v = c.vault(id).unwrap();
        assert_eq!(v.status, Status::Cancelled);
        assert_eq!(v.paid_to_beneficiary, NearToken::from_yoctonear(0));
    }

    #[test]
    fn fee_is_zero_unless_the_administrator_sets_it() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new(accounts(5));
        let f = c.fees();
        assert_eq!(f.admin, accounts(5));
        assert_eq!(f.fee, Fee { bps: 0, min: NearToken::from_yoctonear(0) });
        let id = c.create(accounts(2), None, Some(U64(900_000)), None, None);
        assert!(c.get(id).unwrap().amount > NearToken::from_millinear(990));
        assert_eq!(c.fees().held, NearToken::from_yoctonear(0));
        assert_eq!(c.fees().acts, U64(0));
    }

    #[test]
    fn fee_percentage_with_a_floor_held_then_withdrawn() {
        testing_env!(ctx(5, 0, 1_000).build());
        let mut c = Contract::new(accounts(5));
        c.set_fee(50, NearToken::from_millinear(10)); // 0.5 %, floor 0.01 NEAR
        // 1 NEAR locked: 0.5 % is under the floor → 0.01
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 2_000).build());
        let id = c.create(accounts(2), None, Some(U64(900_000)), None, None);
        let amount = c.get(id).unwrap().amount;
        assert!(amount < NearToken::from_millinear(990) && amount > NearToken::from_millinear(985), "{amount}");
        assert_eq!(c.fees().held, NearToken::from_millinear(10));
        // 10 NEAR locked: 0.5 % is above the floor → ≈ 0.05
        testing_env!(ctx(1, NearToken::from_near(10).as_yoctonear(), 3_000).build());
        c.create(accounts(2), None, Some(U64(900_000)), None, None);
        let held = c.fees().held;
        assert!(held > NearToken::from_millinear(59) && held <= NearToken::from_millinear(60), "{held}");
        // the payslip locks nothing: it pays the floor
        testing_env!(ctx(1, NearToken::from_millinear(50).as_yoctonear(), 4_000).build());
        c.issue_payslip(accounts(2), None, "2026-10".into(), hex::encode(env::sha256(b"x")), vec!["employee".into()], "s".into());
        assert!(c.fees().held > NearToken::from_millinear(69));
        assert_eq!(c.fees().acts, U64(3));
        // the batch: one fee per line
        testing_env!(ctx(1, NearToken::from_near(3).as_yoctonear(), 5_000).build());
        let line = |a: u128| NewEscrow {
            destination: accounts(2),
            amount: NearToken::from_near(a),
            finish_after: Some(U64(9_000)),
            cancel_after: None,
            condition: None,
            memos: None,
        };
        c.create_batch(vec![line(1), line(1)]);
        assert_eq!(c.fees().acts, U64(5));
        assert!(c.fees().held > NearToken::from_millinear(89));
        // withdrawn by the administrator: nothing held, the total stays
        testing_env!(ctx(5, 0, 6_000).build());
        let _ = c.withdraw_fees(None);
        assert_eq!(c.fees().held, NearToken::from_yoctonear(0));
        assert!(c.fees().total > NearToken::from_millinear(89));
        // back to zero: free again
        c.set_fee(0, NearToken::from_yoctonear(0));
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 7_000).build());
        let id = c.create(accounts(2), None, Some(U64(900_000)), None, None);
        assert!(c.get(id).unwrap().amount > NearToken::from_millinear(990));
        assert_eq!(c.fees().acts, U64(5));
    }

    #[test]
    #[should_panic(expected = "only the administrator")]
    fn fee_set_by_a_stranger_is_refused() {
        testing_env!(ctx(1, 0, 1_000).build());
        let mut c = Contract::new(accounts(5));
        c.set_fee(1, NearToken::from_yoctonear(0));
    }

    #[test]
    #[should_panic(expected = "at most")]
    fn fee_above_the_ceiling_is_refused() {
        testing_env!(ctx(5, 0, 1_000).build());
        let mut c = Contract::new(accounts(5));
        c.set_fee(MAX_FEE_BPS + 1, NearToken::from_yoctonear(0));
    }

    #[test]
    #[should_panic(expected = "nothing to withdraw")]
    fn withdraw_with_nothing_held_is_refused() {
        testing_env!(ctx(5, 0, 1_000).build());
        let mut c = Contract::new(accounts(5));
        let _ = c.withdraw_fees(None);
    }

    #[test]
    #[should_panic(expected = "does not cover the batch")]
    fn batch_is_all_or_nothing() {
        testing_env!(ctx(1, NearToken::from_near(1).as_yoctonear(), 1_000).build());
        let mut c = Contract::new(accounts(5));
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
