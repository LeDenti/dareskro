//! dareskro on Casper 2.x: the escrow with a conditional payment.
//!
//! The same guarantees dareskro measured on the XRP Ledger (native `EscrowCreate`),
//! on Solana and on NEAR, written as code and measured again on Casper:
//!
//! - the money goes where it was written: `release(id, _)` has no parameter for an
//!   address, the destination is read from the record;
//! - nobody pays early: `release` before `release_after` reverts with `TooEarly`;
//! - nobody takes it back: without a cancel date `refund` reverts with `NotCancellable`;
//!   with one, only after it, and only to the payer;
//! - release by the oracle (the service that reads the evidence) **or** by whoever
//!   holds the key of the SHA-256 condition (PREIMAGE-SHA-256, as on XRPL): the key is
//!   recorded on chain;
//! - a fee per act, charged at release, **capped by the code at 1 %** and zero by default,
//!   kept in the contract until the administrator withdraws it (as on NEAR).
//!
//! Amounts are in motes (1 CSPR = 10^9 motes); times are block times in milliseconds.

use odra::casper_types::U512;
use odra::prelude::*;
use sha2::{Digest, Sha256};

/// The fee per act can never exceed this: 100 bps = 1 %.
pub const FEE_CAP_BPS: u32 = 100;
const BPS_DENOMINATOR: u64 = 10_000;
/// A condition is the lowercase hex of a SHA-256 digest.
const CONDITION_HEX_LEN: usize = 64;

/// Escrow lifecycle states.
pub mod status {
    /// Funds locked in the contract.
    pub const OPEN: u8 = 0;
    /// Paid to the beneficiary (minus the fee).
    pub const RELEASED: u8 = 1;
    /// Returned to the payer after the cancel date.
    pub const REFUNDED: u8 = 2;
}

/// One escrow record.
#[odra::odra_type]
pub struct Escrow {
    /// Sequential identifier, from 1.
    pub id: u64,
    /// Account that funded the escrow; the only destination of a refund.
    pub payer: Address,
    /// Account paid at release; the only destination of a release.
    pub beneficiary: Address,
    /// Locked amount in motes.
    pub amount: U512,
    /// Block time (ms) before which nobody can release. 0 = at once.
    pub release_after: u64,
    /// Block time (ms) after which a refund is possible. 0 = never.
    pub cancel_after: u64,
    /// Lowercase hex SHA-256 of the key that releases without the oracle.
    pub condition: Option<String>,
    /// Fingerprint of the off-chain document (never the document).
    pub memo: String,
    /// One of [`status`].
    pub status: u8,
    /// Block time (ms) of creation.
    pub created_at: u64,
    /// Block time (ms) of release or refund, 0 while open.
    pub closed_at: u64,
    /// Account that closed the escrow.
    pub closed_by: Option<Address>,
    /// The key, recorded when the condition released the escrow.
    pub fulfillment: Option<String>,
    /// Fee kept by the contract at release (motes).
    pub fee_paid: U512,
}

/// Errors raised by [`DareskroEscrow`].
#[odra::odra_error]
pub enum Error {
    /// Caller is not the administrator.
    NotAdmin = 1,
    /// Caller is neither the oracle nor the holder of the key.
    NotAuthorized = 2,
    /// `release_after` has not passed.
    TooEarly = 3,
    /// The escrow has no cancel date: nobody can take the money back.
    NotCancellable = 4,
    /// `cancel_after` has not passed.
    CancelTooEarly = 5,
    /// No escrow with this id.
    NotFound = 6,
    /// The escrow is already released or refunded.
    AlreadyClosed = 7,
    /// Nothing attached.
    ZeroAmount = 8,
    /// `cancel_after` must be 0 or later than `release_after`.
    BadDates = 9,
    /// The condition is not 64 lowercase hex characters.
    BadCondition = 10,
    /// SHA-256 of the key does not match the condition.
    WrongFulfillment = 11,
    /// The fee per act exceeds [`FEE_CAP_BPS`].
    FeeTooHigh = 12,
    /// No fee has been collected yet.
    NothingToWithdraw = 13,
}

/// Emitted at creation.
#[odra::event]
pub struct Created {
    /// Escrow id.
    pub id: u64,
    /// Payer.
    pub payer: Address,
    /// Beneficiary.
    pub beneficiary: Address,
    /// Amount in motes.
    pub amount: U512,
    /// Release date (ms).
    pub release_after: u64,
    /// Cancel date (ms), 0 = never.
    pub cancel_after: u64,
    /// Memo (fingerprint).
    pub memo: String,
}

