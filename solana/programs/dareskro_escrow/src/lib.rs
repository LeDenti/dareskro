//! dareskro on Solana — the escrow is a program account that nobody owns.
//!
//! On the XRP Ledger, `EscrowCreate` is a native transaction: the ledger holds
//! the money. Solana has no native escrow, so this program *is* the escrow. Its
//! guarantees are the ones dareskro measured on XRPL, written as code:
//!
//! * the money goes to the `destination` written at creation — `finish` has no
//!   field for another address, whoever calls it;
//! * before `finish_after`, `finish` is refused by the cluster's clock
//!   (`Clock::unix_timestamp`), not by a promise;
//! * an escrow without `cancel_after` can never be cancelled, not even by the
//!   owner — the payroll shape, one possible outcome;
//! * an escrow with a `condition` (sha256 of a secret) is released only by the
//!   secret, and the secret becomes public on the ledger in that same call
//!   (PREIMAGE-SHA-256, as on XRPL);
//! * several escrows in one transaction are locked under one signature, all or
//!   nothing — a Solana transaction is atomic, no special instruction needed
//!   (the counterpart of the XLS-56 Batch dareskro used for net pay +
//!   contributions + income tax).
//!
//! Who holds the funds: a PDA of this program, one per escrow. Native SOL sits
//! in the escrow account itself; an SPL token (USDC…) sits in a vault token
//! account whose authority is that PDA. The program has no admin instruction
//! over the parties' funds: once the upgrade authority is revoked, the only
//! moves left are the ones below.
//!
//! A fee per act (same rule as the NEAR contract): the service may charge each
//! `create`, `create_token` and `vault_create` a percentage of the SOL locked
//! with a floor (a token escrow, which locks no SOL, pays the floor). It is paid
//! by the owner **on top of** the amount locked — what the destination will
//! receive is never touched — and it is zero unless the administrator account
//! sets it (`set_fee`). Two constants compiled here cap the schedule whoever
//! administers: `MAX_FEE_BPS` = 100 (1 %) and `MAX_FEE_MIN` = 0.01 SOL. The fee
//! sits in the `FeeConfig` account and is withdrawn by the administrator in one
//! call (`withdraw_fees`); release, cancel, vote and the deadline cost nothing.
//! The schedule account is created once, by the program's upgrade authority.
//!
//! Times are Unix seconds, as `Clock::get()?.unix_timestamp`.
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash as sha256;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu");

#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const MAX_MEMOS: u8 = 3;
#[constant]
pub const MAX_MEMO_LEN: u16 = 128;
#[constant]
pub const MAX_FULFILLMENT_LEN: u16 = 64;
#[constant]
pub const STATEMENT_SEED: &[u8] = b"statement";
#[constant]
pub const MAX_CIPHERTEXT: u16 = 8192;
#[constant]
pub const MAX_READERS: u8 = 6;
#[constant]
pub const SHARED_SEED: &[u8] = b"shared";
#[constant]
pub const MAX_PARTIES: u8 = 5;
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
/// the fee can never exceed 1 % of what is locked…
#[constant]
pub const MAX_FEE_BPS: u16 = 100;
/// …nor a floor of 0.01 SOL, whoever administers
#[constant]
pub const MAX_FEE_MIN: u64 = 10_000_000;
#[constant]
pub const POOL_SEED: &[u8] = b"pool";
#[constant]
pub const ADVANCE_SEED: &[u8] = b"advance";
pub const MAX_LENDERS: u8 = 5;
pub const MAX_EXPOSURES: u8 = 8;

#[program]
pub mod dareskro_escrow {
    use super::*;

