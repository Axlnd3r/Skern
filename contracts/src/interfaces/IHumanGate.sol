// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Swappable human-verification gate used by `Registry.registerHuman`.
interface IHumanGate {
    function isHuman(address who) external view returns (bool);
}
