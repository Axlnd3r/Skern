// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Points} from "./Points.sol";
import {Registry, Kind} from "./Registry.sol";
import {Candle, ScoreLib} from "./ScoreLib.sol";
import {IArenaState} from "./interfaces/IArenaState.sol";

/// @notice Parameters of one round. Times are unix seconds; `T` is the normalisation scale in bp.
struct RoundParams {
    bytes32 ticker;
    uint256 p0;
    uint32 T;
    uint64 commitEnd;
    uint64 revealEnd;
    uint64 marketEnd;
    uint32 candleSec;
    uint64 settleDeadline;
    uint256 entryStake;
}

/// @title Arena
/// @notice Commit-reveal rounds in which humans and agents predict a 3-candle path.
/// @dev Task 4 scope: open a round, commit a hash, reveal a path. Reveals feed nine
///      per-kind histograms (3 candles x close/high/low, 201 buckets each) that later tasks
///      turn into a median consensus.
///
///      Time boundaries (decision D2, every comparison is exact):
///        commit  : now <  commitEnd
///        reveal  : commitEnd <= now < revealEnd
///      An entry stores the `Kind` snapshotted at commit; reveal never re-reads the registry,
///      so a later `reclassify` cannot move an entry between the human and agent histograms.
contract Arena is IArenaState {
    error NotOwner();
    error NotKeeper();
    error ZeroAddress();
    error KeeperAlreadySet();
    error ZeroEntryStake();
    error ZeroT();
    error ZeroCandleSec();
    error CommitEndNotInFuture();
    error RevealEndNotAfterCommitEnd();
    error MarketEndNotAfterRevealEnd();
    error SettleDeadlineTooEarly();
    error UnknownRound();
    error CommitWindowClosed();
    error RevealWindowClosed();
    error NotRegistered();
    error AlreadyCommitted();
    error NoCommit();
    error AlreadyRevealed();
    error InvalidPath();
    error HashMismatch();

    event KeeperSet(address indexed keeper);
    event RoundOpened(uint256 indexed id, RoundParams params, uint32 bucketWidth);
    event Committed(uint256 indexed id, address indexed who, Kind kind);
    event Revealed(uint256 indexed id, address indexed who, Kind kind, Candle[3] path);

    /// @dev Number of histogram buckets per field; bucket 100 is the zero bucket.
    uint256 internal constant BUCKETS = 201;

    /// @dev One commit per (round, address). `kind` is the snapshot taken at commit and doubles
    ///      as the "has committed" marker (a committed entry never has `Kind.None`).
    struct Entry {
        bytes32 hash;
        Kind kind;
        bool revealed;
        Candle[3] path;
    }

    address public immutable owner;
    Points public immutable points;
    Registry public immutable registry;
    address public keeper;

    /// @notice Id of the most recently opened round; ids start at 1.
    uint256 public roundCount;
    /// @dev Running max of `commitEnd` over every round ever opened (O(1) `anyCommitWindowOpen`).
    uint64 internal maxCommitEnd;

    mapping(uint256 => RoundParams) internal _rounds;
    mapping(uint256 => uint32) internal _bucketWidth;
    mapping(uint256 => mapping(address => Entry)) internal _entries;
    mapping(uint256 => mapping(Kind => uint256)) internal _revealCount;
    /// @dev round => kind => field (candle*3 + {0 close, 1 high, 2 low}) => bucket counters.
    mapping(uint256 => mapping(Kind => mapping(uint8 => uint32[BUCKETS]))) internal _histogram;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    /// @dev Reverts `UnknownRound` for id 0 and for any id that was never opened.
    modifier knownRound(uint256 id) {
        if (id == 0 || id > roundCount) revert UnknownRound();
        _;
    }

    constructor(Points points_, Registry registry_, address owner_) {
        if (address(points_) == address(0) || address(registry_) == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        points = points_;
        registry = registry_;
        owner = owner_;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Set-once. A lost keeper key means a redeploy (a deliberate testnet choice).
    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        if (keeper != address(0)) revert KeeperAlreadySet();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    // ------------------------------------------------------------------ open

    function openRound(RoundParams calldata p) external onlyKeeper returns (uint256 id) {
        _validate(p);
        // ceil(T / 10) in uint256, so T near uint32.max cannot overflow. T >= 1 here, so the width is
        // already >= 1 (the max(1, .) floor holds) and at most 429496730, which fits uint32.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 width = uint32((uint256(p.T) + 9) / 10);

        id = ++roundCount;
        _rounds[id] = p;
        _bucketWidth[id] = width;
        if (p.commitEnd > maxCommitEnd) maxCommitEnd = p.commitEnd;
        emit RoundOpened(id, p, width);
    }

    function _validate(RoundParams calldata p) private view {
        if (p.entryStake == 0) revert ZeroEntryStake();
        if (p.T == 0) revert ZeroT();
        if (p.candleSec == 0) revert ZeroCandleSec();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= p.commitEnd) revert CommitEndNotInFuture();
        if (p.commitEnd >= p.revealEnd) revert RevealEndNotAfterCommitEnd();
        if (p.revealEnd >= p.marketEnd) revert MarketEndNotAfterRevealEnd();
        // uint256 math: marketEnd + 3 * candleSec can exceed uint64.
        if (uint256(p.settleDeadline) <= uint256(p.marketEnd) + 3 * uint256(p.candleSec)) {
            revert SettleDeadlineTooEarly();
        }
    }

    // ------------------------------------------------------------------ IArenaState

    /// @inheritdoc IArenaState
    function anyCommitWindowOpen() external view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp < maxCommitEnd;
    }

    // ------------------------------------------------------------------ commit

    /// @notice Binds `msg.sender` to the hash of a path. One commit per address per round.
    function commit(uint256 id, bytes32 h) external knownRound(id) {
        RoundParams storage rp = _rounds[id];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= rp.commitEnd) revert CommitWindowClosed();
        Entry storage e = _entries[id][msg.sender];
        if (e.kind != Kind.None) revert AlreadyCommitted();
        Kind kind = registry.kindOf(msg.sender);
        if (kind == Kind.None) revert NotRegistered();

        e.hash = h;
        e.kind = kind;
        emit Committed(id, msg.sender, kind);
        // The stake is burned up front; unrevealed stakes stay burned, revealed ones are returned at claim.
        points.spend(msg.sender, rp.entryStake);
    }

    /// @notice The commitment: keccak256(abi.encode(path, salt, who)). `who` is the committing address.
    function hashPath(Candle[3] memory path, bytes32 salt, address who) public pure returns (bytes32) {
        return keccak256(abi.encode(path, salt, who));
    }

    // ------------------------------------------------------------------ reveal

    /// @notice Reveals the path committed by `who`. Callable by anyone: the hash binds `who`,
    ///         so nobody else can have committed a valid hash for that address (decision D1).
    function reveal(uint256 id, address who, Candle[3] calldata path, bytes32 salt) external knownRound(id) {
        RoundParams storage rp = _rounds[id];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < rp.commitEnd || block.timestamp >= rp.revealEnd) revert RevealWindowClosed();
        Entry storage e = _entries[id][who];
        Kind kind = e.kind;
        if (kind == Kind.None) revert NoCommit();
        if (e.revealed) revert AlreadyRevealed();

        Candle[3] memory m = path;
        if (!ScoreLib.isValid(m)) revert InvalidPath();
        if (hashPath(m, salt, who) != e.hash) revert HashMismatch();

        e.revealed = true;
        for (uint256 i = 0; i < 3; i++) {
            e.path[i] = m[i];
        }
        _revealCount[id][kind] += 1;
        _countPath(id, kind, m, _bucketWidth[id]);
        emit Revealed(id, who, kind, m);
    }

    /// @dev Adds the nine values of `m` to the histograms of `kind`.
    function _countPath(uint256 id, Kind kind, Candle[3] memory m, uint32 width) private {
        mapping(uint8 => uint32[BUCKETS]) storage h = _histogram[id][kind];
        for (uint8 i = 0; i < 3; i++) {
            h[i * 3][bucketIndex(m[i].close, width)] += 1;
            h[i * 3 + 1][bucketIndex(m[i].high, width)] += 1;
            h[i * 3 + 2][bucketIndex(m[i].low, width)] += 1;
        }
    }

    /// @notice Bucket of value `v` bp: clamp(100 + floor(v / width), 0, 200), with `floor` rounding
    ///         toward negative infinity (Solidity `/` truncates toward zero, so it is adjusted).
    /// @dev `width` must be >= 1. The clamp happens in int256 before narrowing to uint256.
    function bucketIndex(int32 v, uint32 width) public pure returns (uint256) {
        int256 x = v;
        int256 w = int256(uint256(width));
        int256 q = x / w;
        if (x % w < 0) q -= 1; // negative with a remainder: truncation rounded up, step down
        int256 idx = 100 + q;
        if (idx < 0) idx = 0;
        if (idx > 200) idx = 200;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(idx);
    }

    // ------------------------------------------------------------------ views

    function getRound(uint256 id) external view knownRound(id) returns (RoundParams memory) {
        return _rounds[id];
    }

    function bucketWidth(uint256 id) external view knownRound(id) returns (uint32) {
        return _bucketWidth[id];
    }

    function revealCount(uint256 id, Kind k) external view knownRound(id) returns (uint256) {
        return _revealCount[id][k];
    }

    function entryOf(uint256 id, address who)
        external
        view
        knownRound(id)
        returns (Kind kind, bool revealed, bytes32 hash, Candle[3] memory path)
    {
        Entry storage e = _entries[id][who];
        return (e.kind, e.revealed, e.hash, e.path);
    }

    /// @notice Counter of one bucket. `field` = candle*3 + {0 close, 1 high, 2 low}; `bucket` in 0..200.
    function histogram(uint256 id, Kind k, uint8 field, uint256 bucket) external view knownRound(id) returns (uint32) {
        return _histogram[id][k][field][bucket];
    }

    /// @notice All 201 counters of one field.
    function getHistogram(uint256 id, Kind k, uint8 field)
        external
        view
        knownRound(id)
        returns (uint32[BUCKETS] memory)
    {
        return _histogram[id][k][field];
    }
}
