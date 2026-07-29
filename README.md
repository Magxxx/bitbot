# Circle Gateway → Arc mainnet bridge

This standalone Node.js example transfers native USDC from Ethereum or Base to
Arc mainnet through Circle Gateway. It can:

1. quote the direct (non-forwarded) Gateway transfer;
2. approve and deposit any missing source-chain USDC;
3. wait until Circle finalizes the deposit;
4. sign a Gateway `BurnIntent` locally;
5. request Circle's mint attestation; and
6. submit `gatewayMint(bytes,bytes)` to Arc and verify the exact USDC mint log.

The script contains no user wallet addresses or private keys. Official public
RPC, token, GatewayWallet, and GatewayMinter addresses are configuration
constants.

## Important current limitation

Arc mainnet is presently advertised by the Gateway API only when the
`X-ARC-PRIVATE-MAINNET-ENABLED: true` request header is included. This is a
private-preview/early-access interface and can change without notice.

Circle normally waits about 65 Ethereum L1 blocks (roughly 13–19 minutes) to
finalize new Ethereum and Base Gateway deposits. Once a balance is finalized,
the direct attestation and Arc mint are fast.

## Install

```bash
npm install
cp .env.example .env
```

Load the variables without printing them, then run:

```bash
set -a
. ./.env
set +a
npm run bridge
```

Node.js 22 or newer is recommended.

## Security

- Use a small amount first.
- Never commit `.env`.
- Prefer a dedicated bridge wallet over a high-value long-lived key.
- `ARC_RELAYER_PRIVATE_KEY` is optional because `destinationCaller` is zero.
  This lets a funded Arc wallet submit the mint while the USDC is delivered to
  `DESTINATION_ADDRESS`.
- Each invocation is capped at 500 USDC.
- A Gateway quote above 5 USDC is rejected before anything is signed.
- State is written under `bridge-state/OPERATION_ID.json`. Reuse the same
  operation ID to resume an interrupted run; use a new ID for a new transfer.
- Do not run two operations from the same source or relayer wallet at once.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | yes | Ethereum/Base signer that owns the Gateway balance |
| `SOURCE_CHAIN` | yes | `base` or `ethereum` |
| `AMOUNT_USDC` | yes | Destination amount, maximum 500, up to 6 decimals |
| `DESTINATION_ADDRESS` | no | Arc recipient; defaults to source signer |
| `ARC_RELAYER_PRIVATE_KEY` | no | Funded Arc signer for the mint transaction |
| `AUTO_DEPOSIT` | no | `true` by default; deposit a balance shortfall |
| `OPERATION_ID` | yes | Unique resumable state identifier |

Gateway fees are charged in USDC in addition to `AMOUNT_USDC`. If a new deposit
is needed, the script deposits only the exact shortfall needed to cover the
quoted maximum fee. The actual fee can be slightly lower, leaving tiny Gateway
dust.
