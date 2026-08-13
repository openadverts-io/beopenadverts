// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

contract GasConsumer {
    uint256[] public wasteGas;

    receive() external payable {
        // Consume a lot of gas to test DoS resistance
        for (uint256 i = 0; i < 1000; i++) {
            wasteGas.push(i);
        }
    }

    fallback() external payable {
        // Alternative gas consumption method
        assembly {
            for {
                let i := 0
            } lt(i, 10000) {
                i := add(i, 1)
            } {
                sstore(i, i)
            }
        }
    }
}
