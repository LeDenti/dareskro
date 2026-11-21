// hh-EURD transfers as protocol-level token updates, sponsorable, with a memo.
import { AccountAddress, Transaction, TokenId, TokenAmount, CborAccountAddress, CborMemo,
         TokenOperationType, createTokenUpdatePayload, Token } from '@concordium/web-sdk';
import { JETON, COMPTES } from './config.mjs';
import { client } from './chaine.mjs';

export const ID = TokenId.fromString(JETON.id);

export function transfert(versRole, montantDecimal, memo) {
  const op = { [TokenOperationType.Transfer]: {
    amount: TokenAmount.fromDecimal(montantDecimal, JETON.decimales),
    recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(COMPTES[versRole] ?? versRole)),
    ...(memo ? { memo: CborMemo.fromString(memo) } : {}),
  } };
  return Transaction.tokenUpdate(createTokenUpdatePayload(ID, [op]));
}

export async function soldes() {
  const t = await Token.fromId(client, ID);
  const out = {};
  for (const [role, adr] of Object.entries(COMPTES)) {
    const info = await client.getAccountInfo(AccountAddress.fromBase58(adr));
    const tok = (info.accountTokens ?? []).find((x) => String(x.id?.value ?? x.id) === JETON.id);
    out[role] = { ccd: Number(info.accountAmount.microCcdAmount) / 1e6,
                  [JETON.id]: tok ? Number(tok.state.balance.value) / 10 ** JETON.decimales : 0 };
  }
  return { jeton: t ? JETON.id : null, ...out };
}