    /// Lock `amount` lamports for `destination`. `id` is chosen by the owner
    /// (any u64 they have not used yet); the escrow's address is derived from
    /// the owner and that id, so the desk can find it again without an index.
    pub fn create(
        ctx: Context<Create>,
        id: u64,
        destination: Pubkey,
        amount: u64,
        finish_after: Option<i64>,
        cancel_after: Option<i64>,
        condition: Option<[u8; 32]>,
        memos: Vec<String>,
    ) -> Result<()> {
        check_shape(amount, finish_after, cancel_after, &memos, destination)?;
        let now = Clock::get()?.unix_timestamp;
        let escrow = &mut ctx.accounts.escrow;
        escrow.fill(
            ctx.accounts.owner.key(),
            destination,
            None,
            amount,
            finish_after,
            cancel_after,
            condition,
            memos,
            now,
            id,
            ctx.bumps.escrow,
        );
        // the lamports live in the escrow account itself, on top of its rent
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: escrow.to_account_info(),
                },
            ),
            amount,
        )?;
        let fee = charge_fee(
            &mut ctx.accounts.config,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            amount,
        )?;
        emit!(Created::from(&**escrow, escrow.key(), fee));
        Ok(())
    }

    /// Same, for an SPL token (Token or Token-2022): `amount` is in the mint's
    /// base units and is moved from the owner's token account into a vault
    /// whose only authority is the escrow PDA.
    pub fn create_token(
        ctx: Context<CreateToken>,
        id: u64,
        destination: Pubkey,
        amount: u64,
        finish_after: Option<i64>,
        cancel_after: Option<i64>,
        condition: Option<[u8; 32]>,
        memos: Vec<String>,
    ) -> Result<()> {
        check_shape(amount, finish_after, cancel_after, &memos, destination)?;
        let now = Clock::get()?.unix_timestamp;
        let escrow = &mut ctx.accounts.escrow;
        escrow.fill(
            ctx.accounts.owner.key(),
            destination,
            Some(ctx.accounts.mint.key()),
            amount,
            finish_after,
            cancel_after,
            condition,
            memos,
            now,
            id,
            ctx.bumps.escrow,
        );
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.owner_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        // a token escrow locks no SOL: it pays the floor of the schedule
        let fee = charge_fee(
            &mut ctx.accounts.config,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            0,
        )?;
        emit!(Created::from(&**escrow, escrow.key(), fee));
        Ok(())
    }

    /// Release the escrow to its destination. Anyone may call it; the only
    /// questions are *when* (the clock) and, with a condition, *whether* (the
    /// secret). There is no parameter for where the money goes.
    pub fn finish(ctx: Context<Finish>, fulfillment: Option<Vec<u8>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let caller = ctx.accounts.caller.key();
        let escrow = &mut ctx.accounts.escrow;
        escrow.release(now, caller, fulfillment)?;
        let amount = escrow.amount;
        // program-owned account: debit it directly, credit the destination
        escrow.sub_lamports(amount)?;
        ctx.accounts.destination.add_lamports(amount)?;
        emit!(Finished {
            escrow: escrow.key(),
            by: caller,
            to: escrow.destination,
            amount,
            fulfillment: escrow.fulfillment.clone(),
        });
        Ok(())
    }

    /// Same, for a token escrow: the vault pays a token account owned by the
    /// destination, then the vault is closed and its rent goes back to the owner.
    pub fn finish_token(ctx: Context<FinishToken>, fulfillment: Option<Vec<u8>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let caller = ctx.accounts.caller.key();
        let escrow = &mut ctx.accounts.escrow;
        escrow.release(now, caller, fulfillment)?;
        let amount = escrow.amount;
        // the vault's whole balance, not `amount`: anyone can drop a unit into the vault,
        // and the Token program refuses to close a non-empty account. Whatever landed
        // there goes to the destination with the pay; nothing can jam the escrow.
        let in_vault = ctx.accounts.vault.amount;
        require!(in_vault >= amount, EscrowError::VaultShort);
        let (owner, id, bump) = (escrow.owner, escrow.id.to_le_bytes(), [escrow.bump]);
        let seeds: &[&[u8]] = &[ESCROW_SEED, owner.as_ref(), &id, &bump];
        pay_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.destination_token,
            &ctx.accounts.owner_account,
            &escrow.to_account_info(),
            seeds,
            in_vault,
        )?;
        emit!(Finished {
            escrow: escrow.key(),
            by: caller,
            to: escrow.destination,
            amount,
            fulfillment: escrow.fulfillment.clone(),
        });
        Ok(())
    }

    /// Refund the owner, only after `cancel_after`. An escrow created without
    /// `cancel_after` cannot be cancelled by anyone, the owner included.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let caller = ctx.accounts.caller.key();
        let escrow = &mut ctx.accounts.escrow;
        escrow.refund(now, caller)?;
        let amount = escrow.amount;
        escrow.sub_lamports(amount)?;
        ctx.accounts.owner_account.add_lamports(amount)?;
        emit!(Cancelled { escrow: escrow.key(), by: caller, to: escrow.owner, amount });
        Ok(())
    }

    /// Same, for a token escrow.
    pub fn cancel_token(ctx: Context<CancelToken>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let caller = ctx.accounts.caller.key();
        let escrow = &mut ctx.accounts.escrow;
        escrow.refund(now, caller)?;
        let amount = escrow.amount;
        let in_vault = ctx.accounts.vault.amount; // same rule as finish_token: empty the vault
        require!(in_vault >= amount, EscrowError::VaultShort);
        let (owner, id, bump) = (escrow.owner, escrow.id.to_le_bytes(), [escrow.bump]);
        let seeds: &[&[u8]] = &[ESCROW_SEED, owner.as_ref(), &id, &bump];
        pay_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.owner_token,
            &ctx.accounts.owner_account,
            &escrow.to_account_info(),
            seeds,
            in_vault,
        )?;
        emit!(Cancelled { escrow: escrow.key(), by: caller, to: escrow.owner, amount });
        Ok(())
    }

    /// Once an escrow is Finished or Cancelled, its record stays readable on
    /// chain (status, who closed it, the revealed secret). The owner may delete
    /// it and take the rent back; a Locked escrow cannot be deleted.
    pub fn close(_ctx: Context<Close>) -> Result<()> {
        Ok(())
    }

    // ------------------------------------------------------- the shared vault

    /// A deposit several parties decide on together — a rental deposit: tenant
    /// (owner), landlord (beneficiary), a mediator; 2 of 3. The owner funds it.
    /// Each party votes an amount for the beneficiary, the rest returns to the
    /// owner; when `threshold` parties have voted the same amount, that call
    /// pays. After `deadline`, with no decision, anyone may return everything to
    /// the owner (the rule of a deposit nobody claimed).
    #[allow(clippy::too_many_arguments)]
    pub fn vault_create(
        ctx: Context<VaultCreate>,
        id: u64,
        beneficiary: Pubkey,
        amount: u64,
        parties: Vec<Pubkey>,
        threshold: u8,
        deadline: Option<i64>,
        memos: Vec<String>,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(beneficiary != Pubkey::default(), EscrowError::NoDestination);
        require!(
            parties.len() >= 2 && parties.len() <= MAX_PARTIES as usize,
            EscrowError::BadParties
        );
        require!(
            threshold >= 1 && (threshold as usize) <= parties.len(),
            EscrowError::BadThreshold
        );
        for (i, p) in parties.iter().enumerate() {
            require!(!parties[..i].contains(p), EscrowError::DuplicateParty);
        }
        require!(memos.len() <= MAX_MEMOS as usize, EscrowError::TooManyMemos);
        require!(
            memos.iter().all(|m| m.len() <= MAX_MEMO_LEN as usize),
            EscrowError::MemoTooLong
        );
        let now = Clock::get()?.unix_timestamp;
        if let Some(d) = deadline {
            require!(d > now, EscrowError::DeadlinePassed);
        }
        let v = &mut ctx.accounts.vault;
        v.owner = ctx.accounts.owner.key();
        v.beneficiary = beneficiary;
        v.amount = amount;
        v.threshold = threshold;
        v.parties = parties;
        v.votes = Vec::new();
        v.deadline = deadline;
        v.memos = memos;
        v.status = Status::Locked;
        v.paid_to_beneficiary = 0;
        v.created_at = now;
        v.closed_at = None;
        v.closed_by = None;
        v.id = id;
        v.bump = ctx.bumps.vault;
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: v.to_account_info(),
                },
            ),
            amount,
        )?;
        let fee = charge_fee(
            &mut ctx.accounts.config,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            amount,
        )?;
        let v = &ctx.accounts.vault;
        emit!(VaultCreated {
            vault: v.key(),
            owner: v.owner,
            beneficiary,
            amount,
            threshold,
            parties: v.parties.clone(),
            deadline,
            id,
            fee,
        });
        Ok(())
    }

    // ---------------------------------------------------------- the fee per act

    /// The schedule account, once per program, by the upgrade authority. Starts
    /// at zero: until `set_fee`, an act costs nothing beyond its rent and gas.
    pub fn config_init(ctx: Context<ConfigInit>, admin: Pubkey) -> Result<()> {
        require!(admin != Pubkey::default(), EscrowError::NoDestination);
        let c = &mut ctx.accounts.config;
        c.admin = admin;
        c.fee_bps = 0;
        c.fee_min = 0;
        c.fees_held = 0;
        c.fees_total = 0;
        c.acts_charged = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// The administrator sets the schedule, under the two ceilings compiled above.
    pub fn set_fee(ctx: Context<AdminOnly>, fee_bps: u16, fee_min: u64) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeAboveCeiling);
        require!(fee_min <= MAX_FEE_MIN, EscrowError::FeeAboveCeiling);
        let c = &mut ctx.accounts.config;
        c.fee_bps = fee_bps;
        c.fee_min = fee_min;
        emit!(FeeSet { admin: c.admin, fee_bps, fee_min });
        Ok(())
    }

    /// Hand the role over (dareskro.near's counterpart on Solana).
    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default(), EscrowError::NoDestination);
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    /// Everything charged so far goes to the administrator; the account keeps its rent.
    pub fn withdraw_fees(ctx: Context<AdminOnly>) -> Result<()> {
        let amount = ctx.accounts.config.fees_held;
        require!(amount > 0, EscrowError::NothingToWithdraw);
        ctx.accounts.config.fees_held = 0;
        ctx.accounts.config.sub_lamports(amount)?;
        ctx.accounts.admin.add_lamports(amount)?;
        emit!(FeesWithdrawn { admin: ctx.accounts.admin.key(), amount });
        Ok(())
    }

    /// One party's vote: `to_beneficiary` lamports for the beneficiary, the rest
    /// back to the owner. A party may change its vote while the vault is Locked.
    /// The vote that reaches the threshold pays, in the same call.
    pub fn vault_vote(ctx: Context<VaultVote>, to_beneficiary: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let party = ctx.accounts.party.key();
        let v = &mut ctx.accounts.vault;
        require!(v.status == Status::Locked, EscrowError::AlreadyClosed);
        require!(v.parties.contains(&party), EscrowError::NotAParty);
        require!(to_beneficiary <= v.amount, EscrowError::AmountExceeds);
        v.votes.retain(|x| x.party != party);
        v.votes.push(Vote { party, to_beneficiary });
        let agree = v.votes.iter().filter(|x| x.to_beneficiary == to_beneficiary).count();
        if agree >= v.threshold as usize {
            let amount = v.amount;
            let to_owner = amount - to_beneficiary;
            v.status = Status::Finished;
            v.closed_at = Some(now);
            v.closed_by = Some(party);
            v.paid_to_beneficiary = to_beneficiary;
            v.sub_lamports(amount)?;
            ctx.accounts.beneficiary.add_lamports(to_beneficiary)?;
            ctx.accounts.owner_account.add_lamports(to_owner)?;
            emit!(VaultDecided {
                vault: v.key(),
                by: party,
                to_beneficiary,
                to_owner,
                votes: agree as u8,
                timeout: false,
            });
        }
        Ok(())
    }

    /// Past the deadline with no decision: anyone may return the whole deposit to the owner.
    pub fn vault_timeout(ctx: Context<VaultTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let caller = ctx.accounts.caller.key();
        let v = &mut ctx.accounts.vault;
        require!(v.status == Status::Locked, EscrowError::AlreadyClosed);
        let d = v.deadline.ok_or(EscrowError::NoDeadline)?;
        require!(now >= d, EscrowError::DeadlineNotReached);
        let amount = v.amount;
        v.status = Status::Cancelled;
        v.closed_at = Some(now);
        v.closed_by = Some(caller);
        v.paid_to_beneficiary = 0;
        v.sub_lamports(amount)?;
        ctx.accounts.owner_account.add_lamports(amount)?;
        emit!(VaultDecided {
            vault: v.key(),
            by: caller,
            to_beneficiary: 0,
            to_owner: amount,
            votes: 0,
            timeout: true,
        });
        Ok(())
    }

    /// The owner deletes a decided vault and takes the rent back; a Locked one stays.
    pub fn vault_close(_ctx: Context<VaultClose>) -> Result<()> {
        Ok(())
    }

    // ------------------------------------------------------- the sealed statement

    /// The pay statement itself, sealed next to its escrow. Public: its SHA-256
    /// (the one the escrow memo already carries), the ciphertext's size class and
    /// hash, the list of who may read it. Private: everything else. The content
    /// key is AES-256-GCM; it is wrapped once per reader (X25519 + HKDF + GCM, as
    /// `agent/confidentiel.mjs` does on XRPL). Only the escrow's owner may seal.
    /// The ciphertext comes afterwards in chunks (a transaction is 1 232 bytes),
    /// and `finalize_statement` checks its hash before the record counts as sealed.
    #[allow(clippy::too_many_arguments)]
    pub fn seal_statement(
        ctx: Context<SealStatement>,
        sha256_plain: [u8; 32],
        sha256_cipher: [u8; 32],
        cipher_len: u32,
        iv: [u8; 12],
        tag: [u8; 16],
        uri: String,
        readers: Vec<Reader>,
        token: Option<Pubkey>,
    ) -> Result<()> {
        require!(cipher_len as usize <= MAX_CIPHERTEXT as usize, EscrowError::CiphertextTooLong);
        require!(cipher_len > 0 || !uri.is_empty(), EscrowError::NoContent);
        require!(uri.len() <= 128, EscrowError::UriTooLong);
        require!(!readers.is_empty() && readers.len() <= MAX_READERS as usize, EscrowError::TooManyReaders);
        require!(readers.iter().all(|r| r.role.len() <= 16), EscrowError::RoleTooLong);
        let st = &mut ctx.accounts.statement;
        st.escrow = ctx.accounts.escrow.key();
        st.owner = ctx.accounts.owner.key();
        st.sha256_plain = sha256_plain;
        st.sha256_cipher = sha256_cipher;
        st.cipher_len = cipher_len;
        st.iv = iv;
        st.tag = tag;
        st.ciphertext = Vec::new();
        st.uri = uri;
        st.token = token;
        st.readers = readers;
        st.sealed = cipher_len == 0; // nothing to write: the content lives at `uri`
        st.created_at = Clock::get()?.unix_timestamp;
        st.bump = ctx.bumps.statement;
        emit!(StatementSealed { statement: st.key(), escrow: st.escrow, sha256_plain, readers: st.readers.len() as u8, sealed: st.sealed });
        Ok(())
    }

    /// One chunk of the ciphertext, in order. Refused once the record is sealed.
    pub fn write_ciphertext(ctx: Context<WriteStatement>, offset: u32, data: Vec<u8>) -> Result<()> {
        let st = &mut ctx.accounts.statement;
        require!(!st.sealed, EscrowError::StatementSealed);
        require!(offset as usize == st.ciphertext.len(), EscrowError::BadChunk);
        require!(offset as usize + data.len() <= st.cipher_len as usize, EscrowError::BadChunk);
        st.ciphertext.extend_from_slice(&data);
        Ok(())
    }

    /// The ciphertext is complete and hashes to what `seal_statement` announced:
    /// from now on nothing in the record can change but the list of readers.
    pub fn finalize_statement(ctx: Context<WriteStatement>) -> Result<()> {
        let st = &mut ctx.accounts.statement;
        require!(!st.sealed, EscrowError::StatementSealed);
        require!(st.ciphertext.len() == st.cipher_len as usize, EscrowError::CipherIncomplete);
        require!(sha256(&st.ciphertext).to_bytes() == st.sha256_cipher, EscrowError::CipherHashMismatch);
        st.sealed = true;
        emit!(StatementSealed { statement: st.key(), escrow: st.escrow, sha256_plain: st.sha256_plain, readers: st.readers.len() as u8, sealed: true });
        Ok(())
    }

    /// A new reader (a pension fund that got its key…): the owner wraps the same
    /// content key for them. Nothing is re-encrypted, nobody else is affected.
    pub fn add_reader(ctx: Context<WriteStatement>, reader: Reader) -> Result<()> {
        let st = &mut ctx.accounts.statement;
        require!(st.readers.len() < MAX_READERS as usize, EscrowError::TooManyReaders);
        require!(reader.role.len() <= 16, EscrowError::RoleTooLong);
        require!(st.readers.iter().all(|r| r.key != reader.key), EscrowError::ReaderExists);
        st.readers.push(reader);
        Ok(())
    }
    // ------------------------------------------------------ the invoice advance

    /// A lending pool decided by `threshold` of `signers` (the AI seat, the risk
    /// policy, the operator), whose ceilings are **held by the program**: on XRPL
    /// the pool's 2-of-3 account could overrule its own policy (two signers
    /// passed a 33.8 % concentration, the ledger knew no cap); here the cap is
    /// in `policy`, checked at the moment the advance is paid, whoever signed.
    pub fn pool_create(
        ctx: Context<PoolCreate>,
        id: u64,
        signers: Vec<Pubkey>,
        threshold: u8,
        policy: PoolPolicy,
    ) -> Result<()> {
        require!(
            signers.len() >= 2 && signers.len() <= MAX_PARTIES as usize,
            EscrowError::BadParties
        );
        require!(
            threshold >= 1 && (threshold as usize) <= signers.len(),
            EscrowError::BadThreshold
        );
        for (i, p) in signers.iter().enumerate() {
            require!(!signers[..i].contains(p), EscrowError::DuplicateParty);
        }
        require!(
            policy.max_share_bps >= 1
                && policy.max_share_bps <= 10_000
                && policy.max_advance_bps >= 1
                && policy.max_advance_bps <= 10_000
                && policy.max_term > 0
                && policy.grace >= 0,
            EscrowError::BadPolicy
        );
        let p = &mut ctx.accounts.pool;
        p.operator = ctx.accounts.operator.key();
        p.signers = signers;
        p.threshold = threshold;
        p.policy = policy;
        p.capital = 0;
        p.deposits = 0;
        p.outstanding = 0;
        p.losses = 0;
        p.fees_earned = 0;
        p.advances_funded = 0;
        p.lenders = Vec::new();
        p.exposures = Vec::new();
        p.id = id;
        p.created_at = Clock::get()?.unix_timestamp;
        p.bump = ctx.bumps.pool;
        emit!(PoolCreated { pool: p.key(), operator: p.operator, signers: p.signers.clone(), threshold, policy, id });
        Ok(())
    }

    /// A lender funds the pool. Lamports go to the pool account; the book
    /// (`capital`, `deposits`) records the claim.
    pub fn pool_deposit(ctx: Context<PoolDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        let lender = ctx.accounts.lender.key();
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.lender.to_account_info(),
                    to: ctx.accounts.pool.to_account_info(),
                },
            ),
            amount,
        )?;
        let p = &mut ctx.accounts.pool;
        match p.lenders.iter_mut().find(|l| l.key == lender) {
            Some(l) => l.amount += amount,
            None => {
                require!(p.lenders.len() < MAX_LENDERS as usize, EscrowError::TooManyLenders);
                p.lenders.push(Lender { key: lender, amount });
            }
        }
        p.capital += amount;
        p.deposits += amount;
        emit!(PoolFunded { pool: p.key(), lender, amount, capital: p.capital });
        Ok(())
    }

    /// A lender leaves with its share of the book: deposit × capital ÷ deposits.
    /// A loss written by `advance_default` lowers it, fees earned raise it; only
    /// cash not out on advances can leave.
    pub fn pool_withdraw(ctx: Context<PoolWithdraw>) -> Result<()> {
        let lender = ctx.accounts.lender.key();
        let p = &mut ctx.accounts.pool;
        let i = p.lenders.iter().position(|l| l.key == lender).ok_or(EscrowError::NotALender)?;
        let deposit = p.lenders[i].amount;
        let share = (deposit as u128 * p.capital as u128 / p.deposits as u128) as u64;
        require!(share <= p.capital - p.outstanding, EscrowError::PoolIlliquid);
        p.lenders.remove(i);
        p.deposits -= deposit;
        p.capital -= share;
        p.sub_lamports(share)?;
        ctx.accounts.lender.add_lamports(share)?;
        emit!(PoolWithdrawn { pool: p.key(), lender, deposit, paid: share });
        Ok(())
    }

    /// One signer proposes an advance on an invoice: `invoice` is the SHA-256 of
    /// the canonical dossier (`facture/facture.mjs`, `empreinte`), the same
    /// fingerprint the XRPL version anchors. Shape is checked here; the pool's
    /// ceilings are checked when the threshold is reached, not before, so that a
    /// breach is measured against the signatures themselves.
    #[allow(clippy::too_many_arguments)]
    pub fn advance_propose(
        ctx: Context<AdvancePropose>,
        invoice: [u8; 32],
        supplier: Pubkey,
        debtor: Pubkey,
        face: u64,
        advance: u64,
        fee: u64,
        due: i64,
    ) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        let p = &ctx.accounts.pool;
        require!(p.signers.contains(&signer), EscrowError::NotAParty);
        require!(supplier != Pubkey::default() && debtor != Pubkey::default(), EscrowError::NoDestination);
        require!(face > 0 && advance > 0, EscrowError::ZeroAmount);
        require!(advance <= face, EscrowError::AmountExceeds);
        require!(fee <= face - advance, EscrowError::FeeAboveFace);
        let now = Clock::get()?.unix_timestamp;
        require!(due > now, EscrowError::DeadlinePassed);
        require!(due <= now + p.policy.max_term, EscrowError::TermTooLong);
        let a = &mut ctx.accounts.advance;
        a.pool = p.key();
        a.invoice = invoice;
        a.supplier = supplier;
        a.debtor = debtor;
        a.face = face;
        a.advance = advance;
        a.fee = fee;
        a.due = due;
        a.approvals = vec![signer];
        a.status = AdvanceStatus::Proposed;
        a.repaid = 0;
        a.proposed_by = signer;
        a.created_at = now;
        a.funded_at = None;
        a.closed_at = None;
        a.bump = ctx.bumps.advance;
        emit!(AdvanceProposed { advance: a.key(), pool: a.pool, invoice, supplier, debtor, face, amount: advance, fee, due, by: signer });
        Ok(())
    }

    /// Another signer approves. The approval that reaches the threshold pays the
    /// supplier in the same call — **after** the program checked the pool's
    /// ceilings: advance ≤ `max_advance_bps` of the face, the debtor's exposure
    /// (this advance and its fee included) ≤ `max_share_bps` of the capital, and
    /// cash on hand. Two signers out of three cannot pass what the policy
    /// refuses: the refusal comes from the program, with the signatures valid.
    /// The dareskro fee per act is taken from the pool here, as a cost.
    pub fn advance_approve(ctx: Context<AdvanceApprove>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let signer = ctx.accounts.signer.key();
        let p = &mut ctx.accounts.pool;
        let a = &mut ctx.accounts.advance;
        require!(p.signers.contains(&signer), EscrowError::NotAParty);
        require!(a.status == AdvanceStatus::Proposed, EscrowError::NotProposed);
        require!(!a.approvals.contains(&signer), EscrowError::AlreadyApproved);
        a.approvals.push(signer);
        if a.approvals.len() < p.threshold as usize {
            return Ok(());
        }
        // the ceilings, held by the program
        require!(
            a.advance as u128 * 10_000 <= a.face as u128 * p.policy.max_advance_bps as u128,
            EscrowError::AdvanceAboveCap
        );
        let owed = a.advance + a.fee;
        let already = p.exposures.iter().find(|e| e.debtor == a.debtor).map(|e| e.owed).unwrap_or(0);
        require!(
            (already + owed) as u128 * 10_000 <= p.capital as u128 * p.policy.max_share_bps as u128,
            EscrowError::ConcentrationBreached
        );
        require!(a.advance <= p.capital - p.outstanding, EscrowError::PoolIlliquid);
        // dareskro's fee per act, paid by the pool on top of the advance
        let cfg = &mut ctx.accounts.config;
        let pct = (a.advance as u128 * cfg.fee_bps as u128 / 10_000) as u64;
        let act_fee = pct.max(cfg.fee_min);
        if act_fee > 0 {
            require!(act_fee <= p.capital - p.outstanding - a.advance, EscrowError::PoolIlliquid);
            p.sub_lamports(act_fee)?;
            cfg.add_lamports(act_fee)?;
            cfg.fees_held += act_fee;
            cfg.fees_total += act_fee;
            cfg.acts_charged += 1;
            p.capital -= act_fee;
        }
        // the advance itself
        p.sub_lamports(a.advance)?;
        ctx.accounts.supplier.add_lamports(a.advance)?;
        p.outstanding += a.advance;
        match p.exposures.iter_mut().find(|e| e.debtor == a.debtor) {
            Some(e) => e.owed += owed,
            None => {
                require!(p.exposures.len() < MAX_EXPOSURES as usize, EscrowError::TooManyDebtors);
                p.exposures.push(Exposure { debtor: a.debtor, owed });
            }
        }
        p.advances_funded += 1;
        a.status = AdvanceStatus::Funded;
        a.funded_at = Some(now);
        emit!(AdvanceFunded {
            advance: a.key(),
            pool: p.key(),
            supplier: a.supplier,
            debtor: a.debtor,
            amount: a.advance,
            fee: a.fee,
            by: signer,
            approvals: a.approvals.len() as u8,
            act_fee,
            capital: p.capital,
            outstanding: p.outstanding,
        });
        Ok(())
    }

    /// The debtor (or anyone) pays the invoice into the advance account. Once
    /// advance + fee are covered, the pool is repaid, the fee is booked and
    /// whatever is above goes to the supplier, in the same call.
    pub fn advance_repay(ctx: Context<AdvanceRepay>, amount: u64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.advance.status == AdvanceStatus::Funded, EscrowError::NotFunded);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.advance.to_account_info(),
                },
            ),
            amount,
        )?;
        let p = &mut ctx.accounts.pool;
        let a = &mut ctx.accounts.advance;
        a.repaid += amount;
        let owed = a.advance + a.fee;
        if a.repaid < owed {
            return Ok(());
        }
        let to_supplier = a.repaid - owed;
        a.sub_lamports(a.repaid)?;
        p.add_lamports(owed)?;
        if to_supplier > 0 {
            ctx.accounts.supplier.add_lamports(to_supplier)?;
        }
        p.capital += a.fee;
        p.fees_earned += a.fee;
        p.outstanding -= a.advance;
        release_exposure(p, a.debtor, owed);
        a.status = AdvanceStatus::Repaid;
        a.closed_at = Some(now);
        emit!(AdvanceRepaid { advance: a.key(), pool: p.key(), payer: ctx.accounts.payer.key(), repaid: a.repaid, to_pool: owed, to_supplier, capital: p.capital });
        Ok(())
    }

    /// Past due + grace with the advance not covered, a signer writes the
    /// default: the loss leaves the book (the lenders carry it), what was
    /// partly paid goes to the pool. The program holds nothing of the
    /// supplier's: there is nothing to seize, only `advance_buyback` to offer.
    pub fn advance_default(ctx: Context<AdvanceDefault>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let signer = ctx.accounts.signer.key();
        let p = &mut ctx.accounts.pool;
        let a = &mut ctx.accounts.advance;
        require!(p.signers.contains(&signer), EscrowError::NotAParty);
        require!(a.status == AdvanceStatus::Funded, EscrowError::NotFunded);
        require!(now >= a.due + p.policy.grace, EscrowError::DefaultTooEarly);
        let owed = a.advance + a.fee;
        let loss = a.advance.saturating_sub(a.repaid);
        let fee_got = a.repaid.saturating_sub(a.advance);
        if a.repaid > 0 {
            a.sub_lamports(a.repaid)?;
            p.add_lamports(a.repaid)?;
        }
        p.capital = p.capital - loss + fee_got;
        p.losses += loss;
        p.fees_earned += fee_got;
        p.outstanding -= a.advance;
        release_exposure(p, a.debtor, owed);
        a.status = AdvanceStatus::Defaulted;
        a.closed_at = Some(now);
        emit!(AdvanceDefaulted { advance: a.key(), pool: p.key(), by: signer, loss, recovered: a.repaid, unpaid: owed - a.repaid, capital: p.capital, losses: p.losses });
        Ok(())
    }

    /// The recourse: the supplier (or anyone for it) buys the defaulted invoice
    /// back by paying what is unpaid to the pool. The loss leaves the book.
    pub fn advance_buyback(ctx: Context<AdvanceBuyback>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(ctx.accounts.advance.status == AdvanceStatus::Defaulted, EscrowError::NotDefaulted);
        let owed = ctx.accounts.advance.advance + ctx.accounts.advance.fee;
        let unpaid = owed - ctx.accounts.advance.repaid;
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.pool.to_account_info(),
                },
            ),
            unpaid,
        )?;
        let p = &mut ctx.accounts.pool;
        let a = &mut ctx.accounts.advance;
        let loss = a.advance.saturating_sub(a.repaid);
        p.capital += unpaid;
        p.losses -= loss;
        p.fees_earned += unpaid - loss;
        a.repaid = owed;
        a.status = AdvanceStatus::BoughtBack;
        a.closed_at = Some(now);
        emit!(AdvanceBoughtBack { advance: a.key(), pool: p.key(), payer: ctx.accounts.payer.key(), paid: unpaid, capital: p.capital, losses: p.losses });
        Ok(())
    }

    /// The operator deletes a settled (or never funded) advance record and takes
    /// the rent back; a Funded one stays.
    pub fn advance_close(_ctx: Context<AdvanceClose>) -> Result<()> {
        Ok(())
    }
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Create<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, owner.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FeeConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        constraint = owner_token.owner == owner.key() @ EscrowError::WrongTokenAccount,
        constraint = owner_token.mint == mint.key() @ EscrowError::WrongTokenAccount,
    )]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = owner,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, owner.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = owner,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FeeConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Finish<'info> {
    /// whoever releases: the oracle, the employee, a passer-by
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.owner.as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.mint.is_none() @ EscrowError::WrongRail,
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: it is the destination written at creation, nothing else is accepted
    #[account(mut, address = escrow.destination @ EscrowError::WrongDestination)]
    pub destination: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FinishToken<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.owner.as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.mint == Some(mint.key()) @ EscrowError::WrongRail,
    )]
    pub escrow: Account<'info, Escrow>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// a token account of the right mint owned by the destination (its ATA, usually)
    #[account(
        mut,
        constraint = destination_token.owner == escrow.destination @ EscrowError::WrongDestination,
        constraint = destination_token.mint == mint.key() @ EscrowError::WrongTokenAccount,
    )]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the owner, who gets the vault's rent back
    #[account(mut, address = escrow.owner @ EscrowError::WrongOwner)]
    pub owner_account: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.owner.as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.mint.is_none() @ EscrowError::WrongRail,
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: the owner written at creation, the only possible refund address
    #[account(mut, address = escrow.owner @ EscrowError::WrongOwner)]
    pub owner_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelToken<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.owner.as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.mint == Some(mint.key()) @ EscrowError::WrongRail,
    )]
    pub escrow: Account<'info, Escrow>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        constraint = owner_token.owner == escrow.owner @ EscrowError::WrongOwner,
        constraint = owner_token.mint == mint.key() @ EscrowError::WrongTokenAccount,
    )]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the owner, who gets the vault's rent back
    #[account(mut, address = escrow.owner @ EscrowError::WrongOwner)]
    pub owner_account: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Close<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        has_one = owner @ EscrowError::WrongOwner,
        seeds = [ESCROW_SEED, escrow.owner.as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
        constraint = escrow.status != Status::Locked @ EscrowError::StillLocked,
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct SealStatement<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner @ EscrowError::WrongOwner)]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = owner,
        space = 8 + SealedStatement::INIT_SPACE,
        seeds = [STATEMENT_SEED, escrow.key().as_ref()],
        bump
    )]
    pub statement: Account<'info, SealedStatement>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteStatement<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ EscrowError::WrongOwner,
        seeds = [STATEMENT_SEED, statement.escrow.as_ref()],
        bump = statement.bump,
    )]
    pub statement: Account<'info, SealedStatement>,
}

