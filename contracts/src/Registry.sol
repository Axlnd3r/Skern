// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Points} from "./Points.sol";
import {IHumanGate} from "./interfaces/IHumanGate.sol";
import {IArenaState} from "./interfaces/IArenaState.sol";

/// @dev Declared at file level so Arena and GapMarket can import it.
enum Kind {
    None,
    Human,
    Agent
}

/// @title Registry
/// @notice Marks an address as `Human` (via a swappable `IHumanGate`) or `Agent` (declared, bonded).
/// @dev Registration mints `STARTER_GRANT` points; agents then burn `AGENT_BOND` of them.
///      Needs both the minter and the spender role on `Points`.
contract Registry {
    error NotOwner();
    error ZeroAddress();
    error AlreadyRegistered();
    error NotHuman();
    error NotRegistered();
    error InvalidKind();
    error SameKind();
    error ArenaNotSet();
    error ArenaAlreadySet();
    error CommitWindowOpen();

    event Registered(address indexed who, Kind kind, string metadataURI);
    event Reclassified(address indexed who, Kind oldKind, Kind newKind);
    event GateChanged(IHumanGate gate);
    event ArenaSet(IArenaState arena);

    uint256 public constant STARTER_GRANT = 1000;
    uint256 public constant AGENT_BOND = 100;

    address public immutable owner;
    Points public immutable points;
    IHumanGate public gate;
    IArenaState public arena;

    mapping(address => Kind) public kindOf;
    mapping(address => string) public metadataURI;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(Points points_, IHumanGate gate_, address owner_) {
        if (address(points_) == address(0) || address(gate_) == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        points = points_;
        gate = gate_;
        owner = owner_;
    }

    // ------------------------------------------------------------------ admin

    function setGate(IHumanGate gate_) external onlyOwner {
        if (address(gate_) == address(0)) revert ZeroAddress();
        gate = gate_;
        emit GateChanged(gate_);
    }

    /// @notice Set-once. Until set, `reclassify` is disabled.
    function setArena(IArenaState arena_) external onlyOwner {
        if (address(arena_) == address(0)) revert ZeroAddress();
        if (address(arena) != address(0)) revert ArenaAlreadySet();
        arena = arena_;
        emit ArenaSet(arena_);
    }

    // ------------------------------------------------------------------ registration

    function registerHuman() external {
        if (kindOf[msg.sender] != Kind.None) revert AlreadyRegistered();
        if (!gate.isHuman(msg.sender)) revert NotHuman();
        kindOf[msg.sender] = Kind.Human;
        emit Registered(msg.sender, Kind.Human, "");
        points.mint(msg.sender, STARTER_GRANT);
    }

    function registerAgent(string calldata metadataURI_) external {
        if (kindOf[msg.sender] != Kind.None) revert AlreadyRegistered();
        kindOf[msg.sender] = Kind.Agent;
        metadataURI[msg.sender] = metadataURI_;
        emit Registered(msg.sender, Kind.Agent, metadataURI_);
        points.mint(msg.sender, STARTER_GRANT);
        points.spend(msg.sender, AGENT_BOND);
    }

    /// @notice Owner-only correction of a classification, disclosed as a public event.
    ///         Blocked while any commit window is open. Does not change balances.
    function reclassify(address who, Kind k) external onlyOwner {
        IArenaState arena_ = arena;
        if (address(arena_) == address(0)) revert ArenaNotSet();
        if (arena_.anyCommitWindowOpen()) revert CommitWindowOpen();
        if (k == Kind.None) revert InvalidKind();
        Kind old = kindOf[who];
        if (old == Kind.None) revert NotRegistered();
        if (old == k) revert SameKind();
        kindOf[who] = k;
        emit Reclassified(who, old, k);
    }
}
