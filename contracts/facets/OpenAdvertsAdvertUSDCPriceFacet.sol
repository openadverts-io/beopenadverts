// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {LibOpenAdvertsTokenStorage} from "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../libraries/LibOpenAdvertsTokenStorage.sol";
import "../libraries/LibOpenAdvertsAdvertisersStorage.sol";

interface IOpenAdvertsAdvertisersFacet {
    function getPriceFeedAddress() external view returns (address);
}

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(
        uint80 _roundId
    ) external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

contract OpenAdvertsAdvertUSDCPriceFacet {
    // Immutable diamond address for direct calls
    address internal immutable diamondAddressForDirectCalls;

    // Default staleness window when storage field is 0 (Phase 1A).
    uint256 internal constant DEFAULT_ORACLE_STALENESS_SECONDS = 3600;

    constructor(address _diamondAddress) {
        diamondAddressForDirectCalls = _diamondAddress;
    }

    /**
     * @notice Retrieves the latest POL/USD price from Chainlink oracle
     * @return price The current POL price in USD (oracle-native decimals, typically 8)
     * @return decimals The number of decimals in the price (typically 8)
     * @return updatedAt The timestamp of the last price update
     * @dev Phase 1A hardening:
     *      - enforces `answeredInRound >= roundId` (rejects stale archived rounds)
     *      - uses configurable staleness (`oracleStalenessSeconds`, default 3600s)
     *      - enforces `[oracleMinPrice, oracleMaxPrice]` bounds when configured
     *      - single Chainlink feed only (no secondary feed / TWAP fallback — see plan)
     */
    function getPOLUSDPrice() public view returns (uint256 price, uint8 decimals, uint256 updatedAt) {
        address priceFeedAddress = IOpenAdvertsAdvertisersFacet(address(this)).getPriceFeedAddress();
        require(priceFeedAddress != address(0), "Price feed not initialized");

        AggregatorV3Interface priceFeed = AggregatorV3Interface(priceFeedAddress);

        try priceFeed.latestRoundData() returns (uint80 roundId, int256 answer, uint256 /* startedAt */, uint256 timestamp, uint80 answeredInRound) {
            require(answer > 0, "Invalid price from oracle");
            require(timestamp > 0, "Invalid timestamp from oracle");
            require(answeredInRound >= roundId, "Stale oracle round");

            uint256 stalenessWindow = _oracleStalenessWindow();
            require(block.timestamp - timestamp < stalenessWindow, "Price data is stale");

            uint256 priceUint = uint256(answer);
            _enforceOracleBounds(priceUint);

            return (priceUint, priceFeed.decimals(), timestamp);
        } catch {
            revert("Oracle price feed unavailable");
        }
    }

    /**
     * @notice Retrieves POL/USD price with additional validation details
     * @return price The current POL price in USD (oracle-native decimals)
     * @return decimals The number of decimals (typically 8)
     * @return updatedAt Timestamp of last update
     * @return isStale Whether the price is older than the configured staleness window
     * @return roundId The round ID from Chainlink
     * @dev Does NOT apply bounds or revert on stale round — this is a diagnostic view.
     *      Callers that need enforcement must use getPOLUSDPrice().
     */
    function getPOLUSDPriceWithMetadata() public view returns (uint256 price, uint8 decimals, uint256 updatedAt, bool isStale, uint80 roundId) {
        address priceFeedAddress = IOpenAdvertsAdvertisersFacet(address(this)).getPriceFeedAddress();
        require(priceFeedAddress != address(0), "Price feed not initialized");

        AggregatorV3Interface priceFeed = AggregatorV3Interface(priceFeedAddress);

        (uint80 _roundId, int256 answer, , uint256 timestamp, ) = priceFeed.latestRoundData();

        require(answer > 0, "Invalid price from oracle");
        require(timestamp > 0, "Invalid timestamp from oracle");

        uint256 stalenessWindow = _oracleStalenessWindow();
        return (uint256(answer), priceFeed.decimals(), timestamp, block.timestamp - timestamp > stalenessWindow, _roundId);
    }

    /**
     * @notice Returns the effective oracle staleness window in seconds.
     * @dev Reads the configured value from storage; falls back to DEFAULT_ORACLE_STALENESS_SECONDS
     *      (3600s) when the configured value is 0.
     */
    function _oracleStalenessWindow() internal view returns (uint256) {
        uint256 configured = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage().oracleStalenessSeconds;
        return configured == 0 ? DEFAULT_ORACLE_STALENESS_SECONDS : configured;
    }

    /**
     * @notice Reverts if the oracle price is outside the configured [min, max] bounds.
     * @dev Both bounds being zero disables the check entirely.
     */
    function _enforceOracleBounds(uint256 priceUint) internal view {
        LibOpenAdvertsAdvertisersStorage.OpenAdvertsAdvertisersStruct storage aas = LibOpenAdvertsAdvertisersStorage.openAdvertsAdvertisersStorage();
        uint256 minP = aas.oracleMinPrice;
        uint256 maxP = aas.oracleMaxPrice;
        if (minP == 0 && maxP == 0) {
            return; // bounds disabled
        }
        require(minP == 0 || priceUint >= minP, "Oracle price below min bound");
        require(maxP == 0 || priceUint <= maxP, "Oracle price above max bound");
    }

    /**
     * @notice Converts POL amount to USD equivalent
     * @param polAmountInWei Amount of POL in wei (18 decimals)
     * @return usdAmount USD equivalent with 6 decimals (USDC format)
     */
    function convertPOLToUSD(uint256 polAmountInWei) public view returns (uint256 usdAmount) {
        (uint256 polPrice, uint8 priceDecimals, ) = getPOLUSDPrice();
        return (polAmountInWei * polPrice) / (10 ** (18 + priceDecimals - 6));
    }

    /**
     * @notice Converts USD amount to POL equivalent
     * @param usdAmountInMicro Amount of USD in micro units (6 decimals)
     * @return polAmount POL equivalent in wei (18 decimals)
     */
    function convertUSDToPOL(uint256 usdAmountInMicro) public view returns (uint256 polAmount) {
        (uint256 polPrice, uint8 priceDecimals, ) = getPOLUSDPrice();
        require(polPrice > 0, "Invalid POL price");
        return (usdAmountInMicro * (10 ** (18 + priceDecimals - 6))) / polPrice;
    }

    /**
     * @notice Helper function to calculate minimum USDC requirements
     * @dev Converts POL minimums to USDC and applies premium
     * @param minPOLBountyInWei Minimum POL bounty in wei (18 decimals)
     * @param minPOLFundingInWei Minimum POL funding in wei (18 decimals)
     * @param usdcPremiumPCT USDC premium percentage (e.g., 10 = 10%)
     * @return minBountyUSDC Minimum bounty in micro USDC (6 decimals) with premium
     * @return minFundingUSDC Minimum funding in micro USDC (6 decimals) with premium
     */
    function calculateMinimumUSDCRequirements(
        uint256 minPOLBountyInWei,
        uint256 minPOLFundingInWei,
        uint256 usdcPremiumPCT
    ) public view returns (uint256 minBountyUSDC, uint256 minFundingUSDC) {
        (uint256 polPriceInUSD, uint8 priceDecimals, ) = getPOLUSDPrice();
        require(polPriceInUSD > 0, "Invalid POL price");

        // Convert POL to USDC base
        uint256 minBountyBase = (minPOLBountyInWei * polPriceInUSD) / (10 ** (18 + priceDecimals - 6));
        uint256 minFundingBase = (minPOLFundingInWei * polPriceInUSD) / (10 ** (18 + priceDecimals - 6));

        // Add premium
        minBountyUSDC = (minBountyBase * (100 + usdcPremiumPCT)) / 100;
        minFundingUSDC = (minFundingBase * (100 + usdcPremiumPCT)) / 100;
    }

    /**
     * @notice Gets the price feed description
     * @return description The description of the price feed
     */
    function getPriceFeedDescription() public view returns (string memory description) {
        address priceFeedAddress = IOpenAdvertsAdvertisersFacet(address(this)).getPriceFeedAddress();
        require(priceFeedAddress != address(0), "Price feed not initialized");

        AggregatorV3Interface priceFeed = AggregatorV3Interface(priceFeedAddress);
        return priceFeed.description();
    }

    /**
     * @notice Gets historical price data for a specific round
     * @param _roundId The round ID to query
     * @return roundId The round ID
     * @return price The price at that round
     * @return startedAt When the round started
     * @return updatedAt When the round was updated
     * @return answeredInRound The round in which the answer was computed
     */
    function getHistoricalPrice(
        uint80 _roundId
    ) public view returns (uint80 roundId, uint256 price, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        address priceFeedAddress = IOpenAdvertsAdvertisersFacet(address(this)).getPriceFeedAddress();
        require(priceFeedAddress != address(0), "Price feed not initialized");

        AggregatorV3Interface priceFeed = AggregatorV3Interface(priceFeedAddress);

        (uint80 _returnedRoundId, int256 answer, uint256 _startedAt, uint256 _updatedAt, uint80 _answeredInRound) = priceFeed.getRoundData(_roundId);

        require(answer > 0, "Invalid historical price");

        return (_returnedRoundId, uint256(answer), _startedAt, _updatedAt, _answeredInRound);
    }

    /**
     * @notice Receive function that forwards all funds to diamond address
     * @dev Uses facet's own immutable variable for direct calls
     */
    receive() external payable {
        require(diamondAddressForDirectCalls != address(0), "Diamond address not set");

        (bool success, ) = diamondAddressForDirectCalls.call{value: msg.value}("");
        require(success, "Transfer to diamond address failed");
    }
}