// --------------------------------------------------------------------- state

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Status {
    Locked,
    Finished,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub owner: Pubkey,
    pub destination: Pubkey,
    /// None = native SOL held by this account; Some = SPL mint held in the vault
    pub mint: Option<Pubkey>,
    /// lamports, or the mint's base units
    pub amount: u64,
    /// no finish before this time (payroll: the pay date)
    pub finish_after: Option<i64>,
    /// from this time on, finish is refused and cancel refunds the owner;
    /// None = nobody can ever cancel
    pub cancel_after: Option<i64>,
    /// sha256 of a secret; finish must bring the secret
    pub condition: Option<[u8; 32]>,
    /// free text written at creation: statement hash, fiat line, oracle…
    #[max_len(3, 128)]
    pub memos: Vec<String>,
    pub status: Status,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub closed_by: Option<Pubkey>,
    /// the secret, once revealed
    #[max_len(64)]
    pub fulfillment: Vec<u8>,
    pub id: u64,
    pub bump: u8,
}

impl Escrow {
    #[allow(clippy::too_many_arguments)]
    fn fill(
        &mut self,
        owner: Pubkey,
        destination: Pubkey,
        mint: Option<Pubkey>,
        amount: u64,
        finish_after: Option<i64>,
        cancel_after: Option<i64>,
        condition: Option<[u8; 32]>,
        memos: Vec<String>,
        now: i64,
        id: u64,
        bump: u8,
    ) {
        self.owner = owner;
        self.destination = destination;
        self.mint = mint;
        self.amount = amount;
        self.finish_after = finish_after;
        self.cancel_after = cancel_after;
        self.condition = condition;
        self.memos = memos;
        self.status = Status::Locked;
        self.created_at = now;
        self.closed_at = None;
        self.closed_by = None;
        self.fulfillment = Vec::new();
        self.id = id;
        self.bump = bump;
    }

