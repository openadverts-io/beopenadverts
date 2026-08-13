// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

/**
 * @title RevertingReceiver
 * @notice Test-only helper used by Phase 1B pull-payment tests.
 * @dev When `active` is true, all native token transfers into this contract revert.
 *      Flip it off to simulate a recipient being fixed so they can claim via
 *      withdrawPendingPayout(). Has a `call` passthrough so the test can drive
 *      arbitrary calls (e.g. withdrawPendingPayout) from this contract's address.
 */
contract RevertingReceiver {
    bool public active = true;

    function setActive(bool _v) external {
        active = _v;
    }

    function call(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: msg.value}(data);
        require(ok, _revertReason(ret));
        return ret;
    }

    receive() external payable {
        if (active) {
            revert("RevertingReceiver: rejecting POL");
        }
    }

    fallback() external payable {
        if (active) {
            revert("RevertingReceiver: rejecting POL");
        }
    }

    function _revertReason(bytes memory ret) private pure returns (string memory) {
        if (ret.length < 68) return "RevertingReceiver: call failed";
        assembly {
            ret := add(ret, 0x04)
        }
        return abi.decode(ret, (string));
    }
}
