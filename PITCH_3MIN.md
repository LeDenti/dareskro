# dareskro — pitch de piste, 3 minutes (Agentic Finance), dimanche 25/10, 14:00

Avant de monter : une passe lancée sur le pupitre 2 min avant (Paid in crypto), Terminal avec `tail -f` de l'oracle, Chrome sur le pupitre, Nano branché.

**0:00 – 0:30 · Le problème, la règle**
"Every month, someone is chasing a payment they earned: a pharmacist's Sunday shift, a freelancer's delivery, an influencer's placement. The payer holds the money and the proof; the worker holds the risk. dareskro: the AI reads, the code computes, a human signs on a Ledger device, the ledger pays. Nobody holds the funds — not a platform, not a bank, not us."

**0:30 – 1:15 · Le bulletin, la signature** (pupitre, cartes 1 et 3)
"A pharmacist's Sunday shift: 466.58. A one-day contract: gross 564.56, net paid 407.33, 361.32 to social security, 33.03 income tax. Every line rounded to the cent, then added: it adds up on paper. One signature on the device, three transactions in one Batch, all or nothing: the net in an escrow, the contributions as a Check the administration cashes itself, the tax in an escrow. The money leaves the employer at validation and sits in the ledger: no cancel date, no redirect field, nobody can touch it before the date."

**1:15 – 1:50 · L'oracle** (Terminal : la ligne « finished » vient d'arriver)
"This is the oracle: a named account with a birth certificate on chain. One job: wait for the date, submit the finish, pay twelve drops. There — it just released the pay, nobody clicked. It cannot pay early: the ledger refuses. It cannot redirect: there is no such field. It cannot cancel: nothing to cancel. And if it dies, anyone can finish after the date — the employee himself."

**1:50 – 2:20 · Mastercard, confidentialité**
"The employee chooses: keep the XRP, or dollars through Mastercard Agent Pay for Machines — settled only after the ledger has released, never before; receipt verified on chain, live this morning with their engineer. And the statement is sealed: the public reads nothing, the administration opens it with its key, and a zero-knowledge proof says the pay follows the collective agreement without revealing who or how many hours."

**2:20 – 2:45 · Quatre payeurs, tout mesuré**
"Same oracle, four payers on one desk: employee at the date, freelancer on proof of delivery, influencer when the post is still live, affiliate when the merchant's system confirms the order. All of it ran this weekend on testnet; every hash is in the README; the code is public."

*Variante après le 27/10 (si le temps le permet, 10 s) :* "And a fifth, not an escrow: the rental deposit, an account with three keys and a quorum of two — landlord, tenant, us. Alone, each of us is refused by the ledger; together, any split. The euro cannot be escrowed on XRPL today, so this is how euros are held by nobody."

**2:45 – 3:00 · La chute**
"The AI reads. The code computes. A human signs. The ledger pays. Not before."

---
Questions probables (réponses complètes dans dareskro_pitch_final_EN.pdf) :
- Where is the money before the date? → In an Escrow object of the ledger, locked at validation; the ledger refuses the lock if the funds are not there. The URSSAF Check is the honest exception: a right to pull, not a lock; in production that leg is an escrow too.
- Who is the oracle? → rUuvu1X…, born Saturday 15:51 UTC with a memo saying what it is; it holds nothing, it only submits the finish.
- Over the budget? → Two over-cap attempts refused, nothing signed; the payout reads the budget first and scales down (0.41 RLUSD at 1/1000 this morning).
- What's next? → The legal layer (payslip, DSN, bank transfer), the oracle on mainnet, RLUSD escrow the day its issuer enables trustline locking.
- Le dépôt de garantie ? → Un compte 2-sur-3 par bail, pas un escrow : EURØP et RLUSD ne sont pas séquestrables (drapeau absent, mesuré le 27/10) et un dépôt se rend en partie. Arbitre seul : tefBAD_QUORUM. Reste l'avocat (loi Hoguet), le rail SEPA, la clause de bail.