    /// The whole decision of `finish`, with no account in sight.
    fn release(&mut self, now: i64, caller: Pubkey, fulfillment: Option<Vec<u8>>) -> Result<()> {
        require!(self.status == Status::Locked, EscrowError::AlreadyClosed);
        if let Some(f) = self.finish_after {
            require!(now >= f, EscrowError::TooEarly);
        }
        if let Some(c) = self.cancel_after {
            require!(now < c, EscrowError::TooLate);
        }
        match (&self.condition, &fulfillment) {
            (None, None) => {}
            (None, Some(_)) => return err!(EscrowError::NoCondition),
            (Some(_), None) => return err!(EscrowError::FulfillmentRequired),
            (Some(cond), Some(f)) => {
                require!(
                    f.len() <= MAX_FULFILLMENT_LEN as usize,
                    EscrowError::FulfillmentTooLong
                );
                require!(sha256(f).to_bytes() == *cond, EscrowError::WrongFulfillment);
            }
        }
        self.status = Status::Finished;
        self.closed_at = Some(now);
        self.closed_by = Some(caller);
        self.fulfillment = fulfillment.unwrap_or_default();
        Ok(())
    }

    /// The whole decision of `cancel`.
    fn refund(&mut self, now: i64, caller: Pubkey) -> Result<()> {
        require!(self.status == Status::Locked, EscrowError::AlreadyClosed);
        let c = self.cancel_after.ok_or(EscrowError::NotCancellable)?;
        require!(now >= c, EscrowError::CancelTooEarly);
        self.status = Status::Cancelled;
        self.closed_at = Some(now);
        self.closed_by = Some(caller);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct VaultCreate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + SharedVault::INIT_SPACE,
        seeds = [SHARED_SEED, owner.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, SharedVault>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FeeConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VaultVote<'info> {
    pub party: Signer<'info>,
    #[account(
        mut,
        seeds = [SHARED_SEED, vault.owner.as_ref(), &vault.id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, SharedVault>,
    /// CHECK: the beneficiary written at creation, nothing else is accepted
    #[account(mut, address = vault.beneficiary @ EscrowError::WrongDestination)]
    pub beneficiary: UncheckedAccount<'info>,
    /// CHECK: the owner written at creation, the only possible refund address
    #[account(mut, address = vault.owner @ EscrowError::WrongOwner)]
    pub owner_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VaultTimeout<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [SHARED_SEED, vault.owner.as_ref(), &vault.id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, SharedVault>,
    /// CHECK: the owner written at creation
    #[account(mut, address = vault.owner @ EscrowError::WrongOwner)]
    pub owner_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VaultClose<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        close = owner,
        has_one = owner @ EscrowError::WrongOwner,
        seeds = [SHARED_SEED, vault.owner.as_ref(), &vault.id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.status != Status::Locked @ EscrowError::StillLocked,
    )]
    pub vault: Account<'info, SharedVault>,
}

/// One party's word on a shared vault: how much goes to the beneficiary.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct Vote {
    pub party: Pubkey,
    pub to_beneficiary: u64,
}

/// A deposit decided by `threshold` of `parties`: lamports held by this account.
#[account]
#[derive(InitSpace)]
pub struct SharedVault {
    pub owner: Pubkey,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub threshold: u8,
    #[max_len(5)]
    pub parties: Vec<Pubkey>,
    #[max_len(5)]
    pub votes: Vec<Vote>,
    /// after it, with no decision, anyone may return the deposit to the owner
    pub deadline: Option<i64>,
    #[max_len(3, 128)]
    pub memos: Vec<String>,
    pub status: Status,
    pub paid_to_beneficiary: u64,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub closed_by: Option<Pubkey>,
    pub id: u64,
    pub bump: u8,
}

/// Who may read the sealed statement: their X25519 public key and the content
/// key wrapped for them (ephemeral public key, GCM nonce, 32 bytes + 16-byte tag).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, InitSpace)]
pub struct Reader {
    #[max_len(16)]
    pub role: String,
    pub key: [u8; 32],
    pub epk: [u8; 32],
    pub iv: [u8; 12],
    pub wrapped: [u8; 48],
}

#[account]
#[derive(InitSpace)]
pub struct SealedStatement {
    pub escrow: Pubkey,
    pub owner: Pubkey,
    /// the statement's SHA-256, the same the escrow memo carries
    pub sha256_plain: [u8; 32],
    /// what the ciphertext must hash to once complete
    pub sha256_cipher: [u8; 32],
    pub cipher_len: u32,
    pub iv: [u8; 12],
    pub tag: [u8; 16],
    /// AES-256-GCM of the statement (padded to a size class), written in chunks
    #[max_len(8192)]
    pub ciphertext: Vec<u8>,
    /// where a larger ciphertext lives instead (optional)
    #[max_len(128)]
    pub uri: String,
    /// the non-transferable token the employee holds for this statement, if any
    pub token: Option<Pubkey>,
    #[max_len(6)]
    pub readers: Vec<Reader>,
    pub sealed: bool,
    pub created_at: i64,
    pub bump: u8,
}

fn check_shape(
    amount: u64,
    finish_after: Option<i64>,
    cancel_after: Option<i64>,
    memos: &[String],
    destination: Pubkey,
) -> Result<()> {
    require!(amount > 0, EscrowError::ZeroAmount);
    if let (Some(f), Some(c)) = (finish_after, cancel_after) {
        require!(c > f, EscrowError::CancelBeforeFinish);
    }
    require!(memos.len() <= MAX_MEMOS as usize, EscrowError::TooManyMemos);
    require!(
        memos.iter().all(|m| m.len() <= MAX_MEMO_LEN as usize),
        EscrowError::MemoTooLong
    );
    require!(destination != Pubkey::default(), EscrowError::NoDestination);
    Ok(())
}

/// Vault → `to`, signed by the escrow PDA, then the empty vault is closed and
/// its rent returns to the owner.
#[allow(clippy::too_many_arguments)]
fn pay_from_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    rent_to: &UncheckedAccount<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    let signer: &[&[&[u8]]] = &[seeds];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.clone(),
            },
            signer,
        ),
        amount,
        mint.decimals,
    )?;
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_to.to_account_info(),
            authority: authority.clone(),
        },
        signer,
    ))
}

