/* global ethers */
/*
 * Standalone verification pass. Reads deployed-addresses.json for the active
 * network's chainId and (re)verifies every contract on the block explorer with
 * the correct constructor arguments:
 *   - DiamondCutFacet / DiamondInit : no args
 *   - Diamond                       : [owner, diamondCutFacet]
 *   - every protocol facet          : [diamond]   (fund-forwarding constructor)
 *
 * Use this to recover from partial/failed verification without redeploying:
 *   npx hardhat run scripts/verify.js --network polygon
 */
const { ethers, network, run } = require("hardhat");
const fs = require("fs");

const DEPLOYED_ADDRESSES_PATH = "./deployed-addresses.json";

async function verifyContract(name, address, constructorArguments) {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await run("verify:verify", { address, constructorArguments });
      console.log(`✅ Verified ${name} at ${address}`);
      return;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const lower = message.toLowerCase();
      if (lower.includes("already verified")) {
        console.log(`ℹ️  ${name} already verified: ${address}`);
        return;
      }
      // Explorer has not indexed the bytecode yet — back off and retry.
      const transient =
        lower.includes("does not have bytecode") ||
        lower.includes("unable to locate contractcode") ||
        lower.includes("has not been indexed") ||
        lower.includes("pending in queue") ||
        lower.includes("try again later") ||
        lower.includes("rate limit");
      if (transient && attempt < MAX_ATTEMPTS) {
        const delayMs = 15000 * attempt;
        console.log(`⏳ ${name}: explorer not ready (attempt ${attempt}/${MAX_ATTEMPTS}) — retry in ${delayMs / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      console.log(`⚠️  Verification failed for ${name}: ${message}`);
      return;
    }
  }
}

async function main() {
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("ℹ️  Verification is not applicable on local networks.");
    return;
  }

  const chainId = String(network.config.chainId);
  const all = JSON.parse(fs.readFileSync(DEPLOYED_ADDRESSES_PATH, "utf8"));
  const entry = all[chainId];
  if (!entry || !entry.contracts) {
    throw new Error(`No deployment record for chainId ${chainId} in ${DEPLOYED_ADDRESSES_PATH}`);
  }
  const c = entry.contracts;

  const owner = await (await ethers.getContractAt("OwnershipFacet", c.diamond)).owner();
  console.log(`Verifying chainId ${chainId} (${entry.network}); diamond owner: ${owner}\n`);

  await verifyContract("DiamondCutFacet", c.diamondCutFacet, []);
  await verifyContract("Diamond", c.diamond, [owner, c.diamondCutFacet]);
  await verifyContract("DiamondInit", c.diamondInit, []);

  for (const [name, address] of Object.entries(c.facets)) {
    await verifyContract(name, address, [c.diamond]);
  }

  console.log("\n✅ Verification pass complete.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
