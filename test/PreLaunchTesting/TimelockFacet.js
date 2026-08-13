// Phase 3 — owner-authority timelock tests.
// Covers:
//   - initializeTimelock: owner-only, one-shot, delay bounds
//   - queueOperation: owner-only, target=diamond, returns id
//   - executeOperation: too-early, not-found, already-executed, cancelled-path, revert bubbling
//   - cancelOperation: owner instant cancel
//   - Dual-auth: pre-enforcement owner-direct works; post-enforcement owner-direct reverts;
//     queued+executed setters succeed
//   - Regression: each of the 6 wrapped setters reachable via timelock path

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployDiamond } = require("../../scripts/deploy.js");

const DELAY = 3600;       // 1 hour
const MIN_DELAY = 3600;
const MAX_DELAY = 30 * 24 * 3600;

async function queueAndGetId(timelock, target, data, signer) {
    const tx = await timelock.connect(signer).queueOperation(target, data);
    const rc = await tx.wait();
    // OperationQueued(bytes32 indexed id, address indexed target, uint256 readyAt, bytes data)
    const iface = timelock.interface;
    for (const log of rc.logs) {
        try {
            const parsed = iface.parseLog(log);
            if (parsed && parsed.name === "OperationQueued") {
                return parsed.args.id;
            }
        } catch (_) { /* not ours */ }
    }
    throw new Error("OperationQueued event not found");
}

