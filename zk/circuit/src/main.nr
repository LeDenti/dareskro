// pay_compliance: the amount locked in the escrow is the lawful pay, under the
// pharmacy collective agreement (IDCC 1996 art. 11; agreement of 23/03/2000 art. 4),
// for SOME hours, coefficient and seniority. Those three stay private, together
// with the employee's badge and a nonce; only a Pedersen commitment to them (and to the
// statement's sha256, carried by the escrow memo) is public. Private to the PROOF only: the
// amount and the rules are public, so the public can enumerate the compatible inputs
// (verify.mjs prints how many).
//
// Arithmetic. The payroll engine works in Decimal and rounds EACH line to the cent
// (ROUND_HALF_UP), then adds the rounded lines (since 25/10, 10:30 NY: before that it rounded
// the exact sum, and the printed lines could miss the total by a cent). Every line is a rational number with a
// denominator that divides 242 672 000 = 2^7 * 5^3 * 15167 (151.67 h = 15167/100):
//   hourly rate   = coefficient * point / 151.67       (point = point_value_milli / 1000)
//   shift pay     = retained hours * hourly rate       (retained = hours, or 25 % with shutters closed, full time)
//   overtime      = +25 % between 35 h and 43 h of the week, +50 % beyond 43 h, on retained hours
//   Sunday        = hours worked * 1.5 point           (a flat amount per hour, same for every coefficient)
//   seniority     = retained hours * hourly rate * 3 % per 3 years, capped at 15 % (>= 15 years)
//   fixed-term    = +10 % of the shift gross (end of contract), then +10 % of that sum (paid leave), each rounded to the cent
// Hours are carried in sixteenths of an hour so that the 25 % shutters-closed case stays an
// integer. With n = line * 242 672 000, the engine's rounding of a line is cents = floor((n + 1 213 360) / 2 426 720).
// Replayed against the engine on random input combinations after the change (see zk/README.md).
use std::hash::pedersen_hash;

global WEEK_35H_16: u64 = 560; // 35 h in sixteenths of an hour
global WEEK_43H_16: u64 = 688; // 43 h
global SUNDAY_FACTOR: u64 = 91002; // 3 * 30334: 1.5 point per hour, scaled to the common denominator
global ROUND_DEN: u64 = 2426720; // 242 672 000 / 100: one cent in units of N
global ROUND_HALF: u64 = 1213360;

fn main(
    heures_q: u32, // private: hours worked, in quarter hours
    coefficient: u32, // private: agreement coefficient
    anciennete_annees: u32, // private: seniority in whole years
    badge_id: Field, // private: sha256(badge) reduced to the field, off-circuit
    nonce: Field, // private: blinds the commitment
    total_cents: pub u32,
    point_value_milli: pub u32, // 5277 for 5.277 EUR
    dimanche: pub bool,
    volets_ouverts: pub bool,
    heures_semaine_avant: pub u32, // whole hours already worked that week
    cdd: pub bool, // fixed-term contract of one day: +10 % end-of-contract bonus, then +10 % paid-leave allowance
    statement_hi: pub Field, // sha256 of the statement, first 16 bytes: binds the proof to the escrow memo
    statement_lo: pub Field, // last 16 bytes
) -> pub Field {
    // Bounds keep every product far below 2^64 and reject absurd inputs.
    assert(heures_q >= 1);
    assert(heures_q <= 96); // one shift, 24 h at most
    assert(coefficient >= 100);
    assert(coefficient <= 2000);
    assert(anciennete_annees <= 70);
    assert(point_value_milli >= 1);
    assert(point_value_milli <= 100000);
    assert(heures_semaine_avant <= 168);
    statement_hi.assert_max_bit_size::<128>();
    statement_lo.assert_max_bit_size::<128>();

    let hq = heures_q as u64;
    let pvm = point_value_milli as u64;
    let base = (coefficient as u64) * pvm; // monthly minimum of the coefficient, in milli-euros

    // Retained time: 100 % of the time with shutters open, 25 % closed (full time assumed).
    let retenu16 = if volets_ouverts { hq * 4 } else { hq };

    // Overtime: the shift occupies the week's hours after heures_semaine_avant.
    let debut16 = (heures_semaine_avant as u64) * 16;
    let fin16 = debut16 + retenu16;
    let lo1 = if debut16 > WEEK_35H_16 { debut16 } else { WEEK_35H_16 };
    let hi1 = if fin16 < WEEK_43H_16 { fin16 } else { WEEK_43H_16 };
    let t1 = if hi1 > lo1 { hi1 - lo1 } else { 0 }; // sixteenths at +25 %
    let lo2 = if debut16 > WEEK_43H_16 { debut16 } else { WEEK_43H_16 };
    let t2 = if fin16 > lo2 { fin16 - lo2 } else { 0 }; // sixteenths at +50 %

    // Seniority: 3 % per full 3 years, capped at 15 %.
    let steps = (anciennete_annees as u64) / 3;
    let k = if steps > 5 { 15 } else { steps * 3 };

    let sunday = if dimanche { SUNDAY_FACTOR * hq * pvm } else { 0 };
    // Each line is rounded to the cent on its own, as the statement prints it, then the lines
    // are added: shift pay, overtime (one line for both rates), Sunday allowance, seniority.
    let l_garde = (100 * retenu16 * base + ROUND_HALF) / ROUND_DEN;
    let l_sup = (25 * t1 * base + 50 * t2 * base + ROUND_HALF) / ROUND_DEN;
    let l_dim = (sunday + ROUND_HALF) / ROUND_DEN;
    let l_anc = (k * retenu16 * base + ROUND_HALF) / ROUND_DEN;
    let garde_cents = l_garde + l_sup + l_dim + l_anc;
    // Fixed-term contract (Code du travail L1243-8, L1242-16): each indemnity is 10 % of its
    // basis, rounded to the cent half up — (x + 5) / 10 on cents is exactly that rounding.
    let fin_contrat = if cdd { (garde_cents + 5) / 10 } else { 0 };
    let conges = if cdd { (garde_cents + fin_contrat + 5) / 10 } else { 0 };
    let cents = garde_cents + fin_contrat + conges;
    assert(cents == total_cents as u64);

    // The statement hash is inside the commitment: the proof is for THIS statement, hence for the
    // escrow whose memo cites it, not for any escrow of the same amount.
    pedersen_hash([badge_id, heures_q as Field, coefficient as Field, anciennete_annees as Field, nonce, statement_hi, statement_lo])
}