// ------------------------------------------------------------- the fee per act

#[derive(Accounts)]
pub struct ConfigInit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + FeeConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, FeeConfig>,
    /// this program, to find its ProgramData…
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ EscrowError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::DareskroEscrow>,
    /// …whose upgrade authority must be the signer
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ EscrowError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ EscrowError::NotAdmin)]
    pub config: Account<'info, FeeConfig>,
}

/// The schedule and the till. One per program; the fees charged sit in this
/// account's lamports, above its rent.
#[account]
#[derive(InitSpace)]
pub struct FeeConfig {
    pub admin: Pubkey,
    /// basis points of the SOL locked, at most MAX_FEE_BPS
    pub fee_bps: u16,
    /// floor in lamports, at most MAX_FEE_MIN; a token escrow pays exactly this
    pub fee_min: u64,
    /// charged and not yet withdrawn
    pub fees_held: u64,
    /// charged since the account was created
    pub fees_total: u64,
    pub acts_charged: u64,
    pub bump: u8,
}

/// What this act costs the owner, on top of what is locked: `fee_bps` of the
/// SOL locked with the floor `fee_min` (`locked = 0` for a token escrow, which
/// then pays the floor). Zero fee: no transfer, no trace.
fn charge_fee<'info>(
    config: &mut Account<'info, FeeConfig>,
    owner: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    locked: u64,
) -> Result<u64> {
    let pct = (locked as u128 * config.fee_bps as u128 / 10_000) as u64;
    let fee = pct.max(config.fee_min);
    if fee == 0 {
        return Ok(0);
    }
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.key(),
            anchor_lang::system_program::Transfer {
                from: owner.clone(),
                to: config.to_account_info(),
            },
        ),
        fee,
    )?;
    config.fees_held += fee;
    config.fees_total += fee;
    config.acts_charged += 1;
    Ok(fee)
}