/// Emitted at release.
#[odra::event]
pub struct Released {
    /// Escrow id.
    pub id: u64,
    /// Who released: the oracle, or the holder of the key.
    pub by: Address,
    /// Paid to the beneficiary (motes).
    pub paid: U512,
    /// Kept as fee (motes).
    pub fee: U512,
    /// True when the condition, not the oracle, released it.
    pub by_condition: bool,
}

/// Emitted at refund.
#[odra::event]
pub struct Refunded {
    /// Escrow id.
    pub id: u64,
    /// Who asked for the refund.
    pub by: Address,
    /// Returned to the payer (motes).
    pub amount: U512,
}

/// Emitted when the administrator changes the fee per act.
#[odra::event]
pub struct FeeSet {
    /// Fee in basis points (<= 100).
    pub fee_bps: u32,
}

/// The dareskro escrow contract.
#[odra::module(errors = Error, events = [Created, Released, Refunded, FeeSet])]
pub struct DareskroEscrow {
    admin: Var<Address>,
    oracle: Var<Address>,
    fee_bps: Var<u32>,
    fees_collected: Var<U512>,
    count: Var<u64>,
    escrows: Mapping<u64, Escrow>,
}

#[odra::module]
impl DareskroEscrow {
    /// The deployer becomes administrator and, until `set_oracle`, the oracle.
    /// The fee per act starts at zero.
    pub fn init(&mut self) {
        let caller = self.env().caller();
        self.admin.set(caller);
        self.oracle.set(caller);
        self.fee_bps.set(0);
        self.fees_collected.set(U512::zero());
        self.count.set(0);
    }

    // ------------------------------------------------------------ administration

    /// Names the oracle: the account allowed to release without the key. Admin only.
    pub fn set_oracle(&mut self, oracle: Address) {
        self.require_admin();
        self.oracle.set(oracle);
    }

    /// Sets the fee per act in basis points. The code refuses anything above
    /// [`FEE_CAP_BPS`] (1 %), whoever asks. Admin only.
    pub fn set_fee(&mut self, fee_bps: u32) {
        self.require_admin();
        if fee_bps > FEE_CAP_BPS {
            self.env().revert(Error::FeeTooHigh);
        }
        self.fee_bps.set(fee_bps);
        self.env().emit_event(FeeSet { fee_bps });
    }

    /// Pays the collected fees to `to`. Admin only.
    pub fn withdraw_fees(&mut self, to: Address) -> U512 {
        self.require_admin();
        let fees = self.fees_collected.get_or_default();
        if fees.is_zero() {
            self.env().revert(Error::NothingToWithdraw);
        }
        self.fees_collected.set(U512::zero());
        self.env().transfer_tokens(&to, &fees);
        fees
    }

    // ------------------------------------------------------------------ escrow

