/* global ethers */
/* eslint prefer-const: "off" */

const { getSelectors, FacetCutAction } = require('./libraries/diamond.js')
const { ethers, network, run } = require("hardhat");
const fs = require("fs");

// Read a JSON file, returning {} if it is missing or unparseable.
// Used by the merge-on-write helpers so a deploy to one network never
// clobbers another network's addresses (Option B: keyed by chainId).
function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (error) {
    console.warn(`⚠️  Could not parse ${filePath} (starting from empty):`, error.message);
  }
  return {};
}

// Merge `value` under the given chainId key into the JSON map at `filePath`,
// preserving entries for every other chainId already present.
function mergeJsonByChainId(filePath, chainId, value) {
  const existing = readJsonSafe(filePath);
  existing[String(chainId)] = value;
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  return existing;
}


async function deployDiamond () {
  const accounts = await ethers.getSigners()
  const contractOwner = accounts[0]

  console.log("Deploying with account:", contractOwner.address)

  // Safety net: never let the well-known hardhat dev account (account[0] of the
  // "test test … junk" mnemonic) own a real deployment. On Polygon the owner
  // must come from PRIVATEKEYMAINNET, not a leftover dev key.
  if (network.name !== "hardhat" && network.name !== "localhost") {
    const HARDHAT_DEV_ACCOUNT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    if (contractOwner.address.toLowerCase() === HARDHAT_DEV_ACCOUNT0.toLowerCase()) {
      throw new Error(
        `Refusing to deploy to ${network.name}: deployer resolved to the hardhat dev account ` +
        `(${HARDHAT_DEV_ACCOUNT0}). Set PRIVATEKEYMAINNET (Polygon) in .env.`
      );
    }
    if (network.name === "polygon" && !process.env.PRIVATEKEYMAINNET) {
      throw new Error(
        "PRIVATEKEYMAINNET not set — supply it as an inline env var, never store it in a file:\n" +
        "  PowerShell: $env:PRIVATEKEYMAINNET=\"<key>\"  (then Remove-Item Env:PRIVATEKEYMAINNET after)\n" +
        "  bash:        PRIVATEKEYMAINNET=<key> ENV_FILE=.env.prod I_UNDERSTAND_MAINNET=1 npx hardhat run ..."
      );
    }
    // Explicit opt-in so a mis-typed `--network polygon` can't broadcast a live deploy.
    if (network.config.chainId === 137 && process.env.I_UNDERSTAND_MAINNET !== "1") {
      throw new Error(
        "Refusing mainnet (chainId 137) deploy without confirmation. Re-run with " +
        "ENV_FILE=.env.prod and I_UNDERSTAND_MAINNET=1 set."
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ✅ INJECT MULTICALL3 AT CANONICAL ADDRESS (localhost / hardhat only)
  //
  // Multicall3 is deployed at the canonical address 0xcA11bde05977b3631167028862bE2a173976CA11
  // on every public chain the frontend talks to (Polygon mainnet, Amoy, etc.).
  // Hardhat's in-process node does NOT predeploy it, which causes viem's
  // publicClient.multicall() to throw ChainDoesNotSupportContract on localhost.
  //
  // Strategy: compile the verified Multicall3 source in contracts/Multicall3.sol,
  // deploy it normally to get its runtime bytecode, then use hardhat_setCode to
  // paste that runtime bytecode at the canonical address. Idempotent: skips if
  // already present (useful across repeat deploy runs against a persistent node).
  // ─────────────────────────────────────────────────────────────────────────
  const MULTICALL3_CANONICAL_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
  let multicall3Address = MULTICALL3_CANONICAL_ADDRESS;

  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("\n=== 📞 INJECTING MULTICALL3 AT CANONICAL ADDRESS ===");
    console.log("   Target:", MULTICALL3_CANONICAL_ADDRESS);

    const existingCode = await network.provider.send("eth_getCode", [MULTICALL3_CANONICAL_ADDRESS, "latest"]);
    if (existingCode && existingCode !== "0x" && existingCode !== "0x0") {
      console.log("   ℹ️  Multicall3 already present at canonical address — skipping injection.");
    } else {
      // Deploy once to a throwaway address purely to obtain compiled runtime bytecode.
      const Multicall3 = await ethers.getContractFactory("Multicall3");
      const multicall3Temp = await Multicall3.deploy();
      await multicall3Temp.waitForDeployment();
      const tempAddress = await multicall3Temp.getAddress();

      const runtimeBytecode = await network.provider.send("eth_getCode", [tempAddress, "latest"]);
      if (!runtimeBytecode || runtimeBytecode === "0x") {
        throw new Error("Failed to read Multicall3 runtime bytecode from temp deployment");
      }

      await network.provider.send("hardhat_setCode", [MULTICALL3_CANONICAL_ADDRESS, runtimeBytecode]);

      const verifyCode = await network.provider.send("eth_getCode", [MULTICALL3_CANONICAL_ADDRESS, "latest"]);
      if (verifyCode !== runtimeBytecode) {
        throw new Error("Multicall3 injection verification failed — setCode did not persist");
      }

      console.log("   ✅ Multicall3 injected at canonical address.");
      console.log("   (temp compile-target address was:", tempAddress + ")");
    }
  } else {
    // Public networks: Multicall3 is already at the canonical address by the upstream project.
    console.log("🌐 Using canonical Multicall3 at:", MULTICALL3_CANONICAL_ADDRESS);
  }

  // ✅ DEPLOY MOCK USDC
  let usdcAddress;
  let mockUSDC = null;

  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("\n=== 🪙 DEPLOYING MOCK USDC FOR LOCAL TESTING ===");
    
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();
    
    usdcAddress = await mockUSDC.getAddress();
    console.log("✅ Mock USDC deployed to:", usdcAddress);
    
    const testAccounts = accounts.slice(0, 5);
    const mintAmount = ethers.parseUnits("50000", 6);
    
    console.log("💰 Minting USDC to test accounts...");
    for (let i = 0; i < testAccounts.length; i++) {
      await mockUSDC.mint(testAccounts[i].address, mintAmount);
      const balance = await mockUSDC.balanceOf(testAccounts[i].address);
      console.log(`   Account ${i}: ${ethers.formatUnits(balance, 6)} USDC`);
    }
    console.log("✅ Mock USDC setup complete!");
    
  } else {
    if (network.name === "polygon") {
      // RECOMMENDED: native USDC on Polygon — 0x3c499c542cEF5E3811e1192ce70d8cc03d5c3359
      // (Circle-issued, 6 decimals). Do NOT use bridged USDC.e (0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174):
      // it is being deprecated and has thinner liquidity. Both are 6-decimal ERC20s,
      // so the wrong one deploys cleanly and only surfaces as broken funding later.
      usdcAddress = process.env.ADDRESS_USDCPOLYGINMAIN;
      if (!usdcAddress) {
        throw new Error("ADDRESS_USDCPOLYGINMAIN not set in .env (expected native USDC 0x3c49…3359)");
      }
      console.log("🌐 Using Polygon Mainnet USDC:", usdcAddress);
    } else if (network.name === "amoy") {
      usdcAddress = process.env.ADDRESS_USDCPOLYGINTEST;
      if (!usdcAddress) {
        throw new Error("ADDRESS_USDCPOLYGINTEST not set in .env");
      }
      console.log("🧪 Using Amoy Testnet USDC:", usdcAddress);
    } else {
      throw new Error(`Unsupported network: ${network.name}`);
    }
  }

  // ✅ DEPLOY MOCK CHAINLINK PRICE FEED
  let priceFeedAddress;
  let mockPriceFeed = null;

  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("\n=== 📊 DEPLOYING MOCK CHAINLINK PRICE FEED ===");
    
    const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
    const DECIMALS = 8;
    const INITIAL_PRICE = 23000000; // $0.23 USD per POL
    
    mockPriceFeed = await MockV3Aggregator.deploy(DECIMALS, INITIAL_PRICE);
    await mockPriceFeed.waitForDeployment();
    
    priceFeedAddress = await mockPriceFeed.getAddress();
    console.log("✅ Mock Chainlink Price Feed deployed to:", priceFeedAddress);
    console.log(`   Initial POL/USD Price: $${(INITIAL_PRICE / 10**DECIMALS).toFixed(2)}`);
    console.log(`   Decimals: ${DECIMALS}`);
    
    const newPrice = 23000000;
    await mockPriceFeed.updateAnswer(newPrice);
    console.log(`   Updated POL/USD Price: $${(newPrice / 10**DECIMALS).toFixed(2)}`);
    
  } else {
    if (network.name === "polygon") {
      priceFeedAddress = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0";
      console.log("🌐 Using Polygon Mainnet Chainlink POL/USD:", priceFeedAddress);
    } else if (network.name === "amoy") {
      priceFeedAddress = "0x001382149eBa3441043c1c66972b4772963f5D43";
      console.log("🧪 Using Amoy Testnet Chainlink POL/USD:", priceFeedAddress);
    } else {
      throw new Error(`Unsupported network: ${network.name}`);
    }
  }

  // Deploy Diamond Cut Facet
  const DiamondCutFacet = await ethers.getContractFactory('DiamondCutFacet')
  const diamondCutFacet = await DiamondCutFacet.deploy()
  await diamondCutFacet.waitForDeployment()
  console.log('DiamondCutFacet deployed:', await diamondCutFacet.getAddress())

  // Deploy Diamond
  const Diamond = await ethers.getContractFactory('Diamond')
  const diamond = await Diamond.deploy(contractOwner.address, await diamondCutFacet.getAddress())
  await diamond.waitForDeployment()
  console.log('Diamond deployed:', await diamond.getAddress())

  // Deploy DiamondInit
  const DiamondInit = await ethers.getContractFactory('DiamondInit')
  const diamondInit = await DiamondInit.deploy()
  await diamondInit.waitForDeployment()
  console.log('DiamondInit deployed:', await diamondInit.getAddress())

  // Deploy facets
  console.log('\nDeploying facets...')
  const diamondAddress = await diamond.getAddress()
  
  const FacetNames = [
    'DiamondLoupeFacet',
    'OwnershipFacet',
    'OpenAdvertsAdvertisersFacet',
    'OpenAdvertsAdvertisersVotingFacet',
    'OpenAdvertsAffiliatesFacet',
    'OpenAdvertsAffiliatesVotingFacet',
    'OpenAdvertsGovernanceFacet',
    'OpenAdvertsGovernanceHelperFacet',        // ✅ Read-only governance query/history views (split from Governance for 24KB)
    'OpenAdvertsClaimGasFloorFacet',           // ✅ Owner-set claim-gas floor assumptions (split from Governance for 24KB)
    'OpenAdvertsPayoutFacet',
    'OpenAdvertsTokenFacet',
    'OpenAdvertsAdvertPOLFactoryFacet',
    'OpenAdvertsAdvertUSDCPriceFacet',
    'OpenAdvertsAdvertUSDCHelperFacet',
    'OpenAdvertsAdvertUSDCFactoryFacet',
    'OpenAdvertsQueryFacet',                   // ✅ Query Facet for batch queries
    'OpenAdvertsQueryV2Facet',                 // ✅ Performance-optimized query facet
    'OpenAdvertsTimelockFacet',                // ✅ Phase 3: owner-authority timelock
    'OpenAdvertsPauseFacet',                   // ✅ Phase 4: system-wide emergency pause
    'OpenAdvertsSignatureGateFacet',           // ✅ Website-origin signature gate on prospect creation
    'OpenAdvertsRequestKeyFacet'               // ✅ Owner-rotated requestKey for the external KMS signing service
  ]
  
  const cut = []
  const facetAddresses = []
  for (const FacetName of FacetNames) {
    const Facet = await ethers.getContractFactory(FacetName)
    
    // ✅ All facets now require diamond address in constructor for fund forwarding
    const facet = await Facet.deploy(diamondAddress)
    
    await facet.waitForDeployment()
    const facetAddress = await facet.getAddress()
    console.log(`${FacetName} deployed: ${facetAddress}`)
    
    facetAddresses.push(facetAddress)
    cut.push({
      facetAddress: facetAddress,
      action: FacetCutAction.Add,
      functionSelectors: getSelectors(facet)
    })
  }

  // Upgrade diamond with facets
  const diamondCut = await ethers.getContractAt('IDiamondCut', diamondAddress)
  let tx
  let receipt
  let functionCall = diamondInit.interface.encodeFunctionData('init')
  tx = await diamondCut.diamondCut(cut, await diamondInit.getAddress(), functionCall)
  console.log('Diamond cut tx:', tx.hash)
  receipt = await tx.wait()
  if (!receipt.status) {
    throw Error(`Diamond upgrade failed: ${tx.hash}`)
  }
  console.log('✅ Completed diamond cut')

  // Initialize Token Facet
  console.log('\n=== 🪙 INITIALIZING TOKEN FACET ===')
  const openAdvertsTokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress);
  const initializeTokenTx = await openAdvertsTokenFacet.initialize(diamondAddress);
  await initializeTokenTx.wait();
  console.log('✅ OpenAdvertsTokenFacet initialized:', initializeTokenTx.hash);

  // Initialize Advertisers Facet WITH PRICE FEED
  console.log('\n=== 📢 INITIALIZING ADVERTISERS FACET WITH PRICE FEED ===')
  const OpenAdvertsAdvertisersFacet = await ethers.getContractAt('OpenAdvertsAdvertisersFacet', diamondAddress);
  
  console.log('Parameters:');
  console.log('  - Diamond Address:', diamondAddress);
  console.log('  - USDC Address:', usdcAddress);
  console.log('  - Price Feed Address:', priceFeedAddress);
  
  const initializeAdvertisersTx = await OpenAdvertsAdvertisersFacet.initializeAdvertisersFacet(
    diamondAddress, 
    usdcAddress,
    priceFeedAddress
  );
  await initializeAdvertisersTx.wait();
  console.log('✅ AdvertisersFacet initialized:', initializeAdvertisersTx.hash);

  // Verify initialization
  const [checkDiamond, isInitialized] = await OpenAdvertsAdvertisersFacet.returnDiamondAddressAdvertFacet();
  const usdcAddressFromContract = await OpenAdvertsAdvertisersFacet.getUSDCTokenAddress();
  const priceFeedFromContract = await OpenAdvertsAdvertisersFacet.getPriceFeedAddress();
  
  console.log('\n=== ✅ INITIALIZATION VERIFICATION ===');
  console.log('Diamond address:', checkDiamond);
  console.log('Is initialized:', isInitialized);
  console.log('USDC address:', usdcAddressFromContract);
  console.log('Price feed address:', priceFeedFromContract);

  // Initialize QueryV2 Facet
  console.log('\n=== 🔍 INITIALIZING QUERYV2 FACET ===')
  const openAdvertsQueryV2Facet = await ethers.getContractAt('OpenAdvertsQueryV2Facet', diamondAddress);
  const initializeQueryV2Tx = await openAdvertsQueryV2Facet.initializeQueryV2(
    100,   // maxPaginatedResults
    50,    // defaultPaginatedResults
    3600   // priceStalnessSeconds (1 hour)
  );
  await initializeQueryV2Tx.wait();
  console.log('✅ QueryV2Facet initialized:', initializeQueryV2Tx.hash);

  // Initialize Claim-Gas Floor assumptions (no library default — MUST be set here, else quota
  // proposal creation reverts with "Claim-gas assumptions not set"). Basis: ~90k gas/sig @ 300 gwei.
  console.log('\n=== ⛽ INITIALIZING CLAIM-GAS FLOOR ASSUMPTIONS ===')
  const CLAIM_GAS_PER_SIG = 90000;
  const CLAIM_GAS_PRICE_WEI = 300n * (10n ** 9n); // 300 gwei
  const openAdvertsClaimGasFloorFacet = await ethers.getContractAt('OpenAdvertsClaimGasFloorFacet', diamondAddress);
  const initClaimGasFloorTx = await openAdvertsClaimGasFloorFacet.setClaimGasFloorAssumptions(CLAIM_GAS_PER_SIG, CLAIM_GAS_PRICE_WEI);
  await initClaimGasFloorTx.wait();
  console.log('✅ Claim-gas floor initialized:', initClaimGasFloorTx.hash);

  // Initialize OpenAdverts Signing Key
  console.log('\n=== 🔑 INITIALIZING OPENADVERTS SIGNING KEY ===')
  const openAdvertsPayoutFacet = await ethers.getContractAt('OpenAdvertsPayoutFacet', diamondAddress);
  let openAdvertsSigningAddress = process.env.OPENADVERTS_SIGNING_ADDRESS;
  if (!openAdvertsSigningAddress) {
    if (network.name === "hardhat" || network.name === "localhost") {
      // Local-only fallback so a fresh clone can run the test suite without any .env setup.
      // Tests set their own signing address via setOpenAdvertsSigningAddress(...) in fixtures,
      // so this value is only a placeholder to get the diamond initialized. It is NEVER applied
      // to real networks: Polygon mainnet/testnets still require the real key below.
      openAdvertsSigningAddress = '0x000000000000000000000000000000000000dEaD';
      console.log('⚠️  OPENADVERTS_SIGNING_ADDRESS not set — using local dummy signing address:', openAdvertsSigningAddress);
    } else {
      throw new Error('OPENADVERTS_SIGNING_ADDRESS not set in .env');
    }
  }
  const setSigningKeyTx = await openAdvertsPayoutFacet.setOpenAdvertsSigningAddress(openAdvertsSigningAddress);
  await setSigningKeyTx.wait();
  const confirmedSigner = await openAdvertsPayoutFacet.getOpenAdvertsSigningAddress();
  console.log('✅ OpenAdverts signing address set:', confirmedSigner);

  // Initialize OpenAdverts requestKey (auth identity for the external KMS signing service).
  // Published on-chain only; rotates with ownership. Must differ from the signing address
  // and the owner, and be nonzero (enforced on-chain in setRequestKey).
  console.log('\n=== 🔑 INITIALIZING OPENADVERTS REQUEST KEY ===');
  const requestKeyFacet = await ethers.getContractAt('OpenAdvertsRequestKeyFacet', diamondAddress);
  let openAdvertsRequestKey = process.env.OPENADVERTS_REQUEST_KEY_ADDRESS;
  if (!openAdvertsRequestKey) {
    if (network.name === "hardhat" || network.name === "localhost") {
      // Local-only dummy, distinct from the dummy signing address above. Tests that need a
      // specific requestKey rotate it via setRequestKey(...)/transferOwnership(...) in fixtures.
      openAdvertsRequestKey = '0x000000000000000000000000000000000000bEEF';
      console.log('⚠️  OPENADVERTS_REQUEST_KEY_ADDRESS not set — using local dummy requestKey:', openAdvertsRequestKey);
    } else {
      throw new Error('OPENADVERTS_REQUEST_KEY_ADDRESS not set in .env');
    }
  }
  if (openAdvertsRequestKey.toLowerCase() === openAdvertsSigningAddress.toLowerCase()) {
    throw new Error('OPENADVERTS_REQUEST_KEY_ADDRESS must differ from OPENADVERTS_SIGNING_ADDRESS');
  }
  const setRequestKeyTx = await requestKeyFacet.setRequestKey(openAdvertsRequestKey);
  await setRequestKeyTx.wait();
  const confirmedRequestKey = await requestKeyFacet.getRequestKey();
  console.log('✅ OpenAdverts requestKey set:', confirmedRequestKey);

  // Set Storage Provider address on live networks. If left at address(0) the SP
  // commission share redirects to the OAD holder pool, so mainnet requires a real address.
  if (network.name !== "hardhat" && network.name !== "localhost") {
    const storageProviderAddress = process.env.STORAGE_PROVIDER_ADDRESS;
    if (!storageProviderAddress) {
      if (network.name === "polygon") {
        throw new Error("STORAGE_PROVIDER_ADDRESS not set in .env — required to deploy to Polygon mainnet.");
      }
      console.log("⚠️  STORAGE_PROVIDER_ADDRESS not set — leaving storage provider as address(0).");
    } else {
      console.log('\n=== 🗄️  SETTING STORAGE PROVIDER ADDRESS ===');
      const setStorageProviderTx = await openAdvertsPayoutFacet.changeStorageProviderAddress(storageProviderAddress);
      await setStorageProviderTx.wait();
      const confirmedStorageProvider = await openAdvertsPayoutFacet.getStorageProviderAddress();
      console.log('✅ Storage provider address set:', confirmedStorageProvider);
    }
  }

  // Finalize bootstrap on live networks (testnet + mainnet). This is the LAST setup step: all facet
  // cuts and initializations above are complete, so we irreversibly disable the owner-only direct
  // diamondCut backdoor. Future facet upgrades must go through governance. Owner-only config setters
  // (signing address, storage provider, claim-gas floor) are NOT affected and stay callable.
  // Skipped on hardhat/localhost so the test suite can exercise the open-bootstrap path.
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log('\n=== 🔒 FINALIZING BOOTSTRAP (disabling direct diamondCut) ===');
    const finalizeBootstrapTx = await openAdvertsTokenFacet.finalizeBootstrap();
    await finalizeBootstrapTx.wait();
    const bootstrapFinalized = await openAdvertsTokenFacet.isBootstrapFinalized();
    console.log('✅ Bootstrap finalized (direct diamondCut disabled):', bootstrapFinalized);
  }

  // Test price feed (local only)
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log('\n=== 🧪 TESTING PRICE FEED ===');
    
    const usdcPriceFacet = await ethers.getContractAt('OpenAdvertsAdvertUSDCPriceFacet', diamondAddress);
    
    try {
      const { price, decimals, updatedAt } = await usdcPriceFacet.getPOLUSDPrice();
      console.log(`✅ getPOLUSDPrice() Successful:`);
      console.log(`   POL/USD: $${ethers.formatUnits(price, decimals)}`);
      console.log(`   Decimals: ${decimals}`);
      console.log(`   Last Updated: ${new Date(Number(updatedAt) * 1000).toISOString()}`);
      
      const testPOLAmount = ethers.parseEther("10");
      const usdEquivalent = await usdcPriceFacet.convertPOLToUSD(testPOLAmount);
      console.log(`✅ convertPOLToUSD(10 POL) = ${ethers.formatUnits(usdEquivalent, 6)} USDC`);
      
      const testUSDAmount = ethers.parseUnits("5", 6);
      const polEquivalent = await usdcPriceFacet.convertUSDToPOL(testUSDAmount);
      console.log(`✅ convertUSDToPOL(5 USDC) = ${ethers.formatEther(polEquivalent)} POL`);
      
      const govFacet = await ethers.getContractAt('OpenAdvertsGovernanceFacet', diamondAddress);
      const currentQuotas = await govFacet.getAllCurrentQuotas();
      
      const { minBountyUSDC, minFundingUSDC } = await usdcPriceFacet.calculateMinimumUSDCRequirements(
        currentQuotas.minAdvertBountyInPOLWei,
        currentQuotas.minPOLRequiredforAdvertInWei,
        currentQuotas.USDCCurrencyPremiumInPCT
      );
      console.log(`✅ Minimum Requirements:`);
      console.log(`   Min Bounty: ${ethers.formatUnits(minBountyUSDC, 6)} USDC`);
      console.log(`   Min Funding: ${ethers.formatUnits(minFundingUSDC, 6)} USDC`);
      console.log(`   Premium: ${currentQuotas.USDCCurrencyPremiumInPCT}%`);
      
    } catch (error) {
      console.log('⚠️  Price feed test failed:', error.message);
    }
  }

  await updateFrontend(diamondAddress, usdcAddress, priceFeedAddress, mockUSDC, mockPriceFeed);

  // Export all contract addresses to a JSON file keyed by chainId, merging into
  // any existing record so a mainnet deploy never wipes the localhost entry.
  const chainEntry = {
    network: network.name,
    deployedAt: new Date().toISOString(),
    contracts: {
      diamond: diamondAddress,
      diamondCutFacet: await diamondCutFacet.getAddress(),
      diamondInit: await diamondInit.getAddress(),
      usdc: usdcAddress,
      priceFeed: priceFeedAddress,
      multicall3: multicall3Address,
      signingAddress: confirmedSigner,
      requestKey: confirmedRequestKey,
      facets: {}
    }
  };
  for (let i = 0; i < FacetNames.length; i++) {
    chainEntry.contracts.facets[FacetNames[i]] = facetAddresses[i];
  }
  const deployedAddressesPath = "./deployed-addresses.json";

  // One-time migration: older runs wrote a flat object ({ chainId, network,
  // contracts }). If we detect that shape, fold it under its own chainId key
  // before merging the current deploy so the prior data is preserved.
  let deployedRecord = readJsonSafe(deployedAddressesPath);
  if (deployedRecord && deployedRecord.contracts && deployedRecord.chainId != null) {
    const legacyChainId = String(deployedRecord.chainId);
    deployedRecord = {
      [legacyChainId]: {
        network: deployedRecord.network,
        deployedAt: deployedRecord.deployedAt,
        contracts: deployedRecord.contracts
      }
    };
  }
  deployedRecord[String(network.config.chainId)] = chainEntry;
  fs.writeFileSync(deployedAddressesPath, JSON.stringify(deployedRecord, null, 2));
  console.log(`\n✅ Contract addresses for chainId ${network.config.chainId} merged into ${deployedAddressesPath}`);

  // Verify LAST, after all addresses/ABIs are persisted, so a slow or failing explorer
  // verification never blocks saving the deployment record. Skips local networks.
  await verifyDeployment({
    diamondCutFacetAddress: await diamondCutFacet.getAddress(),
    diamondAddress: await diamond.getAddress(),
    diamondInitAddress: await diamondInit.getAddress(),
    facetNames: FacetNames,
    facetAddresses,
    contractOwnerAddress: contractOwner.address
  });

  // Return deployed addresses for testing
  return {
    diamond: diamondAddress,
    usdc: usdcAddress,
    priceFeed: priceFeedAddress
  };
}

