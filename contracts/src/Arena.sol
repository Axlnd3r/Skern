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
///      per-kind histograms (3 candles x close/high/low, 201 buckets each).
///      Task 5 scope: after `revealEnd` anyone freezes the per-field medians of those histograms
///      (`freezeConsensus` one field, `freezeAll` everything) and reads the repaired path.
///      Task 6 scope: the keeper posts the real candles; both consensus scores and the baseline are
///      stored; entries claim lazily; a round nobody settled is void and refunds every stake.
///
///      Time boundaries (decision D2, every comparison is exact):
///        commit  : now <  commitEnd
///        reveal  : commitEnd <= now < revealEnd
///        freeze  : now >= revealEnd (no upper bound: the histograms cannot change any more)
///        post    : marketEnd + 3*candleSec <= now <= settleDeadline
///        void    : now > settleDeadline and nothing posted (derived by `isVoid`)
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
    error InvalidKind();
    error InvalidField();
    error FreezeTooEarly();
    error NoReveals();
    error AlreadyFrozen();
    error NotSettled();
    error AlreadyPosted();
    error CandlesTooEarly();
    error PostWindowClosed();
    error RoundIsVoid();
    error InvalidRealCandles();
    error NotVoidable();
    error AlreadySettled();
    error AlreadyVoided();
    error NotClaimable();
    error AlreadyClaimed();
    error NotRevealed();

    event KeeperSet(address indexed keeper);
    event RoundOpened(uint256 indexed id, RoundParams params, uint32 bucketWidth);
    event Committed(uint256 indexed id, address indexed who, Kind kind);
    event Revealed(uint256 indexed id, address indexed who, Kind kind, Candle[3] path);
    event FieldFrozen(uint256 indexed id, Kind indexed kind, uint8 field, int32 value);
    event ConsensusReady(uint256 indexed id, Kind indexed kind);
    event KindAbsent(uint256 indexed id, Kind indexed kind);
    event CandlesPosted(
        uint256 indexed id,
        bytes32 sourceHash,
        uint8 humanScore,
        uint8 agentScore,
        bool humanPresent,
        bool agentPresent,
        uint8 baseline
    );
    event RoundVoided(uint256 indexed id);
    event Claimed(
        uint256 indexed id, address indexed who, Kind kind, uint8 score, uint256 reward, uint256 stakeReturned
    );

    uint256 public constant REWARD_PER_POINT = 1;

    /// @dev Number of histogram buckets per field; bucket 100 is the zero bucket.
    uint256 internal constant BUCKETS = 201;
    /// @dev Number of consensus fields per kind: 3 candles x {close, high, low}.
    uint8 internal constant FIELDS = 9;
    /// @dev `frozenMask` value when all nine fields are frozen.
    uint16 internal constant ALL_FROZEN = 0x1FF;

    /// @dev One commit per (round, address). `kind` is the snapshot taken at commit and doubles
    ///      as the "has committed" marker (a committed entry never has `Kind.None`).
    struct Entry {
        bytes32 hash;
        Kind kind;
        bool revealed;
        bool claimed;
        Candle[3] path;
    }

    /// @dev Per-round settlement state, keyed by round id. `posted` and `voided` are mutually exclusive.
    struct Settlement {
        bool posted;
        bool voided;
        bool humanPresent;
        bool agentPresent;
        uint8 humanScore;
        uint8 agentScore;
        uint8 baseline;
        bytes32 sourceHash;
        Candle[3] real;
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
    /// @dev round => kind => frozen median (bp) per field. Meaningful only where the mask bit is set.
    mapping(uint256 => mapping(Kind => int32[9])) internal _frozen;
    /// @dev round => kind => bit `field` set once that field is frozen.
    mapping(uint256 => mapping(Kind => uint16)) internal _frozenMask;
    /// @dev round => settlement state (real candles, scores, baseline, posted/voided flags).
    mapping(uint256 => Settlement) internal _settlement;

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

    // ------------------------------------------------------------------ consensus

    /// @notice Freezes the median of one field of `k`. Permissionless, allowed from `revealEnd` on
    ///         (no upper bound: the histograms cannot change after `revealEnd`).
    /// @dev `field` = candle*3 + {0 close, 1 high, 2 low}. Check order: round, kind, field, time,
    ///      reveals, already frozen. Emits `ConsensusReady` when the ninth field freezes.
    function freezeConsensus(uint256 id, Kind k, uint8 field) external knownRound(id) {
        if (k == Kind.None) revert InvalidKind();
        if (field >= FIELDS) revert InvalidField();
        _requireFreezable(id);
        if (_revealCount[id][k] == 0) revert NoReveals();
        if (_frozenMask[id][k] & (uint16(1) << field) != 0) revert AlreadyFrozen();
        _freeze(id, k, field);
    }

    /// @notice Freezes every unfrozen field of every present kind. Idempotent: already frozen fields
    ///         are skipped, so a griefer freezing one field first cannot make this revert, and a
    ///         repeat call changes nothing and emits no `FieldFrozen` or `ConsensusReady`.
    /// @dev A kind with zero reveals is absent: nothing is frozen and `KindAbsent` is emitted on
    ///      every call (stateless; presence is always derived from `revealCount`, never stored).
    function freezeAll(uint256 id) external knownRound(id) {
        _freezeAll(id);
    }

    /// @dev Shared by `freezeAll` and `postCandles`. Enforces the freeze window itself.
    ///      Bounded work: 2 kinds x 9 fields.
    function _freezeAll(uint256 id) internal {
        _requireFreezable(id);
        for (uint8 j = 1; j <= 2; j++) {
            Kind k = Kind(j);
            if (_revealCount[id][k] == 0) {
                emit KindAbsent(id, k);
                continue;
            }
            for (uint8 f = 0; f < FIELDS; f++) {
                if (_frozenMask[id][k] & (uint16(1) << f) == 0) _freeze(id, k, f);
            }
        }
    }

    function _requireFreezable(uint256 id) private view {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < _rounds[id].revealEnd) revert FreezeTooEarly();
    }

    /// @dev Stores the median of one field and sets its mask bit. Callers guarantee the field is
    ///      unfrozen, the kind is present and the freeze window is open.
    function _freeze(uint256 id, Kind k, uint8 field) private {
        int32 value = _median(id, k, field);
        _frozen[id][k][field] = value;
        uint16 mask = _frozenMask[id][k] | (uint16(1) << field);
        _frozenMask[id][k] = mask;
        emit FieldFrozen(id, k, field, value);
        if (mask == ALL_FROZEN) emit ConsensusReady(id, k);
    }

    /// @dev Lowest bucket whose cumulative count reaches ceil(n/2) (even n takes the lower median).
    ///      The walk covers buckets 0..199; if the target is never reached the answer is bucket 200.
    function _median(uint256 id, Kind k, uint8 field) private view returns (int32) {
        uint256 target = (_revealCount[id][k] + 1) / 2;
        uint32[BUCKETS] storage h = _histogram[id][k][field];
        uint256 acc = 0;
        uint8 i = 0;
        for (; i < 200; i++) {
            acc += h[i];
            if (acc >= target) break;
        }
        return bucketValue(i, _bucketWidth[id]);
    }

    /// @notice Value in bp that bucket `i` represents: (i - 100) * width, saturated to the int32 range.
    /// @dev Saturation matters: with T near uint32.max the width is 429496730 and `-5 * width`
    ///      is below int32.min, so the product is computed in int256 and clamped, never narrowed blindly.
    function bucketValue(uint8 i, uint32 width) public pure returns (int32) {
        int256 v = (int256(uint256(i)) - 100) * int256(uint256(width));
        if (v < type(int32).min) return type(int32).min;
        if (v > type(int32).max) return type(int32).max;
        // forge-lint: disable-next-line(unsafe-typecast)
        return int32(v);
    }

    /// @notice The consensus path of `k` with the repair applied, and whether it is final.
    /// @dev `ready` is true iff all nine fields are frozen and the kind is present. Before that the
    ///      path is partial: unfrozen fields read as 0 (then repaired), so do not score from it.
    ///      An absent kind (zero reveals) returns a zero path and `ready == false`.
    function consensus(uint256 id, Kind k) external view knownRound(id) returns (Candle[3] memory path, bool ready) {
        if (k == Kind.None) revert InvalidKind();
        return _consensusPath(id, k);
    }

    /// @notice True iff `k` has at least one reveal in round `id` (derived, never stored).
    function isPresent(uint256 id, Kind k) external view knownRound(id) returns (bool) {
        return _revealCount[id][k] > 0;
    }

    /// @notice Bit `field` is set once that field of `k` is frozen.
    function frozenMask(uint256 id, Kind k) external view knownRound(id) returns (uint16) {
        return _frozenMask[id][k];
    }

    /// @dev The single place that builds and repairs the consensus path (Task 6 scores from it).
    ///      Repair per candle with open_1 = 0 and open_i = frozen close of candle i-1:
    ///      high = max(high, open, close), low = min(low, open, close). Closes are never altered.
    function _consensusPath(uint256 id, Kind k) internal view returns (Candle[3] memory path, bool ready) {
        if (_revealCount[id][k] == 0) return (path, false);
        int32[9] storage f = _frozen[id][k];
        int32 open = 0;
        for (uint256 i = 0; i < 3; i++) {
            int32 close = f[i * 3];
            int32 high = f[i * 3 + 1];
            int32 low = f[i * 3 + 2];
            if (high < open) high = open;
            if (high < close) high = close;
            if (low > open) low = open;
            if (low > close) low = close;
            path[i] = Candle(close, high, low);
            open = close;
        }
        ready = _frozenMask[id][k] == ALL_FROZEN;
    }

    // ------------------------------------------------------------------ settle

    /// @notice Keeper-only, once. Posts the three real candles, freezes the consensus itself (so it
    ///         works whether or not anyone froze) and stores both consensus scores and the baseline.
    /// @dev Allowed iff `marketEnd + 3*candleSec <= now <= settleDeadline` (decision D2); the upper
    ///      bound is the exact complement of the void rule, so a late post cannot race a void. A
    ///      reverted call stores nothing, so an invalid post does not use up the one-shot. Succeeds
    ///      when a side has no reveals (that side scores 0 and is flagged absent). Check order:
    ///      keeper, round, already posted, void, too early, too late, candle validity.
    function postCandles(uint256 id, Candle[3] calldata real, bytes32 sourceHash) external onlyKeeper knownRound(id) {
        Settlement storage s = _settlement[id];
        if (s.posted) revert AlreadyPosted();
        if (s.voided) revert RoundIsVoid();
        RoundParams storage rp = _rounds[id];
        // uint256 math: marketEnd + 3 * candleSec can exceed uint64.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(rp.marketEnd) + 3 * uint256(rp.candleSec)) revert CandlesTooEarly();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > rp.settleDeadline) revert PostWindowClosed();
        Candle[3] memory r = real;
        if (!ScoreLib.isValid(r)) revert InvalidRealCandles();
        _freezeAll(id);
        _store(id, s, r, sourceHash, rp.T);
    }

    /// @dev Scores the two consensus paths and the all-zero baseline: exactly three `ScoreLib.score`
    ///      calls, never a loop over participants. Consensus is read only through `_consensusPath`;
    ///      presence only through `_revealCount`.
    function _store(uint256 id, Settlement storage s, Candle[3] memory r, bytes32 sourceHash, uint32 T) private {
        (uint8 hs, bool hp) = _sideScore(id, Kind.Human, r, T);
        (uint8 as_, bool ap) = _sideScore(id, Kind.Agent, r, T);
        Candle[3] memory zero = [Candle(0, 0, 0), Candle(0, 0, 0), Candle(0, 0, 0)]; // the flat path
        uint8 base = ScoreLib.score(zero, r, T);
        for (uint256 i = 0; i < 3; i++) {
            s.real[i] = r[i];
        }
        s.sourceHash = sourceHash;
        s.humanScore = hs;
        s.agentScore = as_;
        s.humanPresent = hp;
        s.agentPresent = ap;
        s.baseline = base;
        s.posted = true;
        emit CandlesPosted(id, sourceHash, hs, as_, hp, ap, base);
    }

    function _sideScore(uint256 id, Kind k, Candle[3] memory r, uint32 T) private view returns (uint8, bool) {
        if (_revealCount[id][k] == 0) return (0, false);
        (Candle[3] memory path,) = _consensusPath(id, k);
        return (ScoreLib.score(path, r, T), true);
    }

    /// @notice Records a round as void. Anyone, only after `settleDeadline` and only if no candles
    ///         were posted. Pure bookkeeping: refunds never depend on this call (`isVoid` is derived).
    function voidRound(uint256 id) external knownRound(id) {
        Settlement storage s = _settlement[id];
        if (s.posted) revert AlreadySettled();
        if (s.voided) revert AlreadyVoided();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= _rounds[id].settleDeadline) revert NotVoidable();
        s.voided = true;
        emit RoundVoided(id);
    }

    /// @dev Derived: a round nobody posted by `settleDeadline` is void whether or not `voidRound` ran.
    ///      Used by `isVoid` and `claim`, so both always agree.
    function _isVoid(uint256 id, Settlement storage s) private view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return s.voided || (!s.posted && block.timestamp > _rounds[id].settleDeadline);
    }

    // ------------------------------------------------------------------ claim

    /// @notice Pays `msg.sender` once. Void round: the stake back, nothing else (revealed or not).
    ///         Settled round: a revealed entry gets the stake plus `(score - baseline) * REWARD_PER_POINT`
    ///         when its score beats the baseline; an unrevealed entry reverts (its stake was burned at commit).
    /// @dev Uses the per-round stored stake, T, real candles and baseline (by `id`) and the entry's
    ///      commit-time kind. `claimed` is set before the only external call (`points.mint`).
    function claim(uint256 id) external knownRound(id) {
        Settlement storage s = _settlement[id];
        bool void_ = _isVoid(id, s);
        if (!void_ && !s.posted) revert NotClaimable();
        Entry storage e = _entries[id][msg.sender];
        Kind kind = e.kind;
        if (kind == Kind.None) revert NoCommit();
        if (e.claimed) revert AlreadyClaimed();

        uint8 score = 0;
        uint256 reward = 0;
        if (!void_) {
            if (!e.revealed) revert NotRevealed();
            (score, reward) = _entryResult(e, s, _rounds[id].T);
        }
        uint256 stake = _rounds[id].entryStake;

        e.claimed = true;
        emit Claimed(id, msg.sender, kind, score, reward, stake);
        points.mint(msg.sender, stake + reward);
    }

    /// @dev The single scoring call per claim (lazy); reward only strictly above the baseline.
    function _entryResult(Entry storage e, Settlement storage s, uint32 T) private view returns (uint8, uint256) {
        Candle[3] memory p = e.path;
        Candle[3] memory r = s.real;
        uint8 score = ScoreLib.score(p, r, T);
        uint8 base = s.baseline;
        return (score, score > base ? (uint256(score) - uint256(base)) * REWARD_PER_POINT : 0);
    }

    /// @notice True once candles are posted.
    function settled(uint256 id) external view knownRound(id) returns (bool) {
        return _settlement[id].posted;
    }

    /// @notice True if the round is void: `voidRound` ran, or nobody posted by `settleDeadline`.
    function isVoid(uint256 id) external view knownRound(id) returns (bool) {
        return _isVoid(id, _settlement[id]);
    }

    /// @notice Consensus scores of both kinds (0..100) and whether each kind had any reveal.
    /// @dev Reverts `NotSettled` before posting: 0 is a legal score, so zeros would be ambiguous.
    function consensusScores(uint256 id)
        external
        view
        knownRound(id)
        returns (uint8 human, uint8 agent, bool humanPresent, bool agentPresent)
    {
        Settlement storage s = _settlement[id];
        if (!s.posted) revert NotSettled();
        return (s.humanScore, s.agentScore, s.humanPresent, s.agentPresent);
    }

    /// @notice Score of the all-zero path against the real candles.
    function baselineScore(uint256 id) external view knownRound(id) returns (uint8) {
        Settlement storage s = _settlement[id];
        if (!s.posted) revert NotSettled();
        return s.baseline;
    }

    /// @notice The posted real candles and their source hash.
    function realCandles(uint256 id) external view knownRound(id) returns (Candle[3] memory real, bytes32 sourceHash) {
        Settlement storage s = _settlement[id];
        if (!s.posted) revert NotSettled();
        return (s.real, s.sourceHash);
    }

    /// @notice True once `who` has claimed in round `id`.
    function isClaimed(uint256 id, address who) external view knownRound(id) returns (bool) {
        return _entries[id][who].claimed;
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