// -------------------------------------------------------------------- events

#[event]
pub struct Created {
    pub escrow: Pubkey,
    pub owner: Pubkey,
    pub destination: Pubkey,
    pub mint: Option<Pubkey>,
    pub amount: u64,
    pub finish_after: Option<i64>,
    pub cancel_after: Option<i64>,
    pub condition: Option<[u8; 32]>,
    pub id: u64,
    /// what the owner paid the service for this act, in lamports (0 = no schedule)
    pub fee: u64,
}

impl Created {
    fn from(e: &Escrow, key: Pubkey, fee: u64) -> Self {
        Self {
            fee,
            escrow: key,
            owner: e.owner,
            destination: e.destination,
            mint: e.mint,
            amount: e.amount,
            finish_after: e.finish_after,
            cancel_after: e.cancel_after,
            condition: e.condition,
            id: e.id,
        }
    }
}

#[event]
pub struct Finished {
    pub escrow: Pubkey,
    pub by: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub fulfillment: Vec<u8>,
}

#[event]
pub struct StatementSealed {
    pub statement: Pubkey,
    pub escrow: Pubkey,
    pub sha256_plain: [u8; 32],
    pub readers: u8,
    pub sealed: bool,
}

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub threshold: u8,
    pub parties: Vec<Pubkey>,
    pub deadline: Option<i64>,
    pub id: u64,
    pub fee: u64,
}

