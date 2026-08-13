// Test helper for the website-origin signature gate on prospect-creation entrypoints.
// Mirrors OpenAdvertsSignatureGateFacet.verifyAndConsume:
//   messageHash = keccak256(abi.encodePacked(actionTag, chainId, diamond, caller, uid, deadline))
//   signature   = EIP-191 personal_sign(messageHash) by the openAdvertsSigningAddress key.
const { ethers } = require("hardhat");

// Must match the bytes32 constants declared in the factory facets.
const ACTION_TAGS = {
  POL: ethers.id("OPENADVERTS_POL_ADVERT_CREATE"),
  USDC: ethers.id("OPENADVERTS_USDC_ADVERT_CREATE"),
  AFFILIATE: ethers.id("OPENADVERTS_AFFILIATE_CREATE"),
};

// Deploys a fresh signing wallet, registers it on-chain as the protocol signing address,
// and returns the wallet so tests can sign gate messages with its key.
async function installGateSigner(diamondAddress, owner) {
  const gateSigner = ethers.Wallet.createRandom();
  const payoutFacet = await ethers.getContractAt("OpenAdvertsPayoutFacet", diamondAddress);
  await payoutFacet.connect(owner).setOpenAdvertsSigningAddress(gateSigner.address);
  return gateSigner;
}

// Builds a signature for a specific action/caller/uid/deadline.
async function signGate(gateSigner, actionTag, diamondAddress, caller, uid, deadline) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const messageHash = ethers.solidityPackedKeccak256(
    ["bytes32", "uint256", "address", "address", "bytes32", "uint256"],
    [actionTag, chainId, diamondAddress, caller, uid, deadline]
  );
  return gateSigner.signMessage(ethers.getBytes(messageHash));
}

// Returns [uid, deadline, signature] ready to spread into a create call.
// Generates a unique uid per call (single-use) and a far-future deadline by default.
async function gateArgs(gateSigner, actionTag, diamondAddress, caller, { uid, deadline } = {}) {
  const resolvedUid = uid ?? ethers.hexlify(ethers.randomBytes(32));
  const resolvedDeadline = deadline ?? (await ethers.provider.getBlock("latest")).timestamp + 3600;
  const signature = await signGate(gateSigner, actionTag, diamondAddress, caller, resolvedUid, resolvedDeadline);
  return [resolvedUid, resolvedDeadline, signature];
}

const pol = (gateSigner, diamondAddress, caller, opts) => gateArgs(gateSigner, ACTION_TAGS.POL, diamondAddress, caller, opts);
const usdc = (gateSigner, diamondAddress, caller, opts) => gateArgs(gateSigner, ACTION_TAGS.USDC, diamondAddress, caller, opts);
const affiliate = (gateSigner, diamondAddress, caller, opts) => gateArgs(gateSigner, ACTION_TAGS.AFFILIATE, diamondAddress, caller, opts);

module.exports = { ACTION_TAGS, installGateSigner, signGate, gateArgs, pol, usdc, affiliate };
