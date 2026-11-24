// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Points
/// @notice Non-transferable integer points (no decimals). Used for entry stakes, bets and rewards.
/// @dev Roles are sets: any address the owner marks as minter may `mint`, any spender may `spend`
///      (burn). The owner manages roles only until it calls the one-way `lockRoles()`; the owner
///      has no balance-changing power of its own, so it never touches funds.
///      `transfer`, `transferFrom` and `approve` exist only to revert, making non-transferability
///      provable from the ABI.
contract Points {
    error NotOwner();
    error NotMinter();
    error NotSpender();
    error RolesAreLocked();
    error ZeroAddress();
    error NonTransferable();
    error InsufficientBalance(uint256 balance, uint256 needed);

    event Minted(address indexed to, uint256 amt);
    event Spent(address indexed from, uint256 amt);
    event MinterSet(address indexed who, bool allowed);
    event SpenderSet(address indexed who, bool allowed);
    event RolesLocked();

    string public constant name = "Consensus Points";
    string public constant symbol = "CPT";
    uint8 public constant decimals = 0;

    address public immutable owner;
    bool public rolesLocked;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public isMinter;
    mapping(address => bool) public isSpender;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    // ------------------------------------------------------------------ roles

    function setMinter(address who, bool allowed) external onlyOwner {
        if (rolesLocked) revert RolesAreLocked();
        if (who == address(0)) revert ZeroAddress();
        // forge-lint: disable-next-line(missing-events-access-control)
        isMinter[who] = allowed;
        emit MinterSet(who, allowed);
    }

    function setSpender(address who, bool allowed) external onlyOwner {
        if (rolesLocked) revert RolesAreLocked();
        if (who == address(0)) revert ZeroAddress();
        // forge-lint: disable-next-line(missing-events-access-control)
        isSpender[who] = allowed;
        emit SpenderSet(who, allowed);
    }

    /// @notice One-way: after this, no role can be granted or revoked any more.
    function lockRoles() external onlyOwner {
        if (rolesLocked) revert RolesAreLocked();
        rolesLocked = true;
        emit RolesLocked();
    }

    // ------------------------------------------------------------------ supply

    function mint(address to, uint256 amt) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        totalSupply += amt;
        balanceOf[to] += amt;
        emit Minted(to, amt);
    }

    /// @notice Burns `amt` points from `from`. There is no recipient.
    function spend(address from, uint256 amt) external {
        if (!isSpender[msg.sender]) revert NotSpender();
        uint256 bal = balanceOf[from];
        if (bal < amt) revert InsufficientBalance(bal, amt);
        unchecked {
            balanceOf[from] = bal - amt;
            totalSupply -= amt; // totalSupply >= bal >= amt
        }
        emit Spent(from, amt);
    }

    // ------------------------------------------------------------------ non-transferable

    function transfer(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }
}
