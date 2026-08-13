// scripts/upgradeFacet.js
const { ethers } = require('hardhat');
const { getSelectors, FacetCutAction } = require('./libraries/diamond.js');

async function main() {
    const DIAMOND_ADDRESS = "0xYOUR_LIVE_DIAMOND_ADDRESS"; //TODO: fill in actual address
    const NEW_FACET_ADDRESS = "0xNEW_FACET_ADDRESS"; // from step 2 //TODO: fill in actual address
    
    // Get the new function selectors
    const NewFacet = await ethers.getContractAt('OpenAdvertsPayoutFacet', NEW_FACET_ADDRESS);
    const newSelectors = getSelectors(NewFacet);
    
    // Get old function selectors (already in Diamond)
    const OldFacet = await ethers.getContractAt('OpenAdvertsPayoutFacet', "0xOLD_FACET_ADDRESS");
    const oldSelectors = getSelectors(OldFacet);
    
    // Find ONLY the new function selectors
    const selectorsToAdd = newSelectors.filter(s => !oldSelectors.includes(s));
    
    console.log('New functions to add:', selectorsToAdd.length);
    
    // Prepare cut
    const cut = [{
        facetAddress: NEW_FACET_ADDRESS,
        action: FacetCutAction.Add, // Add new functions
        functionSelectors: selectorsToAdd
    }];
    
    // Execute diamond cut
    const diamondCut = await ethers.getContractAt('IDiamondCut', DIAMOND_ADDRESS);
    const tx = await diamondCut.diamondCut(
        cut,
        ethers.ZeroAddress, // No init function needed
        '0x'
    );
    
    await tx.wait();
    console.log('✅ Upgrade complete! Tx:', tx.hash);
}

main();