describe("Phase 3 — Owner-Authority Timelock", function () {
    let diamondAddress;
    let timelock;
    let advertisers;
    let payout;
    let queryV2;
    let owner;
    let nonOwner;

    beforeEach(async function () {
        [owner, nonOwner] = await ethers.getSigners();
        const deployed = await deployDiamond();
        diamondAddress = deployed.diamond;
        timelock     = await ethers.getContractAt("OpenAdvertsTimelockFacet",   diamondAddress);
        advertisers  = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
        payout       = await ethers.getContractAt("OpenAdvertsPayoutFacet",      diamondAddress);
        queryV2      = await ethers.getContractAt("OpenAdvertsQueryV2Facet",     diamondAddress);
    });

    // ---------------------------------------------------------------------
    // initializeTimelock
    // ---------------------------------------------------------------------
    describe("initializeTimelock", function () {
        it("reverts for non-owner", async function () {
            await expect(timelock.connect(nonOwner).initializeTimelock(DELAY))
                .to.be.revertedWith("LibDiamond: Must be contract owner");
        });

        it("rejects delay below MIN_TIMELOCK_DELAY", async function () {
            await expect(timelock.connect(owner).initializeTimelock(MIN_DELAY - 1))
                .to.be.revertedWith("Delay out of range");
        });

        it("rejects delay above MAX_TIMELOCK_DELAY", async function () {
            await expect(timelock.connect(owner).initializeTimelock(MAX_DELAY + 1))
                .to.be.revertedWith("Delay out of range");
        });

        it("initializes exactly once and emits event", async function () {
            await expect(timelock.connect(owner).initializeTimelock(DELAY))
                .to.emit(timelock, "TimelockInitialized").withArgs(DELAY);
            const cfg = await timelock.getTimelockConfig();
            expect(cfg.initialized).to.equal(true);
            expect(cfg.enforced).to.equal(false);
            expect(cfg.inExecution).to.equal(false);
            expect(cfg.delaySeconds).to.equal(DELAY);

            await expect(timelock.connect(owner).initializeTimelock(DELAY))
                .to.be.revertedWith("Timelock already initialized");
        });
    });

    // ---------------------------------------------------------------------
    // queueOperation
    // ---------------------------------------------------------------------
    describe("queueOperation", function () {
        it("reverts before initialization", async function () {
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            await expect(timelock.connect(owner).queueOperation(diamondAddress, data))
                .to.be.revertedWith("Timelock not initialized");
        });

        describe("after initialization", function () {
            beforeEach(async function () {
                await timelock.connect(owner).initializeTimelock(DELAY);
            });

            it("reverts for non-owner", async function () {
                const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
                await expect(timelock.connect(nonOwner).queueOperation(diamondAddress, data))
                    .to.be.revertedWith("LibDiamond: Must be contract owner");
            });

            it("reverts when target is not the diamond", async function () {
                const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
                await expect(timelock.connect(owner).queueOperation(nonOwner.address, data))
                    .to.be.revertedWith("Target must be diamond");
            });

            it("reverts on empty calldata", async function () {
                await expect(timelock.connect(owner).queueOperation(diamondAddress, "0x"))
                    .to.be.revertedWith("Empty calldata");
            });

            it("queues successfully and stores readyAt = now + delay", async function () {
                const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
                const id = await queueAndGetId(timelock, diamondAddress, data, owner);
                const op = await timelock.getOperation(id);
                expect(op.target).to.equal(diamondAddress);
                expect(op.executedAt).to.equal(0);
                expect(op.cancelledAt).to.equal(0);
                const now = BigInt(await time.latest());
                expect(op.readyAt).to.be.closeTo(now + BigInt(DELAY), 5n);
                expect(op.data).to.equal(data);
            });
        });
    });

    // ---------------------------------------------------------------------
    // executeOperation
    // ---------------------------------------------------------------------
    describe("executeOperation", function () {
        beforeEach(async function () {
            await timelock.connect(owner).initializeTimelock(DELAY);
        });

        it("reverts for unknown op", async function () {
            await expect(timelock.connect(owner).executeOperation(ethers.ZeroHash))
                .to.be.revertedWith("Op not found");
        });

        it("reverts before readyAt", async function () {
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await expect(timelock.connect(owner).executeOperation(id))
                .to.be.revertedWith("Too early");
        });

        it("reverts for non-owner", async function () {
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await time.increase(DELAY + 1);
            await expect(timelock.connect(nonOwner).executeOperation(id))
                .to.be.revertedWith("LibDiamond: Must be contract owner");
        });

        it("executes once, then rejects re-execution", async function () {
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await time.increase(DELAY + 1);
            await expect(timelock.connect(owner).executeOperation(id))
                .to.emit(timelock, "OperationExecuted").withArgs(id);
            expect(await advertisers.getOracleStalenessSeconds()).to.equal(1800);
            await expect(timelock.connect(owner).executeOperation(id))
                .to.be.revertedWith("Already executed");
        });

        it("bubbles revert reason from the wrapped setter", async function () {
            // Staleness out of range — should propagate.
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await time.increase(DELAY + 1);
            await expect(timelock.connect(owner).executeOperation(id))
                .to.be.revertedWith("Staleness out of range");
        });

        it("clears inExecution after the call (success or revert)", async function () {
            // Success path first.
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await time.increase(DELAY + 1);
            await timelock.connect(owner).executeOperation(id);
            let cfg = await timelock.getTimelockConfig();
            expect(cfg.inExecution).to.equal(false);

            // Revert path.
            const badData = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1]);
            const id2 = await queueAndGetId(timelock, diamondAddress, badData, owner);
            await time.increase(DELAY + 1);
            await expect(timelock.connect(owner).executeOperation(id2)).to.be.reverted;
            cfg = await timelock.getTimelockConfig();
            expect(cfg.inExecution).to.equal(false);
        });
    });

    // ---------------------------------------------------------------------
    // cancelOperation
    // ---------------------------------------------------------------------
    describe("cancelOperation", function () {
        beforeEach(async function () {
            await timelock.connect(owner).initializeTimelock(DELAY);
        });

        it("reverts for non-owner", async function () {
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await expect(timelock.connect(nonOwner).cancelOperation(id))
                .to.be.revertedWith("LibDiamond: Must be contract owner");
        });

        it("cancels instantly and blocks execution", async function () {
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await expect(timelock.connect(owner).cancelOperation(id))
                .to.emit(timelock, "OperationCancelled").withArgs(id);
            await time.increase(DELAY + 1);
            await expect(timelock.connect(owner).executeOperation(id))
                .to.be.revertedWith("Cancelled");
        });

        it("rejects double-cancel and post-execution cancel", async function () {
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await timelock.connect(owner).cancelOperation(id);
            await expect(timelock.connect(owner).cancelOperation(id))
                .to.be.revertedWith("Already cancelled");

            const data2 = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1801]);
            const id2 = await queueAndGetId(timelock, diamondAddress, data2, owner);
            await time.increase(DELAY + 1);
            await timelock.connect(owner).executeOperation(id2);
            await expect(timelock.connect(owner).cancelOperation(id2))
                .to.be.revertedWith("Already executed");
        });
    });

    // ---------------------------------------------------------------------
    // Dual-auth flip
    // ---------------------------------------------------------------------
    describe("Dual-auth enforcement flip", function () {
        beforeEach(async function () {
            await timelock.connect(owner).initializeTimelock(DELAY);
        });

        it("pre-enforcement: owner-direct setter calls succeed", async function () {
            await advertisers.connect(owner).setOracleStalenessSeconds(1800);
            expect(await advertisers.getOracleStalenessSeconds()).to.equal(1800);
        });

        it("post-enforcement: owner-direct reverts; queued+executed succeeds", async function () {
            // Flip enforcement on (direct call allowed since enforced was still false).
            await timelock.connect(owner).setTimelockEnforcement(true);
            const cfg = await timelock.getTimelockConfig();
            expect(cfg.enforced).to.equal(true);

            // Direct call now rejected.
            await expect(advertisers.connect(owner).setOracleStalenessSeconds(1800))
                .to.be.revertedWith("Must go through timelock");

            // Queue + execute succeeds.
            const data = advertisers.interface.encodeFunctionData("setOracleStalenessSeconds", [1800]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await time.increase(DELAY + 1);
            await timelock.connect(owner).executeOperation(id);
            expect(await advertisers.getOracleStalenessSeconds()).to.equal(1800);
        });

        it("post-enforcement: setTimelockDelay itself must route through timelock", async function () {
            await timelock.connect(owner).setTimelockEnforcement(true);
            await expect(timelock.connect(owner).setTimelockDelay(7200))
                .to.be.revertedWith("Must go through timelock");

            const data = timelock.interface.encodeFunctionData("setTimelockDelay", [7200]);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await time.increase(DELAY + 1);
            await timelock.connect(owner).executeOperation(id);
            const cfg = await timelock.getTimelockConfig();
            expect(cfg.delaySeconds).to.equal(7200);
        });
    });

    // ---------------------------------------------------------------------
    // Wrapped-setter coverage
    // ---------------------------------------------------------------------
    describe("All 6 wrapped setters are reachable via timelock", function () {
        beforeEach(async function () {
            await timelock.connect(owner).initializeTimelock(DELAY);
            await timelock.connect(owner).setTimelockEnforcement(true);
        });

        async function execThrough(iface, fn, args) {
            const data = iface.encodeFunctionData(fn, args);
            const id = await queueAndGetId(timelock, diamondAddress, data, owner);
            await time.increase(DELAY + 1);
            await timelock.connect(owner).executeOperation(id);
        }

        it("setUSDCTokenAddress", async function () {
            await execThrough(advertisers.interface, "setUSDCTokenAddress", [owner.address]);
        });

        it("setPriceFeedAddress", async function () {
            await execThrough(advertisers.interface, "setPriceFeedAddress", [owner.address]);
        });

        it("setOracleStalenessSeconds", async function () {
            await execThrough(advertisers.interface, "setOracleStalenessSeconds", [1800]);
            expect(await advertisers.getOracleStalenessSeconds()).to.equal(1800);
        });

        it("setOraclePriceBounds", async function () {
            await execThrough(advertisers.interface, "setOraclePriceBounds", [1, 1_000_000_000_000n]);
        });

        it("setOpenAdvertsSigningAddress", async function () {
            await execThrough(payout.interface, "setOpenAdvertsSigningAddress", [owner.address]);
            expect(await payout.getOpenAdvertsSigningAddress()).to.equal(owner.address);
        });

        it("setPriceStalnessSeconds", async function () {
            await execThrough(queryV2.interface, "setPriceStalnessSeconds", [1800]);
        });
    });
});
