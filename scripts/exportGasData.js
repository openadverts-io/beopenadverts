const fs = require('fs');
const { ethers } = require("hardhat");

async function exportGasAnalysis() {
    console.log("📊 Exporting detailed gas analysis to CSV...");
    
    // Deploy contracts and setup
    const [owner, affiliate, viewer, ...thirdPartyAddresses] = await ethers.getSigners();
    
    // ✅ STRICT: Require 150+ addresses for accurate gas testing
    if (thirdPartyAddresses.length < 150) {
        console.error("❌ INSUFFICIENT SIGNERS FOR ACCURATE GAS ANALYSIS");
        console.error(`   Required: 150+ third-party addresses`);
        console.error(`   Available: ${thirdPartyAddresses.length}`);
        console.error(`   Update hardhat.config.js: networks.hardhat.accounts.count = 200`);
        throw new Error("Need at least 150 unique third-party signers for accurate gas analysis");
    }

    console.log(`✅ ${thirdPartyAddresses.length} third-party addresses available`);

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    // Deploy Diamond
    const Diamond = await ethers.getContractFactory("Diamond");
    const diamond = await Diamond.deploy(owner.address, await mockUSDC.getAddress());
    await diamond.waitForDeployment();
    const diamondAddress = await diamond.getAddress();

    // Setup facets (you'll need to add your actual diamond cut logic here)
    const advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
    
    // Initialize
    await advertisersFacet.initializeAdvertisersFacet(diamondAddress, await mockUSDC.getAddress());

    // Setup USDC
    await mockUSDC.mint(owner.address, ethers.parseUnits("1000000", 6));
    await mockUSDC.mint(viewer.address, ethers.parseUnits("100000", 6));

    // Create advertisement
    const usdcFundingAmount = ethers.parseUnits("10000", 6);
    await mockUSDC.connect(viewer).approve(diamondAddress, usdcFundingAmount);
    
    await advertisersFacet.connect(viewer).createNewProspectAdvertContract(
        "test-storage-id",
        ethers.parseUnits("10", 6),
        100,
        [],
        usdcFundingAmount
    );

    const prospectAds = await advertisersFacet.getAdvertisements(0);
    const advertContract = await ethers.getContractAt("OpenAdvertsAdvert", prospectAds[0].advertContractAddress);

    // Helper functions
    function generateUniqueThirdPartyStructs(count) {
        const structs = [];
        for (let i = 0; i < count; i++) {
            structs.push({
                thirdPartyAddresses: [
                    thirdPartyAddresses[i * 3].address,
                    thirdPartyAddresses[i * 3 + 1].address,
                    thirdPartyAddresses[i * 3 + 2].address
                ]
            });
        }
        return structs;
    }

    async function generateSignatures(count, nonce) {
        const signatures = [];
        const blockNumbers = [];
        const thirdPartyStructs = generateUniqueThirdPartyStructs(count);
        const currentBlock = await ethers.provider.getBlockNumber();
        const chainId = (await ethers.provider.getNetwork()).chainId;

        for (let i = 0; i < count; i++) {
            const blockNumber = currentBlock + i * 150;
            blockNumbers.push(blockNumber);

            const tpAddrs = thirdPartyStructs[i].thirdPartyAddresses;
            const tpCount = BigInt(tpAddrs.length);
            const paddedHex = tpAddrs.map(a => ethers.zeroPadValue(a, 32)).join('').replace(/0x/g, '');
            const tpHash = ethers.keccak256('0x' + paddedHex);

            const messageHash = ethers.solidityPackedKeccak256(
                ["uint256", "address", "address", "uint256", "uint256", "address", "address", "uint256", "bytes32", "uint256"],
                [
                    chainId,
                    diamondAddress,
                    viewer.address,
                    blockNumber,
                    nonce,
                    affiliate.address,
                    await advertContract.getAddress(),
                    tpCount,
                    tpHash,
                    ethers.parseUnits("10", 6)
                ]
            );

            const signature = await affiliate.signMessage(ethers.getBytes(messageHash));
            signatures.push(signature);
        }

        return { signatures, blockNumbers, thirdPartyStructs };
    }

    // Collect gas data
    const gasData = [];
    console.log("Collecting gas data for 1-50 signatures...");

    for (let sigCount = 1; sigCount <= 50; sigCount++) {
        try {
            const nonce = await advertContract.getUserNonceOfAffiliate(affiliate.address);
            const { signatures, blockNumbers, thirdPartyStructs } = await generateSignatures(sigCount, nonce);

            const verificationData = {
                affiliateReceivingAddress: affiliate.address,
                affiliateClaimInfoAddress: affiliate.address,
                affiliateSigningAddress: affiliate.address,
                advertismentContractAddress: await advertContract.getAddress(),
                nonce: nonce
            };

            const gasEstimate = await advertContract.connect(viewer).processReward.estimateGas(
                signatures,
                blockNumbers,
                verificationData,
                thirdPartyStructs
            );

            const gasUsed = Number(gasEstimate);
            const gasPerSignature = Math.round(gasUsed / sigCount);
            const uniqueAddresses = sigCount * 3 + 2;
            const transfers = sigCount * 3 + 2;
            const gasPerTransfer = Math.round(gasUsed / transfers);

            gasData.push({
                signatures: sigCount,
                gasUsed: gasUsed,
                gasPerSignature: gasPerSignature,
                uniqueAddresses: uniqueAddresses,
                transfers: transfers,
                gasPerTransfer: gasPerTransfer
            });

            console.log(`✅ ${sigCount} signatures: ${gasUsed.toLocaleString()} gas`);

        } catch (error) {
            console.log(`❌ ${sigCount} signatures: ${error.message}`);
        }
    }
    
    // Export to CSV
    const csvHeader = "Signatures,GasUsed,GasPerSignature,UniqueAddresses,EstimatedTransfers,GasPerTransfer\n";
    const csvRows = gasData.map(row => 
        `${row.signatures},${row.gasUsed},${row.gasPerSignature},${row.uniqueAddresses},${row.transfers},${row.gasPerTransfer}`
    ).join('\n');
    
    fs.writeFileSync('gas-analysis-results.csv', csvHeader + csvRows);
    console.log("✅ Gas analysis exported to gas-analysis-results.csv");

    // Also create a summary report
    const summaryData = {
        totalTestCases: gasData.length,
        avgGasPerSignature: Math.round(gasData.reduce((sum, row) => sum + row.gasPerSignature, 0) / gasData.length),
        minGasPerSignature: Math.min(...gasData.map(row => row.gasPerSignature)),
        maxGasPerSignature: Math.max(...gasData.map(row => row.gasPerSignature)),
        avgGasPerTransfer: Math.round(gasData.reduce((sum, row) => sum + row.gasPerTransfer, 0) / gasData.length),
        efficiency: gasData.length > 0 ? (gasData[gasData.length - 1].gasUsed / gasData[0].gasUsed) / 50 : 0
    };

    const summaryReport = `
Gas Analysis Summary Report
==========================
Generated: ${new Date().toISOString()}

Total test cases: ${summaryData.totalTestCases}
Average gas per signature: ${summaryData.avgGasPerSignature.toLocaleString()}
Minimum gas per signature: ${summaryData.minGasPerSignature.toLocaleString()}
Maximum gas per signature: ${summaryData.maxGasPerSignature.toLocaleString()}
Average gas per transfer: ${summaryData.avgGasPerTransfer.toLocaleString()}
Gas efficiency ratio (50 vs 1 sig): ${summaryData.efficiency.toFixed(2)}x

Data exported to: gas-analysis-results.csv
`;

    fs.writeFileSync('gas-analysis-summary.txt', summaryReport);
    console.log("📋 Summary report exported to gas-analysis-summary.txt");
}

if (require.main === module) {
    exportGasAnalysis().catch(console.error);
}

module.exports = { exportGasAnalysis };