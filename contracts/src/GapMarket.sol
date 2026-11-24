// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Points} from "./Points.sol";
import {Kind} from "./Registry.sol";
import {Arena, RoundParams} from "./Arena.sol";

/// @notice The two outcomes of a market: which side's consensus path scores higher against the real candles.
enum Side {
    Human,
    Agent
}

/// @title GapMarket
/// @notice Parimutuel points market on "does the Human or the Agent consensus score higher" for one
///         Arena round. Bets burn points (`Points.spend`); claims mint them back (`Points.mint`), so
///         the contract needs both roles on `Points`. Points only, no real money.
/// @dev Market rules (decision D2 and D3 of the plan):
///        bet     : `revealEnd <= now < marketEnd`, both sides have >= `MIN_REVEALS` reveals, both
///                  consensus paths are frozen (`ready`), and an address stakes at most
///                  `MAX_BET_PER_ADDRESS` per round summed over both sides.
///        status  : derived from Arena state on every call (nothing is stored), so it needs no
///                  transaction to change: 0 open, 1 cancelled, 2 resolved, 3 tie.
///        payout  : cancelled or tie -> every address gets its stake back (both sides);
///                  resolved -> `winnerStake * totalPool / winnerPool` (floor); the losing side gets
///                  nothing. Floor dust (less than one point per winning claimant) stays burned, so
///                  total claims are always <= the pool.
///      The contract has no owner and no admin function. No `Side` -> `Kind` conversion exists: both
///      kinds are always checked explicitly, and the winner is derived from `consensusScores`
///      (`humanScore` vs `agentScore`), so no cast can ever query `Kind.None`.
contract GapMarket {
    error OutsideBetWindow();
    error ZeroAmount();
    error MarketCancelled();
    error ConsensusNotReady();
    error BetCapExceeded();
    error NotClaimable();
    error AlreadyClaimed();
    error NothingToClaim();

    event Bet(uint256 indexed id, address indexed who, Side side, uint256 amt);
    event Claimed(uint256 indexed id, address indexed who, uint256 payout);

    /// @notice Total stake per address and round over both sides. Tunable and unverified until
    ///         playtested (decision D3: it only reduces the impact of free sybil identities).
    uint256 public constant MAX_BET_PER_ADDRESS = 200;
    /// @notice Reveals needed on each side for the market to open.
    uint256 public constant MIN_REVEALS = 3;

    uint8 internal constant OPEN = 0;
    uint8 internal constant CANCELLED = 1;
    uint8 internal constant RESOLVED = 2;
    uint8 internal constant TIE = 3;

    Arena public immutable arena;
    Points public immutable points;

    /// @dev round => side => total staked.
    mapping(uint256 => mapping(Side => uint256)) internal _pool;
    /// @dev round => address => side => staked.
    mapping(uint256 => mapping(address => mapping(Side => uint256))) internal _stake;
    mapping(uint256 => mapping(address => bool)) internal _claimed;

    constructor(Arena arena_) {
        arena = arena_;
        points = arena_.points();
    }

    // ------------------------------------------------------------------ bet

    /// @notice Stakes `amt` points on `s` in round `id`. Check order: round, window, amount, quorum,
    ///         consensus ready, cap. There is deliberately no void check: a void round needs
    ///         `now > settleDeadline`, which is after `marketEnd`, so the window check already covers it.
    /// @dev State is written before the external `spend`. Reverts with Arena's `UnknownRound` for an
    ///      unknown id. The cap is compared as `amt > MAX - held` (never `held + amt`), so a huge
    ///      `amt` reports `BetCapExceeded` instead of an arithmetic panic; `held <= MAX` always holds.
    function bet(uint256 id, Side s, uint256 amt) external {
        RoundParams memory rp = arena.getRound(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < rp.revealEnd || block.timestamp >= rp.marketEnd) revert OutsideBetWindow();
        if (amt == 0) revert ZeroAmount();
        if (_belowQuorum(id)) revert MarketCancelled();
        if (!_ready(id, Kind.Human) || !_ready(id, Kind.Agent)) revert ConsensusNotReady();
        uint256 held = _stake[id][msg.sender][Side.Human] + _stake[id][msg.sender][Side.Agent];
        if (amt > MAX_BET_PER_ADDRESS - held) revert BetCapExceeded();

        _stake[id][msg.sender][s] += amt;
        _pool[id][s] += amt;
        emit Bet(id, msg.sender, s, amt);
        points.spend(msg.sender, amt);
    }

    function _belowQuorum(uint256 id) private view returns (bool) {
        return arena.revealCount(id, Kind.Human) < MIN_REVEALS || arena.revealCount(id, Kind.Agent) < MIN_REVEALS;
    }

    function _ready(uint256 id, Kind k) private view returns (bool ready) {
        // The repaired path is not needed here, only whether all nine fields are frozen.
        // slither-disable-start unused-return
        // forge-lint: disable-next-line(unused-return)
        (, ready) = arena.consensus(id, k);
        // slither-disable-end unused-return
    }

    // ------------------------------------------------------------------ status

    /// @notice 0 open, 1 cancelled, 2 resolved, 3 tie. Derived, never stored, and never reverts for a
    ///         known round. Once non-zero it never changes.
    function status(uint256 id) external view returns (uint8 st) {
        (st,) = _resolve(id);
    }

    /// @dev The single status computation (`claim` uses it too). Evaluation order matters:
    ///      1. void (derived by Arena: nothing posted by `settleDeadline`)           -> cancelled
    ///      2. from `revealEnd`: either side below quorum                            -> cancelled
    ///      3. from `marketEnd`: either pool empty (betting is over for good)        -> cancelled
    ///      4. not settled                                                            -> open
    ///      5. only now read the scores (`consensusScores` reverts before posting):
    ///         equal -> tie, otherwise resolved with the higher side as `winner`.
    ///      Status 2 implies both pools are non-empty (step 3 ran, and posting needs
    ///      `now >= marketEnd + 3 * candleSec`), so the payout division is never by zero.
    function _resolve(uint256 id) private view returns (uint8 st, Side winner) {
        if (arena.isVoid(id)) return (CANCELLED, Side.Human);
        RoundParams memory rp = arena.getRound(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= rp.revealEnd && _belowQuorum(id)) return (CANCELLED, Side.Human);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= rp.marketEnd && (_pool[id][Side.Human] == 0 || _pool[id][Side.Agent] == 0)) {
            return (CANCELLED, Side.Human);
        }
        if (!arena.settled(id)) return (OPEN, Side.Human);
        // Presence flags are implied by the quorum check above.
        // slither-disable-start unused-return
        // forge-lint: disable-next-line(unused-return)
        (uint8 humanScore, uint8 agentScore,,) = arena.consensusScores(id);
        // slither-disable-end unused-return
        if (humanScore == agentScore) return (TIE, Side.Human);
        if (humanScore > agentScore) return (RESOLVED, Side.Human);
        return (RESOLVED, Side.Agent);
    }

    // ------------------------------------------------------------------ claim

    /// @notice Pays `msg.sender` once. Cancelled or tie: the full stake over both sides. Resolved: only
    ///         the winning-side stake earns `stake * totalPool / winnerPool` (floor); the rounding dust
    ///         stays burned.
    /// @dev `_claimed` is set before the external `mint`. Reverts: `NotClaimable` while open,
    ///      `AlreadyClaimed` on a repeat, `NothingToClaim` for an address without stake (or, on a
    ///      resolved market, without stake on the winning side).
    function claim(uint256 id) external {
        (uint8 st, Side winner) = _resolve(id);
        if (st == OPEN) revert NotClaimable();
        if (_claimed[id][msg.sender]) revert AlreadyClaimed();
        uint256 humanStake = _stake[id][msg.sender][Side.Human];
        uint256 agentStake = _stake[id][msg.sender][Side.Agent];

        uint256 payout;
        if (st == RESOLVED) {
            uint256 winnerStake = winner == Side.Human ? humanStake : agentStake;
            if (winnerStake == 0) revert NothingToClaim();
            // Both pools are non-empty here, so winnerPool > 0; winnerStake > 0 implies winnerPool >= winnerStake.
            payout = winnerStake * (_pool[id][Side.Human] + _pool[id][Side.Agent]) / _pool[id][winner];
        } else {
            payout = humanStake + agentStake;
            if (payout == 0) revert NothingToClaim();
        }

        _claimed[id][msg.sender] = true;
        emit Claimed(id, msg.sender, payout);
        points.mint(msg.sender, payout);
    }

    // ------------------------------------------------------------------ views

    function pools(uint256 id) external view returns (uint256 human, uint256 agent) {
        return (_pool[id][Side.Human], _pool[id][Side.Agent]);
    }

    function stakeOf(uint256 id, address who, Side s) external view returns (uint256) {
        return _stake[id][who][s];
    }

    function isClaimed(uint256 id, address who) external view returns (bool) {
        return _claimed[id][who];
    }
}
