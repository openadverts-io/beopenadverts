// Phase 1C: Storage-layout regression test.
// Asserts every Lib*Storage namespace slot:
//   1. equals keccak256(expectedIdentifier) — catches accidental identifier drift
//   2. is pair-wise distinct — catches slot collisions that would corrupt storage
// Rationale: EIP-2535 diamonds share a single storage layout across all facets.
// A typo in a STORAGE_POSITION constant (or two libs using the same string) silently
// corrupts data and is very hard to catch any other way.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Phase 1C — Storage layout regression", function () {
    let probe;

    // (probe method name, expected namespace identifier)
    const SLOTS = [
        ["advertisersSlot", "openadverts.advertisers.storage"],
        ["affiliatesSlot", "openadverts.affiliates.storage"],
        ["governanceSlot", "openadverts.governance.storage"],
        ["payoutSlot", "openadverts.payout.storage"],
        ["querySlot", "openadverts.queryv2.storage"],
        ["tokenSlot", "openadverts.token.storage"],
        ["diamondSlot", "diamond.standard.diamond.storage"],
    ];

    before(async function () {
        const Probe = await ethers.getContractFactory("StorageLayoutProbe");
        probe = await Probe.deploy();
        await probe.waitForDeployment();
    });

    for (const [method, identifier] of SLOTS) {
        it(`${method} == keccak256("${identifier}")`, async function () {
            const actual = await probe[method]();
            const expected = ethers.keccak256(ethers.toUtf8Bytes(identifier));
            expect(actual).to.equal(expected);
        });
    }

    it("all namespace slots are pair-wise distinct (no collisions)", async function () {
        const seen = new Map();
        for (const [method, identifier] of SLOTS) {
            const slot = await probe[method]();
            if (seen.has(slot)) {
                throw new Error(
                    `Slot collision: "${identifier}" (${method}) shares slot ${slot} with "${seen.get(slot)}"`
                );
            }
            seen.set(slot, identifier);
        }
        expect(seen.size).to.equal(SLOTS.length);
    });
});