#[event]
pub struct FeeSet {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub fee_min: u64,
}

#[event]
pub struct FeesWithdrawn {
    pub admin: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultDecided {
    pub vault: Pubkey,
    pub by: Pubkey,
    pub to_beneficiary: u64,
    pub to_owner: u64,
    pub votes: u8,
    pub timeout: bool,
}

#[event]
pub struct Cancelled {
    pub escrow: Pubkey,
    pub by: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

// -------------------------------------------------------------------- errors

// -------------------------------------------------------- the invoice advance

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct PoolCreate<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        init,
        payer = operator,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, operator.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolDeposit<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.operator.as_ref(), &pool.id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolWithdraw<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.operator.as_ref(), &pool.id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
#[instruction(invoice: [u8; 32])]
pub struct AdvancePropose<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [POOL_SEED, pool.operator.as_ref(), &pool.id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = signer,
        space = 8 + Advance::INIT_SPACE,
        seeds = [ADVANCE_SEED, pool.key().as_ref(), &invoice],
        bump
    )]
    pub advance: Account<'info, Advance>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdvanceApprove<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.operator.as_ref(), &pool.id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        has_one = pool @ EscrowError::WrongPool,
        seeds = [ADVANCE_SEED, pool.key().as_ref(), &advance.invoice],
        bump = advance.bump,
    )]
    pub advance: Account<'info, Advance>,
    /// CHECK: the supplier written at the proposal, the only account the advance can reach
    #[account(mut, address = advance.supplier @ EscrowError::WrongDestination)]
    pub supplier: UncheckedAccount<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, FeeConfig>,
}

#[derive(Accounts)]
pub struct AdvanceRepay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.operator.as_ref(), &pool.id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        has_one = pool @ EscrowError::WrongPool,
        seeds = [ADVANCE_SEED, pool.key().as_ref(), &advance.invoice],
        bump = advance.bump,
    )]
    pub advance: Account<'info, Advance>,
    /// CHECK: the supplier written at the proposal
    #[account(mut, address = advance.supplier @ EscrowError::WrongDestination)]
    pub supplier: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdvanceDefault<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.operator.as_ref(), &pool.id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        has_one = pool @ EscrowError::WrongPool,
        seeds = [ADVANCE_SEED, pool.key().as_ref(), &advance.invoice],
        bump = advance.bump,
    )]
    pub advance: Account<'info, Advance>,
}

#[derive(Accounts)]
pub struct AdvanceBuyback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.operator.as_ref(), &pool.id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        has_one = pool @ EscrowError::WrongPool,
        seeds = [ADVANCE_SEED, pool.key().as_ref(), &advance.invoice],
        bump = advance.bump,
    )]
    pub advance: Account<'info, Advance>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdvanceClose<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(has_one = operator @ EscrowError::WrongOwner, seeds = [POOL_SEED, pool.operator.as_ref(), &pool.id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        close = operator,
        has_one = pool @ EscrowError::WrongPool,
        seeds = [ADVANCE_SEED, pool.key().as_ref(), &advance.invoice],
        bump = advance.bump,
        constraint = advance.status != AdvanceStatus::Funded @ EscrowError::StillLocked,
    )]
    pub advance: Account<'info, Advance>,
}

/// The pool's ceilings, compiled into the account at creation and checked by the
/// program when an advance is paid, whatever the signers agreed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct PoolPolicy {
    /// of the pool's capital, what one debtor may owe, the new advance and its fee included
    pub max_share_bps: u16,
    /// of the invoice's face, what may be advanced
    pub max_advance_bps: u16,
    /// seconds between the proposal and the invoice's due date, at most
    pub max_term: i64,
    /// seconds after the due date before a default may be written
    pub grace: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct Lender {
    pub key: Pubkey,
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct Exposure {
    pub debtor: Pubkey,
    /// advances and fees not yet repaid by this debtor
    pub owed: u64,
}

/// A lending pool: lamports held by this account, decided by `threshold` of `signers`.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub operator: Pubkey,
    #[max_len(5)]
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub policy: PoolPolicy,
    /// the book: cash on hand + advances outstanding; losses leave it, fees earned join it
    pub capital: u64,
    /// the lenders' deposits still on the book
    pub deposits: u64,
    /// advances paid and not yet repaid
    pub outstanding: u64,
    pub losses: u64,
    pub fees_earned: u64,
    pub advances_funded: u64,
    #[max_len(5)]
    pub lenders: Vec<Lender>,
    #[max_len(8)]
    pub exposures: Vec<Exposure>,
    pub id: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AdvanceStatus {
    Proposed,
    Funded,
    Repaid,
    Defaulted,
    BoughtBack,
}

/// One invoice advanced: who gets the money, who owes the invoice, how much, when.
#[account]
#[derive(InitSpace)]
pub struct Advance {
    pub pool: Pubkey,
    /// SHA-256 of the canonical dossier, the fingerprint the XRPL version anchors
    pub invoice: [u8; 32],
    pub supplier: Pubkey,
    pub debtor: Pubkey,
    pub face: u64,
    pub advance: u64,
    /// the pool's fee, taken from the invoice when it is paid
    pub fee: u64,
    pub due: i64,
    #[max_len(5)]
    pub approvals: Vec<Pubkey>,
    pub status: AdvanceStatus,
    /// paid into this account so far
    pub repaid: u64,
    pub proposed_by: Pubkey,
    pub created_at: i64,
    pub funded_at: Option<i64>,
    pub closed_at: Option<i64>,
    pub bump: u8,
}

/// The debtor's exposure drops by what was repaid, written off or bought back.
fn release_exposure(p: &mut Pool, debtor: Pubkey, owed: u64) {
    if let Some(i) = p.exposures.iter().position(|e| e.debtor == debtor) {
        p.exposures[i].owed = p.exposures[i].owed.saturating_sub(owed);
        if p.exposures[i].owed == 0 {
            p.exposures.remove(i);
        }
    }
}

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub operator: Pubkey,
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub policy: PoolPolicy,
    pub id: u64,
}

