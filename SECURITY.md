# Security

EdgeScope is hackathon/testnet software and has not been audited.

## Wallet handling

- Use only a fresh disposable Somnia Shannon testnet wallet.
- Never reuse a production wallet or private key.
- Store `PRIVATE_KEY` only in the local `.env` file.
- `.env` is ignored by Git and must never be committed.
- The helper `npm run generate-wallet` creates a disposable key specifically for this testnet workflow.

## External data and receipts

- External price data is treated as untrusted input and validated before use.
- Somnia Agent results are accepted only when the numeric final answer is well formed, in range, and matches the ABI-decoded result.
- External receipt and Oracle Explorer links are validated before rendering into the HTML report.

## Trading scope

EdgeScope is read-only analytics. It does not place DreamDEX orders or manage user funds.

## Reporting issues

For hackathon review, please open a GitHub issue with reproduction steps and omit all private keys, wallet secrets, or other credentials.
