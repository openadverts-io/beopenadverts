// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {LibOpenAdvertsAdvertisersStorage} from "./LibOpenAdvertsAdvertisersStorage.sol";
import {LibOpenAdvertsQueryStorage} from "./LibOpenAdvertsQueryStorage.sol";

interface IERC20BalanceOf {
    function balanceOf(address account) external view returns (uint256);
}

/// @title LibOpenAdvertsQueryHelpers
/// @notice Shared helpers for QueryFacet and QueryV2Facet (internal — inlined at compile time)
library LibOpenAdvertsQueryHelpers {
    function buildAdvertsWithBalances(
        LibOpenAdvertsAdvertisersStorage.AdvertStruct[] storage adverts,
        address usdcAddress
    ) internal view returns (LibOpenAdvertsQueryStorage.AdvertWithBalance[] memory result) {
        uint256 len = adverts.length;
        result = new LibOpenAdvertsQueryStorage.AdvertWithBalance[](len);

        for (uint256 i = 0; i < len; ) {
            result[i].advert = adverts[i];
            address advertAddr = adverts[i].advertContractAddress;

            if (adverts[i].advertCurrency == LibOpenAdvertsAdvertisersStorage.PaymentType.POL) {
                result[i].balance = advertAddr.balance;
                result[i].balanceReadSuccess = true;
            } else {
                if (usdcAddress == address(0)) {
                    result[i].balance = 0;
                    result[i].balanceReadSuccess = false;
                } else {
                    try IERC20BalanceOf(usdcAddress).balanceOf(advertAddr) returns (uint256 bal) {
                        result[i].balance = bal;
                        result[i].balanceReadSuccess = true;
                    } catch {
                        result[i].balance = 0;
                        result[i].balanceReadSuccess = false;
                    }
                }
            }

            unchecked {
                ++i;
            }
        }
    }
}