#[event]
pub struct PoolFunded {
    pub pool: Pubkey,
    pub lender: Pubkey,
    pub amount: u64,
    pub capital: u64,
}

#[event]
pub struct PoolWithdrawn {
    pub pool: Pubkey,
    pub lender: Pubkey,
    pub deposit: u64,
    pub paid: u64,
}

#[event]
pub struct AdvanceProposed {
    pub advance: Pubkey,
    pub pool: Pubkey,
    pub invoice: [u8; 32],
    pub supplier: Pubkey,
    pub debtor: Pubkey,
    pub face: u64,
    pub amount: u64,
    pub fee: u64,
    pub due: i64,
    pub by: Pubkey,
}

#[event]
pub struct AdvanceFunded {
    pub advance: Pubkey,
    pub pool: Pubkey,
    pub supplier: Pubkey,
    pub debtor: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub by: Pubkey,
    pub approvals: u8,
    /// dareskro's fee per act, taken from the pool
    pub act_fee: u64,
    pub capital: u64,
    pub outstanding: u64,
}

#[event]
pub struct AdvanceRepaid {
    pub advance: Pubkey,
    pub pool: Pubkey,
    pub payer: Pubkey,
    pub repaid: u64,
    pub to_pool: u64,
    pub to_supplier: u64,
    pub capital: u64,
}

#[event]
pub struct AdvanceDefaulted {
    pub advance: Pubkey,
    pub pool: Pubkey,
    pub by: Pubkey,
    pub loss: u64,
    pub recovered: u64,
    pub unpaid: u64,
    pub capital: u64,
    pub losses: u64,
}

#[event]
pub struct AdvanceBoughtBack {
    pub advance: Pubkey,
    pub pool: Pubkey,
    pub payer: Pubkey,
    pub paid: u64,
    pub capital: u64,
    pub losses: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("escrow already closed")]
    AlreadyClosed,
    #[msg("too early: the cluster clock has not reached finish_after")]
    TooEarly,
    #[msg("too late: past cancel_after only cancel is possible")]
    TooLate,
    #[msg("this escrow has no condition")]
    NoCondition,
    #[msg("this escrow is locked by a condition: bring the fulfillment")]
    FulfillmentRequired,
    #[msg("fulfillment does not match the condition")]
    WrongFulfillment,
    #[msg("fulfillment longer than 64 bytes")]
    FulfillmentTooLong,
    #[msg("this escrow has no cancel_after: nobody can cancel it")]
    NotCancellable,
    #[msg("too early: cancel_after not reached")]
    CancelTooEarly,
    #[msg("an escrow of zero")]
    ZeroAmount,
    #[msg("cancel_after must be later than finish_after")]
    CancelBeforeFinish,
    #[msg("at most 3 memos")]
    TooManyMemos,
    #[msg("a memo longer than 128 bytes")]
    MemoTooLong,
    #[msg("destination missing")]
    NoDestination,
    #[msg("the destination account is not the one written at creation")]
    WrongDestination,
    #[msg("not the escrow's owner")]
    WrongOwner,
    #[msg("the token account does not belong to the right party or mint")]
    WrongTokenAccount,
    #[msg("SOL instruction on a token escrow, or the reverse")]
    WrongRail,
    #[msg("a Locked escrow cannot be deleted")]
    StillLocked,
    #[msg("ciphertext longer than 8192 bytes: use uri")]
    CiphertextTooLong,
    #[msg("neither a ciphertext nor a uri")]
    NoContent,
    #[msg("uri longer than 128 bytes")]
    UriTooLong,
    #[msg("between 1 and 6 readers")]
    TooManyReaders,
    #[msg("a role longer than 16 bytes")]
    RoleTooLong,
    #[msg("the statement is sealed: its content cannot change")]
    StatementSealed,
    #[msg("chunk out of order or beyond the announced length")]
    BadChunk,
    #[msg("ciphertext incomplete")]
    CipherIncomplete,
    #[msg("the ciphertext does not hash to what was announced")]
    CipherHashMismatch,
    #[msg("this key is already a reader")]
    ReaderExists,
    #[msg("the vault holds less than the escrow's amount")]
    VaultShort,
    #[msg("a shared vault needs between 2 and 5 parties")]
    BadParties,
    #[msg("threshold must be between 1 and the number of parties")]
    BadThreshold,
    #[msg("the same party twice")]
    DuplicateParty,
    #[msg("the signer is not one of the vault's parties")]
    NotAParty,
    #[msg("more than the vault holds")]
    AmountExceeds,
    #[msg("the deadline must be in the future")]
    DeadlinePassed,
    #[msg("this vault has no deadline: only the parties decide")]
    NoDeadline,
    #[msg("the deadline is not reached")]
    DeadlineNotReached,
    #[msg("only the administrator may set or withdraw the fee")]
    NotAdmin,
    #[msg("only the program's upgrade authority creates the schedule")]
    NotUpgradeAuthority,
    #[msg("the fee is capped by the code: at most 100 basis points and a floor of 0.01 SOL")]
    FeeAboveCeiling,
    #[msg("nothing to withdraw")]
    NothingToWithdraw,
    #[msg("a pool policy must have shares and caps between 1 and 10000 bps, a positive term, a non-negative grace")]
    BadPolicy,
    #[msg("at most 5 lenders in a pool")]
    TooManyLenders,
    #[msg("the signer is not a lender of this pool")]
    NotALender,
    #[msg("not enough cash in the pool: advances are still out")]
    PoolIlliquid,
    #[msg("the pool's fee cannot exceed what the invoice leaves above the advance")]
    FeeAboveFace,
    #[msg("the invoice is due beyond the pool's maximum term")]
    TermTooLong,
    #[msg("this advance is not open to approval")]
    NotProposed,
    #[msg("this signer already approved")]
    AlreadyApproved,
    #[msg("refused by the program: the advance exceeds the pool's cap on the invoice's face")]
    AdvanceAboveCap,
    #[msg("refused by the program: this debtor would owe more than the pool's concentration cap, whoever signed")]
    ConcentrationBreached,
    #[msg("at most 8 debtors with advances outstanding")]
    TooManyDebtors,
    #[msg("this advance is not funded")]
    NotFunded,
    #[msg("too early: the due date plus the grace period is not reached")]
    DefaultTooEarly,
    #[msg("this advance is not in default")]
    NotDefaulted,
    #[msg("the advance does not belong to this pool")]
    WrongPool,
}
