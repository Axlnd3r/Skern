// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHumanGate} from "./interfaces/IHumanGate.sol";

/// @title AllowlistGate
/// @notice Default `IHumanGate` for the MVP: an owner-managed allowlist (a soft human gate).
contract AllowlistGate is IHumanGate {
    error NotOwner();
    error ZeroAddress();

    event Allowed(address indexed who, bool allowed);

    address public immutable owner;
    mapping(address => bool) private _allowed;

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    function setAllowed(address who, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        _allowed[who] = allowed;
        emit Allowed(who, allowed);
    }

    function isHuman(address who) external view returns (bool) {
        return _allowed[who];
    }
}
