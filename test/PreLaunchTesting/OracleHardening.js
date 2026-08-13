// Phase 1A: Oracle hardening tests.
// Covers:
//   - configurable staleness window (default 3600s; bounded [60, 86400])
//   - price sanity bounds (disabled by default; require min < max when enabled)
//   - answeredInRound >= roundId enforcement
//   - owner-only gating on the setters
//   - default-behaviour preservation (fresh compile, vanilla mock → reads succeed)

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../../scripts/deploy.js");

describe("Phase 1A — Oracle Hardening", function () {
    let diamondAddress;
    let advertisersFacet;
    let priceFacet;
    let mockPriceFeed;
    let owner;
    let nonOwner;

    before(async function () {
        [owner, nonOwner] = await ethers.getSigners();
        const deployed = await deployDiamond();
        diamondAddress = deployed.diamond;

        advertisersFacet = await ethers.getContractAt("OpenAdvertsAdvertisersFacet", diamondAddress);
        priceFacet = await ethers.getContractAt("OpenAdvertsAdvertUSDCPriceFacet", diamondAddress);
        mockPriceFeed = await ethers.getContractAt("MockV3Aggregator", deployed.priceFeed);
    });

    describe("Configuration: staleness", function () {
        it("returns 0 by default (price facet uses hard-coded 3600s default)", async function () {
            expect(await advertisersFacet.getOracleStalenessSeconds()).to.equal(0);
        });

        it("rejects setting from non-owner", async function () {
            await expect(
                advertisersFacet.connect(nonOwner).setOracleStalenessSeconds(1800)
            ).to.be.revertedWith("LibDiamond: Must be contract owner");
        });

        it("rejects values below 60 seconds", async function () {
            await expect(
                advertisersFacet.connect(owner).setOracleStalenessSeconds(59)
            ).to.be.revertedWith("Staleness out of range");
        });

        it("rejects values above 24h", async function () {
            await expect(
                advertisersFacet.connect(owner).setOracleStalenessSeconds(24 * 3600 + 1)
            ).to.be.revertedWith("Staleness out of range");
        });

        it("accepts valid values and emits event", async function () {
            await expect(
                advertisersFacet.connect(owner).setOracleStalenessSeconds(1800)
            ).to.emit(advertisersFacet, "OracleStalenessUpdated").withArgs(0, 1800);

            expect(await advertisersFacet.getOracleStalenessSeconds()).to.equal(1800);
        });

        it("configured value is honoured by getPOLUSDPrice (fresh price still passes)", async function () {
            // Reset to default so we don't affect downstream describes.
            await advertisersFacet.connect(owner).setOracleStalenessSeconds(3600);
            const [price] = await priceFacet.getPOLUSDPrice();
            expect(price).to.be.gt(0);
        });
    });

    describe("Configuration: price bounds", function () {
        it("returns (0, 0) by default (bounds disabled)", async function () {
            const [min, max] = await advertisersFacet.getOraclePriceBounds();
            expect(min).to.equal(0);
            expect(max).to.equal(0);
        });

        it("rejects setting from non-owner", async function () {
            await expect(
                advertisersFacet.connect(nonOwner).setOraclePriceBounds(1, 2)
            ).to.be.revertedWith("LibDiamond: Must be contract owner");
        });

        it("rejects partial-zero (must use (0,0) to disable)", async function () {
            await expect(
                advertisersFacet.connect(owner).setOraclePriceBounds(0, 100)
            ).to.be.revertedWith("Use (0,0) to disable bounds");
            await expect(
                advertisersFacet.connect(owner).setOraclePriceBounds(100, 0)
            ).to.be.revertedWith("Use (0,0) to disable bounds");
        });

        it("rejects min >= max", async function () {
            await expect(
                advertisersFacet.connect(owner).setOraclePriceBounds(500, 500)
            ).to.be.revertedWith("minPrice must be < maxPrice");
            await expect(
                advertisersFacet.connect(owner).setOraclePriceBounds(600, 500)
            ).to.be.revertedWith("minPrice must be < maxPrice");
        });

        it("accepts valid bounds and emits event", async function () {
            await expect(
                advertisersFacet.connect(owner).setOraclePriceBounds(10_000_000n, 1_000_000_000n)
            )
                .to.emit(advertisersFacet, "OraclePriceBoundsUpdated")
                .withArgs(0, 0, 10_000_000n, 1_000_000_000n);

            const [min, max] = await advertisersFacet.getOraclePriceBounds();
            expect(min).to.equal(10_000_000n);
            expect(max).to.equal(1_000_000_000n);
        });

        it("explicit disable (0,0) is allowed from a set state", async function () {
            await expect(
                advertisersFacet.connect(owner).setOraclePriceBounds(0, 0)
            ).to.emit(advertisersFacet, "OraclePriceBoundsUpdated");

            const [min, max] = await advertisersFacet.getOraclePriceBounds();
            expect(min).to.equal(0);
            expect(max).to.equal(0);
        });
    });

    describe("Enforcement in getPOLUSDPrice", function () {
        beforeEach(async function () {
            // Clean slate for each test.
            await advertisersFacet.connect(owner).setOraclePriceBounds(0, 0);
            await mockPriceFeed.setUseStoredTimestamp(false);
        });

        it("reverts when price is below configured min", async function () {
            // Mock returns price of 50_000_000 (≈ $0.50 at 8 decimals) per deploy init.
            const [currentPrice] = await priceFacet.getPOLUSDPrice();
            const tooHighMin = currentPrice + 1n;
            await advertisersFacet.connect(owner).setOraclePriceBounds(tooHighMin, tooHighMin + 1n);

            await expect(priceFacet.getPOLUSDPrice()).to.be.revertedWith("Oracle price below min bound");
        });

        it("reverts when price is above configured max", async function () {
            const [currentPrice] = await priceFacet.getPOLUSDPrice();
            // Place max strictly below current price.
            await advertisersFacet.connect(owner).setOraclePriceBounds(1n, currentPrice - 1n);

            await expect(priceFacet.getPOLUSDPrice()).to.be.revertedWith("Oracle price above max bound");
        });

        it("passes when price sits inside the configured band", async function () {
            const [currentPrice] = await priceFacet.getPOLUSDPrice();
            await advertisersFacet.connect(owner).setOraclePriceBounds(currentPrice / 2n, currentPrice * 2n);

            const [price] = await priceFacet.getPOLUSDPrice();
            expect(price).to.equal(currentPrice);
        });

        it("reverts on stale round (answeredInRound < roundId)", async function () {
            // Latest round is whatever the deploy init produced; grab it.
            const latestRound = await mockPriceFeed.latestRound();
            // Override: oracle answered this round in an earlier round.
            await mockPriceFeed.setAnsweredInRound(latestRound, 1);

            await expect(priceFacet.getPOLUSDPrice()).to.be.revertedWith("Stale oracle round");

            // Reset override.
            await mockPriceFeed.setAnsweredInRound(latestRound, latestRound);
        });

        it("reverts when price is stale against the configured window", async function () {
            // Switch mock to stored-timestamp mode, then write a round dated far in the past.
            const blockTs = (await ethers.provider.getBlock("latest")).timestamp;
            const staleTs = blockTs - 7200; // 2h old
            // latestRound + 1 so it becomes the new latest.
            const newRoundId = (await mockPriceFeed.latestRound()) + 1n;
            await mockPriceFeed.updateRoundData(newRoundId, 50_000_000n, staleTs, staleTs);
            await mockPriceFeed.setUseStoredTimestamp(true);

            // Default window is 3600s → 7200s should be stale.
            await expect(priceFacet.getPOLUSDPrice()).to.be.revertedWith("Price data is stale");

            // Restore.
            await mockPriceFeed.setUseStoredTimestamp(false);
        });
    });

    describe("getPOLUSDPriceWithMetadata", function () {
        it("does NOT enforce bounds (diagnostic view)", async function () {
            const [currentPrice] = await priceFacet.getPOLUSDPrice();
            // Set impossible min, then call metadata variant — it must not revert.
            await advertisersFacet.connect(owner).setOraclePriceBounds(currentPrice + 1n, currentPrice + 2n);

            const [price, , , isStale] = await priceFacet.getPOLUSDPriceWithMetadata();
            expect(price).to.equal(currentPrice);
            expect(isStale).to.equal(false);

            // Reset.
            await advertisersFacet.connect(owner).setOraclePriceBounds(0, 0);
        });

        it("isStale flag reflects configured staleness window", async function () {
            const blockTs = (await ethers.provider.getBlock("latest")).timestamp;
            const staleTs = blockTs - 7200;
            const newRoundId = (await mockPriceFeed.latestRound()) + 1n;
            await mockPriceFeed.updateRoundData(newRoundId, 50_000_000n, staleTs, staleTs);
            await mockPriceFeed.setUseStoredTimestamp(true);

            const [, , , isStale] = await priceFacet.getPOLUSDPriceWithMetadata();
            expect(isStale).to.equal(true);

            await mockPriceFeed.setUseStoredTimestamp(false);
        });
    });
});
