# OpenAdverts Protocol — Smart Contracts

OpenAdverts (OAD) is an on-chain advertising-rewards protocol built on the [EIP-2535 Diamond standard](https://eips.ethereum.org/EIPS/eip-2535). A single `Diamond` proxy delegates to modular facets covering the OAD token, advertiser and affiliate registries, signature-verified reward payouts, and token-holder governance. Individual ad campaigns are deployed as standalone `OpenAdvertsAdvertPOL` (native POL) and `OpenAdvertsAdvertUSDC` (ERC-20 USDC) contracts through factory facets.

- **Token:** OAD — fixed supply of 21,000,000, custom storage (not OZ-inherited), with POL/USDC dividend accrual for holders.
- **Payments:** campaigns are funded in native POL or USDC; USDC minimums are derived from a Chainlink POL/USD feed plus a governance-set currency premium.
- **Proof of engagement:** the backend signs viewer engagement; affiliates submit signature batches (up to 200) to `processReward`, which verifies each signature against the protocol signing key and splits every bounty between the viewer, the affiliate, and up to six third parties.
- **Governance:** token-weighted proposals (parameter/quota changes and facet upgrades) with a FOR-only quorum, plus a permissionless admin-election flow.
- **Upgrades:** owner-direct `diamondCut` during a one-time bootstrap window, then governance-only via `FacetProposal`.

## Architecture at a glance

| Component | Role |
| --- | --- |
| `Diamond` | Proxy: `fallback` delegatecalls facets; constructor registers `diamondCut` |
| `DiamondCutFacet` | Add/replace/remove selectors (owner, bootstrap-gated) |
| `DiamondLoupeFacet` | EIP-2535 introspection |
| `OwnershipFacet` | ERC-173 ownership |
| `OpenAdvertsTokenFacet` | OAD token, POL/USDC dividend accrual, `finalizeBootstrap` |
| `OpenAdvertsAdvertisersFacet` / `OpenAdvertsAdvertisersVotingFacet` | Advertiser & campaign registry; community approval/denial voting |
| `OpenAdvertsAffiliatesFacet` / `OpenAdvertsAffiliatesVotingFacet` | Affiliate (publisher) registry; approval/denial voting |
| `OpenAdvertsGovernanceFacet` | Quota & facet proposals, voting, admin elections |
| `OpenAdvertsPayoutFacet` | Signature verification and reward distribution/claim |
| `OpenAdvertsClaimGasFloorFacet` | Owner-set claim-gas floor assumptions (bounty profitability guard) |
| `OpenAdvertsAdvertPOLFactoryFacet` / `OpenAdvertsAdvertUSDCFactoryFacet` / `OpenAdvertsAdvertUSDCHelperFacet` | Deploy per-campaign advert contracts |
| `OpenAdvertsAdvertUSDCPriceFacet` | Chainlink POL/USD conversion and USDC minimum calculations |
| `OpenAdvertsQueryFacet` / `OpenAdvertsQueryV2Facet` | Batched read aggregators for frontends |
| `OpenAdvertsSignatureGateFacet` | Website-origin signature gate on prospect creation |
| `OpenAdvertsTimelockFacet` | Owner-config timelock (queue → wait → execute) |
| `OpenAdvertsPauseFacet` | System-wide emergency pause |
| `OpenAdvertsAdvertPOL` / `OpenAdvertsAdvertUSDC` | Standalone per-campaign contracts deployed by the factory facets |

## Campaign lifecycle & rewards

1. **Create.** An advertiser funds a prospect campaign in POL or USDC via a factory facet. Creation entrypoints are gated by a website-origin backend signature (one-time UID + deadline, replay-protected).
2. **Approve.** Token holders vote to approve or deny prospective campaigns and affiliates. Approved affiliates (publishers) may then serve approved campaigns.
3. **Engage & prove.** The backend signs viewer engagement proofs. Affiliates collect them and submit a batch (up to 200 signatures) to the campaign contract's `processReward`, which forwards to the Diamond for verification against the protocol signing key.
4. **Distribute.** Each bounty is split between the viewer, the affiliate, and up to six third parties. A protocol commission (default 10%) is divided among the admin, the storage provider, and the OAD holder dividend pool. A failed transfer is escrowed for later pull rather than reverting the whole batch.

USDC campaign minimums are computed as the POL-equivalent (via the Chainlink feed) plus a governance-controlled currency premium (genesis default 200%), which cushions POL/USD volatility so USDC claims stay profitable to withdraw.

## Governance

- **Proposal types.** *Quota proposals* adjust economic and timing parameters; *facet proposals* add, replace, or remove diamond functions.
- **Voting weight** is each holder's token balance snapshotted at proposal creation, which neutralizes flash-loan and borrow-to-vote attacks.
- **Quorum is measured on SUPPORT (FOR) votes only.** A proposal passes when support exceeds the quorum threshold *and* outnumbers the deny votes, so a deny vote can never push a proposal over quorum.
- **`ratifyUpgrade()` is permissionless** after the voting deadline and never reverts on quorum/support: it applies a passed proposal or clears a failed one, so the single-proposal queue can never brick.
- **`revokeProposal()`** is owner-only and restricted to the voting window; once voting ends, the outcome belongs to the token holders.
- **Admin election.** `applyAsNewAdmin` → token-holder vote → `ratifyNewAdmin`, with a permissionless `clearFailedElection` when no candidate meets quorum, so ownership transfer cannot get stuck.

## Upgrade & bootstrap model

Two upgrade paths exist:

1. **Owner-direct `diamondCut`** — available only during the *bootstrap window*. A one-way latch (`OpenAdvertsTokenFacet.finalizeBootstrap()`) permanently closes it; `scripts/deploy.js` calls this at the end of a live-network deploy. After finalization, the owner path of `DiamondCutFacet.diamondCut` reverts.
2. **Governance `FacetProposal`** — created by the owner, voted on by token holders (FOR-only quorum), then resolved by the **permissionless** `ratifyUpgrade()` after the voting deadline. Ratification performs the cut through `DiamondCutFacet` authorized by a transient in-progress flag that only `ratifyUpgrade` sets, so the bootstrap latch does not block governance-approved upgrades.

The bootstrap latch gates **only** `diamondCut`. Owner configuration setters (signing address, storage provider, claim-gas floor) remain callable after finalization.

## Security

- Secrets live only in gitignored `.env*` files; the mainnet key is shell-injected for a single command, never committed.
- Prospect-creation entrypoints are gated by website-origin signatures with one-time UIDs and deadlines (replay-protected).
- Reentrancy guards on transfer/reward paths; flash-loan protection on all voting via balance snapshots plus same/adjacent-block activity checks.
- A system-wide pause can halt inbound-value and governance-takeover paths; withdrawals and refunds remain always-on by design.
- Sensitive owner configuration changes (oracle feed, signing key, oracle bounds, staleness windows) can be routed through `OpenAdvertsTimelockFacet`.
- Please report vulnerabilities via the repository's security contact rather than public issues.

## Requirements

- Node.js 18+
- npm

## Setup

```console
git clone https://github.com/openadverts-io/beopenadverts.git
cd beopenadverts
npm install
cp .env.example .env   # optional for local; see comments in the template
```

Running the local test suite requires no `.env` setup: on the `hardhat`/`localhost` networks the deploy script uses a dummy signing address and deploys mock USDC and price-feed contracts automatically. A real `.env` is only needed for testnet/mainnet deployment.

## Test

```console
npm test                        # full suite
npx hardhat test path/to/file.js
npm run test:gas                # gas benchmark (BusinessCaseV2, POL + USDC payouts)
npx hardhat size-contracts      # EIP-170 contract-size report
```

## Deploy

Local (in-process Hardhat network):

```console
npm run deploy
```

Against a standalone node:

```console
npx hardhat node                                     # terminal 1
npx hardhat run scripts/deploy.js --network localhost
```

Polygon mainnet (guarded — see `.env.prod.example`). Never store the mainnet key in a file; inject it for the single command:

```console
$env:PRIVATEKEYMAINNET = "0x<dedicated mainnet owner EOA key>"
$env:ENV_FILE = ".env.prod"; $env:I_UNDERSTAND_MAINNET = "1"
npx hardhat run scripts/deploy.js --network polygon
Remove-Item Env:PRIVATEKEYMAINNET                    # clear immediately after
```

Verify (no owner key required):

```console
$env:ENV_FILE = ".env.prod"; npx hardhat run scripts/verify.js --network polygon
```

The deployer receives the full OAD supply at genesis and is the initial Diamond owner. On live networks the deploy finalizes the bootstrap latch, so post-deploy facet upgrades go through governance. The script also initializes the claim-gas floor, the protocol signing address, and (on Polygon) the storage-provider address.

## Repository structure

```
contracts/
  Diamond.sol                  Diamond proxy
  facets/                      protocol facets (token, advertisers, affiliates, governance, payout, ...)
  libraries/                   namespaced diamond storage + helpers
  interfaces/
  upgradeInitializers/         DiamondInit (one-time upgrade initializer)
  OpenAdvertsAdvertPOL.sol     per-campaign native-POL contract
  OpenAdvertsAdvertUSDC.sol    per-campaign USDC contract
  Mock*.sol / Reentrancy.sol   test-only fixtures
scripts/
  deploy.js                    full deployment + initialization
  verify.js                    standalone block-explorer re-verification
test/                          Hardhat test suite (Mocha/Chai)
hardhat.config.cjs
```

## License

MIT. See [LICENSE](./LICENSE). Built on the diamond-3-hardhat reference implementation of EIP-2535 by Nick Mudge.