    /// Locks the attached CSPR for `beneficiary`.
    ///
    /// `release_after` and `cancel_after` are block times in ms (0 = at once / never).
    /// `condition` is the lowercase hex SHA-256 of a key that may release instead of the
    /// oracle. `memo` is the fingerprint of the off-chain document.
    #[odra(payable)]
    pub fn create(
        &mut self,
        beneficiary: Address,
        release_after: u64,
        cancel_after: u64,
        condition: Option<String>,
        memo: String,
    ) -> u64 {
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        if cancel_after != 0 && cancel_after <= release_after {
            self.env().revert(Error::BadDates);
        }
        if let Some(c) = &condition {
            if c.len() != CONDITION_HEX_LEN
                || !c.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                self.env().revert(Error::BadCondition);
            }
        }
        let payer = self.env().caller();
        let now = self.env().get_block_time();
        let id = self.count.get_or_default() + 1;
        self.escrows.set(
            &id,
            Escrow {
                id,
                payer,
                beneficiary,
                amount,
                release_after,
                cancel_after,
                condition,
                memo: memo.clone(),
                status: status::OPEN,
                created_at: now,
                closed_at: 0,
                closed_by: None,
                fulfillment: None,
                fee_paid: U512::zero(),
            },
        );
        self.count.set(id);
        self.env().emit_event(Created {
            id,
            payer,
            beneficiary,
            amount,
            release_after,
            cancel_after,
            memo,
        });
        id
    }

    /// Pays the beneficiary. Allowed after `release_after`, to the oracle, or to anyone
    /// whose `fulfillment` hashes to the condition. The destination cannot be chosen here.
    pub fn release(&mut self, id: u64, fulfillment: Option<String>) {
        let mut e = self.load_open(id);
        let now = self.env().get_block_time();
        if now < e.release_after {
            self.env().revert(Error::TooEarly);
        }
        let caller = self.env().caller();
        let by_condition = match (&e.condition, &fulfillment) {
            (Some(condition), Some(key)) => {
                if hex_sha256(key.as_bytes()) != *condition {
                    self.env().revert(Error::WrongFulfillment);
                }
                true
            }
            _ => false,
        };
        if !by_condition && caller != self.oracle.get_or_revert_with(Error::NotAuthorized) {
            self.env().revert(Error::NotAuthorized);
        }
        let fee = e.amount * U512::from(self.fee_bps.get_or_default()) / U512::from(BPS_DENOMINATOR);
        let paid = e.amount - fee;
        e.status = status::RELEASED;
        e.closed_at = now;
        e.closed_by = Some(caller);
        e.fee_paid = fee;
        if by_condition {
            e.fulfillment = fulfillment;
        }
        let beneficiary = e.beneficiary;
        self.escrows.set(&id, e);
        if !fee.is_zero() {
            self.fees_collected.set(self.fees_collected.get_or_default() + fee);
        }
        self.env().transfer_tokens(&beneficiary, &paid);
        self.env().emit_event(Released {
            id,
            by: caller,
            paid,
            fee,
            by_condition,
        });
    }

    /// Returns the money to the payer, by anyone, after `cancel_after`. An escrow
    /// without a cancel date can never be refunded, not even by the administrator.
    pub fn refund(&mut self, id: u64) {
        let mut e = self.load_open(id);
        if e.cancel_after == 0 {
            self.env().revert(Error::NotCancellable);
        }
        let now = self.env().get_block_time();
        if now < e.cancel_after {
            self.env().revert(Error::CancelTooEarly);
        }
        let caller = self.env().caller();
        e.status = status::REFUNDED;
        e.closed_at = now;
        e.closed_by = Some(caller);
        let (payer, amount) = (e.payer, e.amount);
        self.escrows.set(&id, e);
        self.env().transfer_tokens(&payer, &amount);
        self.env().emit_event(Refunded {
            id,
            by: caller,
            amount,
        });
    }

    // ------------------------------------------------------------------- views

    /// The escrow record.
    pub fn get_escrow(&self, id: u64) -> Option<Escrow> {
        self.escrows.get(&id)
    }

    /// Number of escrows ever created.
    pub fn count(&self) -> u64 {
        self.count.get_or_default()
    }

    /// The oracle account.
    pub fn oracle(&self) -> Address {
        self.oracle.get_or_revert_with(Error::NotAuthorized)
    }

    /// The administrator account.
    pub fn admin(&self) -> Address {
        self.admin.get_or_revert_with(Error::NotAdmin)
    }

    /// Fee per act, basis points.
    pub fn fee_bps(&self) -> u32 {
        self.fee_bps.get_or_default()
    }

    /// Fees kept in the contract, not yet withdrawn (motes).
    pub fn fees_collected(&self) -> U512 {
        self.fees_collected.get_or_default()
    }

    /// The cap the code enforces on `set_fee`, basis points.
    pub fn fee_cap_bps(&self) -> u32 {
        FEE_CAP_BPS
    }

    /// Block time as the contract sees it (ms).
    pub fn now(&self) -> u64 {
        self.env().get_block_time()
    }

    // ----------------------------------------------------------------- helpers

    fn require_admin(&self) {
        if self.env().caller() != self.admin.get_or_revert_with(Error::NotAdmin) {
            self.env().revert(Error::NotAdmin);
        }
    }

    fn load_open(&self, id: u64) -> Escrow {
        let e = self.escrows.get(&id).unwrap_or_else(|| self.env().revert(Error::NotFound));
        if e.status != status::OPEN {
            self.env().revert(Error::AlreadyClosed);
        }
        e
    }
}