async function verifyDeployment({
  diamondCutFacetAddress,
  diamondAddress,
  diamondInitAddress,
  facetNames,
  facetAddresses,
  contractOwnerAddress
}) {
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("\nℹ️  Skipping contract verification on local network.");
    return;
  }

  // Must mirror hardhat.config.cjs `etherscan.apiKey` (also ETHERSCAN_API_KEY), or this guard could
  // pass while the verify plugin authenticates with an empty key.
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    console.log("\n⚠️  No explorer API key found (ETHERSCAN_API_KEY). Skipping verification.");
    return;
  }

  console.log("\n=== 🔍 VERIFYING DEPLOYED CONTRACTS ===");

  await verifyContract("DiamondCutFacet", diamondCutFacetAddress, []);
  await verifyContract("Diamond", diamondAddress, [contractOwnerAddress, diamondCutFacetAddress]);
  await verifyContract("DiamondInit", diamondInitAddress, []);

  for (let i = 0; i < facetNames.length; i++) {
    // Every protocol facet is deployed with the diamond address as its sole
    // constructor argument (fund forwarding), so verification must supply it too.
    await verifyContract(facetNames[i], facetAddresses[i], [diamondAddress]);
  }
}

async function verifyContract(name, address, constructorArguments) {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await run("verify:verify", {
        address,
        constructorArguments
      });
      console.log(`✅ Verified ${name} at ${address}`);
      return;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const lower = message.toLowerCase();
      if (lower.includes("already verified")) {
        console.log(`ℹ️  ${name} already verified: ${address}`);
        return;
      }
      // Explorer has not indexed the freshly-deployed bytecode yet — back off and retry.
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


async function updateFrontend(diamondAddress, usdcAddress, priceFeedAddress, mockUSDC, mockPriceFeed) {
  const paths = {
    diamondAddress: "../feopenadverts/src/constants/diamondAddress.json",
    usdcAddress: "../feopenadverts/src/constants/usdcAddress.json",
    priceFeedAddress: "../feopenadverts/src/constants/priceFeedAddress.json",
    facetsABI: "../feopenadverts/src/constants/facetsABI.json",
    ABIs: {
      advertisers: "../feopenadverts/src/constants/advertisersABI.json",
      advertisersVoting: "../feopenadverts/src/constants/advertisersVotingABI.json",
      affiliates: "../feopenadverts/src/constants/affiliatesABI.json",
      affiliatesVoting: "../feopenadverts/src/constants/affiliatesVotingABI.json",
      governance: "../feopenadverts/src/constants/governanceABI.json",
      payout: "../feopenadverts/src/constants/payoutABI.json",
      token: "../feopenadverts/src/constants/tokenABI.json",
      loupe: "../feopenadverts/src/constants/loupeABI.json",
      ownership: "../feopenadverts/src/constants/ownershipABI.json",
      advertPOL: "../feopenadverts/src/constants/advertPOLABI.json",
      advertUSDC: "../feopenadverts/src/constants/advertUSDCABI.json",
      usdc: "../feopenadverts/src/constants/usdcABI.json",
      priceFeed: "../feopenadverts/src/constants/priceFeedABI.json",
      polFactory: "../feopenadverts/src/constants/polFactoryABI.json",
      usdcHelper: "../feopenadverts/src/constants/usdcHelperABI.json",    // ✅ RENAMED
      usdcFactory: "../feopenadverts/src/constants/usdcFactoryABI.json",
      usdcPrice: "../feopenadverts/src/constants/usdcPriceABI.json",
      query: "../feopenadverts/src/constants/queryABI.json",              // ✅ NEW: Query Facet
      queryV2: "../feopenadverts/src/constants/queryV2ABI.json"           // ✅ NEW: QueryV2 Facet
    }
  };

  await Promise.all([
    updateDiamondAddress(paths, diamondAddress),
    updateUSDCAddress(paths, usdcAddress, mockUSDC),
    updatePriceFeedAddress(paths, priceFeedAddress, mockPriceFeed),
    updateFacetABIs(paths.ABIs, diamondAddress, mockUSDC, mockPriceFeed),
  ]);
}

async function updateDiamondAddress(paths, diamondAddress) {
  try {
    mergeJsonByChainId(paths.diamondAddress, network.config.chainId, diamondAddress);
    console.log(`✅ Diamond contract address updated for chainId ${network.config.chainId}`);
  } catch (error) {
    console.error("❌ Error updating diamond address:", error);
  }
}

async function updateUSDCAddress(paths, usdcAddress, mockUSDC) {
  try {
    mergeJsonByChainId(paths.usdcAddress, network.config.chainId, {
      address: usdcAddress,
      network: network.name
    });
    console.log(`✅ USDC address updated for chainId ${network.config.chainId}`);
  } catch (error) {
    console.error("❌ Error updating USDC address:", error);
  }
}

async function updatePriceFeedAddress(paths, priceFeedAddress, mockPriceFeed) {
  try {
    const existing = readJsonSafe(paths.priceFeedAddress);
    // Seed the canonical public POL/USD feeds once; never clobber a real entry.
    if (!existing["137"]) {
      existing["137"] = {
        address: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0",
        network: "polygon",
        description: "POL/USD"
      };
    }
    if (!existing["80002"]) {
      existing["80002"] = {
        address: "0x001382149eBa3441043c1c66972b4772963f5D43",
        network: "amoy",
        description: "POL/USD"
      };
    }
    existing[String(network.config.chainId)] = {
      address: priceFeedAddress,
      network: network.name,
      description: "POL/USD"
    };
    fs.writeFileSync(paths.priceFeedAddress, JSON.stringify(existing, null, 2));
    console.log(`✅ Price feed address updated for chainId ${network.config.chainId}`);
  } catch (error) {
    console.error("❌ Error updating price feed address:", error);
  }
}

async function updateFacetABIs(ABIPaths, diamondAddress, mockUSDC, mockPriceFeed) {
  const facets = [     
    { name: "OpenAdvertsAdvertisersFacet", path: ABIPaths.advertisers },
    { name: "OpenAdvertsAdvertisersVotingFacet", path: ABIPaths.advertisersVoting },
    { name: "OpenAdvertsAffiliatesFacet", path: ABIPaths.affiliates },
    { name: "OpenAdvertsAffiliatesVotingFacet", path: ABIPaths.affiliatesVoting },
    { name: "OpenAdvertsGovernanceFacet", path: ABIPaths.governance },
    { name: "OpenAdvertsPayoutFacet", path: ABIPaths.payout },
    { name: "OpenAdvertsTokenFacet", path: ABIPaths.token },
    { name: "DiamondLoupeFacet", path: ABIPaths.loupe },
    { name: "OwnershipFacet", path: ABIPaths.ownership },
    { name: "OpenAdvertsAdvertPOLFactoryFacet", path: ABIPaths.polFactory },
    { name: "OpenAdvertsAdvertUSDCHelperFacet", path: ABIPaths.usdcHelper },    
    { name: "OpenAdvertsAdvertUSDCFactoryFacet", path: ABIPaths.usdcFactory },
    { name: "OpenAdvertsAdvertUSDCPriceFacet", path: ABIPaths.usdcPrice },
    { name: "OpenAdvertsQueryFacet", path: ABIPaths.query },
    { name: "OpenAdvertsQueryV2Facet", path: ABIPaths.queryV2 }
  ];

  for (const facet of facets) {
    try {
      const contract = await ethers.getContractAt(facet.name, diamondAddress);
      const abi = contract.interface.formatJson();
      fs.writeFileSync(facet.path, JSON.stringify(JSON.parse(abi), null, 2));
      console.log(`✅ ABI for ${facet.name} updated`);
    } catch (error) {
      console.error(`❌ Error updating ABI for ${facet.name}:`, error);
    }
  }

  // Generate advertisement contract ABIs
  try {
    const OpenAdvertsAdvertPOL = await ethers.getContractFactory('OpenAdvertsAdvertPOL');
    fs.writeFileSync(ABIPaths.advertPOL, JSON.stringify(JSON.parse(OpenAdvertsAdvertPOL.interface.formatJson()), null, 2));
    console.log(`✅ ABI for OpenAdvertsAdvertPOL updated`);
  } catch (error) {
    console.error("❌ Error updating POL advert ABI:", error);
  }

  try {
    const OpenAdvertsAdvertUSDC = await ethers.getContractFactory('OpenAdvertsAdvertUSDC');
    fs.writeFileSync(ABIPaths.advertUSDC, JSON.stringify(JSON.parse(OpenAdvertsAdvertUSDC.interface.formatJson()), null, 2));
    console.log(`✅ ABI for OpenAdvertsAdvertUSDC updated`);
  } catch (error) {
    console.error("❌ Error updating USDC advert ABI:", error);
  }

  // Only write USDC/PriceFeed ABIs if we're on local network
  if (mockUSDC && ABIPaths.usdc && (network.name === "hardhat" || network.name === "localhost")) {
    try {
      fs.writeFileSync(ABIPaths.usdc, JSON.stringify(JSON.parse(mockUSDC.interface.formatJson()), null, 2));
      console.log(`✅ ABI for USDC updated`);
    } catch (error) {
      console.error("❌ Error updating USDC ABI:", error);
    }
  }

  if (mockPriceFeed && ABIPaths.priceFeed && (network.name === "hardhat" || network.name === "localhost")) {
    try {
      fs.writeFileSync(ABIPaths.priceFeed, JSON.stringify(JSON.parse(mockPriceFeed.interface.formatJson()), null, 2));
      console.log(`✅ ABI for PriceFeed updated`);
    } catch (error) {
      console.error("❌ Error updating PriceFeed ABI:", error);
    }
  }
}

if (require.main === module) {
  deployDiamond()
    .then(() => {
      // Give file operations time to complete on Windows
      setTimeout(() => process.exit(0), 500);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

exports.deployDiamond = deployDiamond;

// async function getFacetSelectors(facetsABIPath, diamondAddress) {
//   try {
//     const facets = ["OpenAdvertsToken"
//       // , "OpenAdverts", "Advertisers", "Affiliates", "PayoutProcessor"
//     ];
//     const facetSelectors = {};

//     for (const facet of facets) {
//       const contract = await ethers.getContractAt(facet, diamondAddress);
//       const selectors = contract.interface.fragments
//         .filter((f) => f.type === "function")
//         .map((f) => contract.interface.getSighash(f.name));
//       facetSelectors[facet] = selectors;
//     }

//     fs.writeFileSync(facetsABIPath, JSON.stringify(facetSelectors, null, 2));
//     console.log("Facet selectors updated in frontend.");
//   } catch (error) {
//     console.error("Error updating facet selectors:", error);
//   }
// }// async function logTokenFacetInfo(diamondAddress) {
//   try {
//     // Get the TokenFacet contract instance from the Diamond contract
//     const tokenFacet = await ethers.getContractAt('OpenAdvertsTokenFacet', diamondAddress)
// console.log("this is the diamond address",diamondAddress)

//     // Call the token functions and log the results
//     const name = await tokenFacet.name()
//     const symbol = await tokenFacet.symbol()
//     const totalSupply = await tokenFacet.totalSupply()
//     const decimals = await tokenFacet.decimals()

//     // Let's assume you want to log the balance of the contract owner
//     const balance = await tokenFacet.balanceOf("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")

//     console.log('Token Info:');
//     console.log('Name:', name);
//     console.log('Symbol:', symbol);
//     console.log('Total Supply:', totalSupply.toString());
//     console.log('Decimals:', decimals);
//     console.log('Owner Balance:', balance.toString());
//   } catch (error) {
//     console.error("Error calling TokenFacet functions:", error)
//   }
// }
