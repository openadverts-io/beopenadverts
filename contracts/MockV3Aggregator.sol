// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(
        uint80 _roundId
    ) external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * @title MockV3Aggregator
 * @notice Mock Chainlink price feed for testing
 */
contract MockV3Aggregator is AggregatorV3Interface {
    uint256 public constant override version = 0;

    uint8 public override decimals;
    int256 public latestAnswer;
    uint256 public latestTimestamp;
    uint256 public latestRound;

    mapping(uint256 => int256) public getAnswer;
    mapping(uint256 => uint256) public getTimestamp;
    mapping(uint256 => uint256) private getStartedAt;

    // Phase 1A test hooks (default to legacy behaviour to preserve existing tests).
    // When `useStoredTimestamp` is true, latestRoundData() returns `getTimestamp[latestRound]`
    // instead of `block.timestamp` — lets tests exercise the staleness check.
    bool public useStoredTimestamp;
    // Per-round override for `answeredInRound`. Zero = fall back to `latestRound` (legacy).
    mapping(uint256 => uint80) public answeredInRoundOverride;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        updateAnswer(_initialAnswer);
    }

    function updateAnswer(int256 _answer) public {
        latestAnswer = _answer;
        latestTimestamp = block.timestamp;
        latestRound++;
        getAnswer[latestRound] = _answer;
        getTimestamp[latestRound] = block.timestamp;
        getStartedAt[latestRound] = block.timestamp;
    }

    function updateRoundData(uint80 _roundId, int256 _answer, uint256 _timestamp, uint256 _startedAt) public {
        latestRound = _roundId;
        latestAnswer = _answer;
        latestTimestamp = _timestamp;
        getAnswer[latestRound] = _answer;
        getTimestamp[latestRound] = _timestamp;
        getStartedAt[latestRound] = _startedAt;
    }

    // Phase 1A: toggle whether latestRoundData() returns stored or block.timestamp.
    function setUseStoredTimestamp(bool _v) external {
        useStoredTimestamp = _v;
    }

    // Phase 1A: override `answeredInRound` for a given round to simulate a stale round.
    function setAnsweredInRound(uint256 _roundId, uint80 _answeredInRound) external {
        answeredInRoundOverride[_roundId] = _answeredInRound;
    }

    function getRoundData(
        uint80 _roundId
    ) external view override returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        uint80 air = answeredInRoundOverride[_roundId];
        if (air == 0) {
            air = _roundId;
        }
        return (_roundId, getAnswer[_roundId], getStartedAt[_roundId], getTimestamp[_roundId], air);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        // Phase 1A: if toggled, return the stored timestamp (lets tests exercise staleness).
        // Default behaviour is unchanged — returns block.timestamp so existing dev/test runs
        // never see "Price data is stale" spuriously.
        uint256 ts = useStoredTimestamp ? getTimestamp[latestRound] : block.timestamp;
        uint80 air = answeredInRoundOverride[latestRound];
        if (air == 0) {
            air = uint80(latestRound);
        }
        return (uint80(latestRound), getAnswer[latestRound], getStartedAt[latestRound], ts, air);
    }

    function description() external pure override returns (string memory) {
        return "v0.8/tests/MockV3Aggregator.sol";
    }
}