/// Lowercase hex SHA-256.
fn hex_sha256(data: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};

    const CSPR: u64 = 1_000_000_000;
    const HOUR: u64 = 3_600_000;
    const KEY: &str = "la paie de novembre est constatee";
    const KEY_HASH: &str = "condition";

    fn hash_of(key: &str) -> String {
        hex_sha256(key.as_bytes())
    }

    fn setup() -> (HostEnv, DareskroEscrowHostRef, Address, Address, Address, Address) {
        let env = odra_test::env();
        let admin = env.get_account(0);
        let payer = env.get_account(1);
        let beneficiary = env.get_account(2);
        let stranger = env.get_account(3);
        env.set_caller(admin);
        let contract = DareskroEscrow::deploy(&env, NoArgs);
        (env, contract, admin, payer, beneficiary, stranger)
    }

    fn create(
        env: &HostEnv,
        c: &mut DareskroEscrowHostRef,
        payer: Address,
        beneficiary: Address,
        amount: u64,
        release_after: u64,
        cancel_after: u64,
        condition: Option<String>,
    ) -> u64 {
        env.set_caller(payer);
        c.with_tokens(U512::from(amount)).create(
            beneficiary,
            release_after,
            cancel_after,
            condition,
            "sha256:e1537eda".to_string(),
        )
    }

    #[test]
    fn deployer_is_admin_and_oracle_with_zero_fee() {
        let (_env, c, admin, ..) = setup();
        assert_eq!(c.admin(), admin);
        assert_eq!(c.oracle(), admin);
        assert_eq!(c.fee_bps(), 0);
        assert_eq!(c.fee_cap_bps(), 100);
        assert_eq!(c.count(), 0);
    }

    #[test]
    fn oracle_releases_after_the_date_to_the_written_beneficiary() {
        let (env, mut c, admin, payer, beneficiary, _) = setup();
        let now = env.block_time();
        let id = create(&env, &mut c, payer, beneficiary, 10 * CSPR, now + HOUR, 0, None);
        assert_eq!(id, 1);
        assert_eq!(env.balance_of(&c), U512::from(10 * CSPR));
        let before = env.balance_of(&beneficiary);

        env.advance_block_time(HOUR);
        env.set_caller(admin);
        c.release(id, None);

        assert_eq!(env.balance_of(&beneficiary), before + U512::from(10 * CSPR));
        assert_eq!(env.balance_of(&c), U512::zero());
        let e = c.get_escrow(id).unwrap();
        assert_eq!(e.status, status::RELEASED);
        assert_eq!(e.closed_by, Some(admin));
        assert_eq!(e.fulfillment, None);
        assert!(env.emitted_event(
            &c,
            Released {
                id,
                by: admin,
                paid: U512::from(10 * CSPR),
                fee: U512::zero(),
                by_condition: false
            }
        ));
    }

    #[test]
    fn release_too_early_is_refused() {
        let (env, mut c, admin, payer, beneficiary, _) = setup();
        let now = env.block_time();
        let id = create(&env, &mut c, payer, beneficiary, 10 * CSPR, now + HOUR, 0, None);
        env.set_caller(admin);
        assert_eq!(c.try_release(id, None).unwrap_err(), Error::TooEarly.into());
        assert_eq!(c.get_escrow(id).unwrap().status, status::OPEN);
        assert_eq!(env.balance_of(&c), U512::from(10 * CSPR));
    }

    #[test]
    fn wrong_key_is_refused_even_after_the_date() {
        let (env, mut c, _admin, payer, beneficiary, stranger) = setup();
        let now = env.block_time();
        let id = create(&env, &mut c, payer, beneficiary, 10 * CSPR, now + HOUR, 0, None);
        env.advance_block_time(HOUR);
        // a stranger
        env.set_caller(stranger);
        assert_eq!(c.try_release(id, None).unwrap_err(), Error::NotAuthorized.into());
        // the beneficiary itself
        env.set_caller(beneficiary);
        assert_eq!(c.try_release(id, None).unwrap_err(), Error::NotAuthorized.into());
        // the payer itself
        env.set_caller(payer);
        assert_eq!(c.try_release(id, None).unwrap_err(), Error::NotAuthorized.into());
        assert_eq!(env.balance_of(&c), U512::from(10 * CSPR));
    }

    #[test]
    fn the_key_releases_without_the_oracle_and_is_recorded() {
        let (env, mut c, _admin, payer, beneficiary, stranger) = setup();
        let now = env.block_time();
        let id = create(
            &env,
            &mut c,
            payer,
            beneficiary,
            10 * CSPR,
            now,
            0,
            Some(hash_of(KEY)),
        );
        let before = env.balance_of(&beneficiary);
        env.set_caller(stranger);
        c.release(id, Some(KEY.to_string()));
        assert_eq!(env.balance_of(&beneficiary), before + U512::from(10 * CSPR));
        let e = c.get_escrow(id).unwrap();
        assert_eq!(e.status, status::RELEASED);
        assert_eq!(e.closed_by, Some(stranger));
        assert_eq!(e.fulfillment, Some(KEY.to_string()));
    }

    #[test]
    fn wrong_condition_is_refused() {
        let (env, mut c, admin, payer, beneficiary, stranger) = setup();
        let now = env.block_time();
        let id = create(
            &env,
            &mut c,
            payer,
            beneficiary,
            10 * CSPR,
            now,
            0,
            Some(hash_of(KEY)),
        );
        env.set_caller(stranger);
        assert_eq!(
            c.try_release(id, Some("mauvaise cle".to_string())).unwrap_err(),
            Error::WrongFulfillment.into()
        );
        // a wrong key offered by the oracle is refused too: the oracle must not pretend
        env.set_caller(admin);
        assert_eq!(
            c.try_release(id, Some("mauvaise cle".to_string())).unwrap_err(),
            Error::WrongFulfillment.into()
        );
        // the oracle without any key still releases
        c.release(id, None);
        assert_eq!(c.get_escrow(id).unwrap().fulfillment, None);
    }

    #[test]
    fn the_condition_does_not_override_the_date() {
        let (env, mut c, _admin, payer, beneficiary, stranger) = setup();
        let now = env.block_time();
        let id = create(
            &env,
            &mut c,
            payer,
            beneficiary,
            10 * CSPR,
            now + HOUR,
            0,
            Some(hash_of(KEY)),
        );
        env.set_caller(stranger);
        assert_eq!(
            c.try_release(id, Some(KEY.to_string())).unwrap_err(),
            Error::TooEarly.into()
        );
    }

    #[test]
    fn refund_after_the_cancel_date_goes_to_the_payer_only() {
        let (env, mut c, _admin, payer, beneficiary, stranger) = setup();
        let now = env.block_time();
        let id = create(&env, &mut c, payer, beneficiary, 10 * CSPR, now + HOUR, now + 2 * HOUR, None);
        let payer_before = env.balance_of(&payer);
        // too early
        env.set_caller(payer);
        assert_eq!(c.try_refund(id).unwrap_err(), Error::CancelTooEarly.into());
        env.advance_block_time(HOUR);
        assert_eq!(c.try_refund(id).unwrap_err(), Error::CancelTooEarly.into());
        // after the date, anyone may ask; the money goes to the payer
        env.advance_block_time(HOUR);
        env.set_caller(stranger);
        c.refund(id);
        assert_eq!(env.balance_of(&payer), payer_before + U512::from(10 * CSPR));
        let e = c.get_escrow(id).unwrap();
        assert_eq!(e.status, status::REFUNDED);
        assert_eq!(e.closed_by, Some(stranger));
        // closed twice: no
        env.set_caller(_admin);
        assert_eq!(c.try_release(id, None).unwrap_err(), Error::AlreadyClosed.into());
        assert_eq!(c.try_refund(id).unwrap_err(), Error::AlreadyClosed.into());
    }

    #[test]
    fn without_a_cancel_date_nobody_takes_it_back() {
        let (env, mut c, admin, payer, beneficiary, _) = setup();
        let now = env.block_time();
        let id = create(&env, &mut c, payer, beneficiary, 10 * CSPR, now + HOUR, 0, None);
        env.advance_block_time(100 * HOUR);
        for who in [payer, beneficiary, admin] {
            env.set_caller(who);
            assert_eq!(c.try_refund(id).unwrap_err(), Error::NotCancellable.into());
        }
    }

    #[test]
    fn fee_per_act_is_capped_by_the_code() {
        let (env, mut c, admin, payer, beneficiary, stranger) = setup();
        env.set_caller(stranger);
        assert_eq!(c.try_set_fee(10).unwrap_err(), Error::NotAdmin.into());
        env.set_caller(admin);
        assert_eq!(c.try_set_fee(101).unwrap_err(), Error::FeeTooHigh.into());
        assert_eq!(c.try_set_fee(10_000).unwrap_err(), Error::FeeTooHigh.into());
        c.set_fee(100);
        assert_eq!(c.fee_bps(), 100);

        let now = env.block_time();
        let id = create(&env, &mut c, payer, beneficiary, 200 * CSPR, now, 0, None);
        let before = env.balance_of(&beneficiary);
        env.set_caller(admin);
        c.release(id, None);
        assert_eq!(env.balance_of(&beneficiary), before + U512::from(198 * CSPR));
        assert_eq!(c.fees_collected(), U512::from(2 * CSPR));
        assert_eq!(c.get_escrow(id).unwrap().fee_paid, U512::from(2 * CSPR));
        assert_eq!(env.balance_of(&c), U512::from(2 * CSPR));

        env.set_caller(stranger);
        assert_eq!(c.try_withdraw_fees(stranger).unwrap_err(), Error::NotAdmin.into());
        env.set_caller(admin);
        let admin_before = env.balance_of(&admin);
        assert_eq!(c.withdraw_fees(admin), U512::from(2 * CSPR));
        assert_eq!(env.balance_of(&admin), admin_before + U512::from(2 * CSPR));
        assert_eq!(c.try_withdraw_fees(admin).unwrap_err(), Error::NothingToWithdraw.into());
        // back to zero: the next release pays everything
        c.set_fee(0);
        let id2 = create(&env, &mut c, payer, beneficiary, 10 * CSPR, now, 0, None);
        env.set_caller(admin);
        c.release(id2, None);
        assert_eq!(c.get_escrow(id2).unwrap().fee_paid, U512::zero());
    }

    #[test]
    fn a_fee_set_after_the_creation_applies_at_release() {
        // the fee is read at the act, not frozen at creation: documented behaviour
        let (env, mut c, admin, payer, beneficiary, _) = setup();
        let now = env.block_time();
        let id = create(&env, &mut c, payer, beneficiary, 100 * CSPR, now, 0, None);
        env.set_caller(admin);
        c.set_fee(50);
        c.release(id, None);
        assert_eq!(c.fees_collected(), U512::from(CSPR / 2));
    }

    #[test]
    fn set_oracle_moves_the_right_to_release() {
        let (env, mut c, admin, payer, beneficiary, stranger) = setup();
        env.set_caller(stranger);
        assert_eq!(c.try_set_oracle(stranger).unwrap_err(), Error::NotAdmin.into());
        env.set_caller(admin);
        c.set_oracle(stranger);
        let now = env.block_time();
        let id = create(&env, &mut c, payer, beneficiary, 10 * CSPR, now, 0, None);
        env.set_caller(admin);
        assert_eq!(c.try_release(id, None).unwrap_err(), Error::NotAuthorized.into());
        env.set_caller(stranger);
        c.release(id, None);
    }

    #[test]
    fn bad_inputs_are_refused_at_creation() {
        let (env, mut c, _admin, payer, beneficiary, _) = setup();
        let now = env.block_time();
        env.set_caller(payer);
        assert_eq!(
            c.with_tokens(U512::zero())
                .try_create(beneficiary, now, 0, None, "m".to_string())
                .unwrap_err(),
            Error::ZeroAmount.into()
        );
        assert_eq!(
            c.with_tokens(U512::from(CSPR))
                .try_create(beneficiary, now + HOUR, now + HOUR, None, "m".to_string())
                .unwrap_err(),
            Error::BadDates.into()
        );
        assert_eq!(
            c.with_tokens(U512::from(CSPR))
                .try_create(beneficiary, now, 0, Some("abc".to_string()), "m".to_string())
                .unwrap_err(),
            Error::BadCondition.into()
        );
        assert_eq!(
            c.with_tokens(U512::from(CSPR))
                .try_create(beneficiary, now, 0, Some(hash_of(KEY).to_uppercase()), "m".to_string())
                .unwrap_err(),
            Error::BadCondition.into()
        );
        assert_eq!(c.count(), 0);
        assert_eq!(c.get_escrow(1), None);
        assert_eq!(c.try_release(42, None).unwrap_err(), Error::NotFound.into());
        let _ = KEY_HASH;
    }

    #[test]
    fn sha256_matches_the_standard_vector() {
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
