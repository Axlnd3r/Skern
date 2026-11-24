// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm, console} from "forge-std/Test.sol";
import {Points} from "../src/Points.sol";
import {Registry, Kind} from "../src/Registry.sol";
import {AllowlistGate} from "../src/AllowlistGate.sol";
import {Candle, ScoreLib} from "../src/ScoreLib.sol";
import {Arena, RoundParams} from "../src/Arena.sol";

/// @dev Test-only subclass. For valid reveals the median high is always >= the median close and the
///      median open (and the median low always <=), so the repair never fires on honest input. It is
///      exercised by writing crafted medians straight into the frozen state.
contract ArenaHarness is Arena {
    constructor(Points p, Registry r, address o) Arena(p, r, o) {}

    function forceFrozen(uint256 id, Kind k, int32[9] calldata v) external {
        _frozen[id][k] = v;
        _frozenMask[id][k] = ALL_FROZEN;
        if (_revealCount[id][k] == 0) _revealCount[id][k] = 1;
    }
}

contract ArenaConsensusTest is Test {
    event FieldFrozen(uint256 indexed id, Kind indexed kind, uint8 field, int32 value);
    event ConsensusReady(uint256 indexed id, Kind indexed kind);
    event KindAbsent(uint256 indexed id, Kind indexed kind);

    struct Pending {
        uint256 id;
        address who;
        Candle[3] path;
        bytes32 salt;
        bool done;
    }

    Points internal points;
    AllowlistGate internal gate;
    Registry internal registry;
    ArenaHarness internal arena;

    Pending[] internal pending;
    uint160 internal counter;

    address internal keeper = address(0x4EE9E4);
    address internal stranger = address(0x57A4);

    uint64 internal t0 = 1_000_000;
    uint256 internal constant STAKE = 50;

    function setUp() public {
        vm.warp(t0);
        points = new Points(address(this));
        gate = new AllowlistGate(address(this));
        registry = new Registry(points, gate, address(this));
        arena = new ArenaHarness(points, registry, address(this));
        points.setMinter(address(registry), true);
        points.setSpender(address(registry), true);
        points.setSpender(address(arena), true);
        registry.setArena(arena);
        arena.setKeeper(keeper);
    }

    // ------------------------------------------------------------ helpers

    function _params(uint32 T) internal view returns (RoundParams memory p) {
        p.ticker = bytes32("AAPL");
        p.p0 = 190_00;
        p.T = T;
        p.commitEnd = t0 + 100;
        p.revealEnd = t0 + 200;
        p.marketEnd = t0 + 300;
        p.candleSec = 60;
        p.settleDeadline = t0 + 300 + 180 + 1000;
        p.entryStake = STAKE;
    }

    function _open(RoundParams memory p) internal returns (uint256 id) {
        vm.prank(keeper);
        id = arena.openRound(p);
    }

    /// @dev T = 10 gives bucket width 1, so bucket values equal the revealed values.
    function _openW1() internal returns (uint256) {
        return _open(_params(10));
    }

    /// @dev T = 100 gives bucket width 10.
    function _openW10() internal returns (uint256) {
        return _open(_params(100));
    }

    function _c(int32 close, int32 high, int32 low) internal pure returns (Candle memory) {
        return Candle(close, high, low);
    }

    /// @dev Valid path whose first close is `c` and which stays flat at `c` afterwards.
    function _flat(int32 c) internal pure returns (Candle[3] memory p) {
        p[0] = _c(c, c > 0 ? c : int32(0), c < 0 ? c : int32(0));
        p[1] = _c(c, c, c);
        p[2] = _c(c, c, c);
    }

    /// @dev Valid path with nine different values, all multiples of 10 (exact for width 10).
    function _spread() internal pure returns (Candle[3] memory p) {
        p[0] = _c(30, 50, -10);
        p[1] = _c(-60, 70, -80);
        p[2] = _c(-20, 20, -90);
    }

    function _spreadValues() internal pure returns (int32[9] memory v) {
        v = [int32(30), 50, -10, -60, 70, -80, -20, 20, -90];
    }

    /// @dev Registers a fresh entrant of `k`, commits `path` in round `id` and queues the reveal.
    function _join(uint256 id, Kind k, Candle[3] memory path) internal returns (address who) {
        uint160 n = ++counter;
        if (k == Kind.Human) {
            who = address(uint160(0x1000) + n);
            gate.setAllowed(who, true);
            vm.prank(who);
            registry.registerHuman();
        } else {
            who = address(uint160(0x2000) + n);
            vm.prank(who);
            registry.registerAgent("ipfs://agent");
        }
        bytes32 salt = keccak256(abi.encode("salt", n));
        bytes32 h = arena.hashPath(path, salt, who);
        vm.prank(who);
        arena.commit(id, h);
        Pending storage q = pending.push();
        q.id = id;
        q.who = who;
        q.salt = salt;
        for (uint256 i = 0; i < 3; i++) {
            q.path[i] = path[i];
        }
    }

    /// @dev Reveals every queued entrant of round `id` (moves time to `commitEnd` if needed).
    function _revealQueued(uint256 id) internal {
        uint64 ce = arena.getRound(id).commitEnd;
        if (vm.getBlockTimestamp() < ce) vm.warp(ce);
        for (uint256 i = 0; i < pending.length; i++) {
            Pending storage q = pending[i];
            if (q.id != id || q.done) continue;
            q.done = true;
            arena.reveal(id, q.who, q.path, q.salt);
        }
    }

    function _toRevealEnd(uint256 id) internal {
        vm.warp(arena.getRound(id).revealEnd);
    }

    function _joinN(uint256 id, Kind k, uint256 n, Candle[3] memory path) internal {
        for (uint256 i = 0; i < n; i++) {
            _join(id, k, path);
        }
    }

    /// @dev Round with T=10 and `closes.length` humans, each revealing `_flat(close)`; time at revealEnd.
    function _humansWithCloses(int32[] memory closes) internal returns (uint256 id) {
        id = _openW1();
        for (uint256 i = 0; i < closes.length; i++) {
            _join(id, Kind.Human, _flat(closes[i]));
        }
        _revealQueued(id);
        _toRevealEnd(id);
    }

    function _closes3(int32 a, int32 b, int32 c) internal pure returns (int32[] memory r) {
        r = new int32[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _countLogs(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic0) n++;
        }
    }

    function _assertPath(Candle[3] memory got, int32[9] memory want) internal pure {
        for (uint256 i = 0; i < 3; i++) {
            assertEq(got[i].close, want[i * 3], "close");
            assertEq(got[i].high, want[i * 3 + 1], "high");
            assertEq(got[i].low, want[i * 3 + 2], "low");
        }
    }

    // ------------------------------------------------------------ median

    function test_medianOfOddCount() public {
        uint256 id = _humansWithCloses(_closes3(10, 30, 20));
        assertEq(arena.bucketWidth(id), 1);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 0, 20);
        arena.freezeConsensus(id, Kind.Human, 0);
        assertEq(arena.frozenMask(id, Kind.Human), 1);
    }

    function test_medianOfEvenCountTakesLower() public {
        int32[] memory c = new int32[](4);
        c[0] = 10;
        c[1] = 40;
        c[2] = 20;
        c[3] = 30;
        uint256 id = _humansWithCloses(c);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 0, 20); // sorted 10,20,30,40 -> lower median 20
        arena.freezeConsensus(id, Kind.Human, 0);
    }

    function test_medianOfTwoTakesLower() public {
        int32[] memory c = new int32[](2);
        c[0] = 9;
        c[1] = 5;
        uint256 id = _humansWithCloses(c);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 0, 5);
        arena.freezeConsensus(id, Kind.Human, 0);
    }

    function test_medianOfSingleReveal() public {
        uint256 id = _openW1();
        _join(id, Kind.Agent, _flat(-7));
        _revealQueued(id);
        _toRevealEnd(id);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Agent, 0, -7);
        arena.freezeConsensus(id, Kind.Agent, 0);
    }

    function test_medianIgnoresOtherKind() public {
        uint256 id = _openW1();
        _join(id, Kind.Human, _flat(10));
        _join(id, Kind.Human, _flat(10));
        _join(id, Kind.Human, _flat(10));
        _join(id, Kind.Agent, _flat(90));
        _join(id, Kind.Agent, _flat(90));
        _join(id, Kind.Agent, _flat(90));
        _revealQueued(id);
        _toRevealEnd(id);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 0, 10);
        arena.freezeConsensus(id, Kind.Human, 0);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Agent, 0, 90);
        arena.freezeConsensus(id, Kind.Agent, 0);
        assertEq(arena.frozenMask(id, Kind.Human), 1);
        assertEq(arena.frozenMask(id, Kind.Agent), 1);
    }

    function test_medianInClampedEndBuckets() public {
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _flat(5000)); // clamps to bucket 200 -> +1000
        _joinN(id, Kind.Agent, 3, _flat(-5000)); // clamps to bucket 0 -> -1000
        _revealQueued(id);
        _toRevealEnd(id);
        arena.freezeAll(id);
        (Candle[3] memory h,) = arena.consensus(id, Kind.Human);
        (Candle[3] memory a,) = arena.consensus(id, Kind.Agent);
        _assertPath(h, [int32(1000), 1000, 0, 1000, 1000, 1000, 1000, 1000, 1000]);
        _assertPath(a, [int32(-1000), 0, -1000, -1000, -1000, -1000, -1000, -1000, -1000]);
    }

    function test_medianQuantisesToBucketValue() public {
        RoundParams memory p = _params(15); // width 2
        uint256 id = _open(p);
        assertEq(arena.bucketWidth(id), 2);
        _joinN(id, Kind.Human, 3, _flat(7)); // bucket 103 -> 6
        _joinN(id, Kind.Agent, 3, _flat(-7)); // floor(-7/2) = -4 -> bucket 96 -> -8
        _revealQueued(id);
        _toRevealEnd(id);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 0, 6);
        arena.freezeConsensus(id, Kind.Human, 0);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Agent, 0, -8);
        arena.freezeConsensus(id, Kind.Agent, 0);
    }

    function test_medianPicksTargetNotFirstNonEmptyBucket() public {
        // 5 reveals: target is the 3rd smallest. -50, -40, 0 | 30, 80 -> 0
        int32[] memory c = new int32[](5);
        c[0] = 30;
        c[1] = -50;
        c[2] = 80;
        c[3] = 0;
        c[4] = -40;
        uint256 id = _humansWithCloses(c);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 0, 0);
        arena.freezeConsensus(id, Kind.Human, 0);
    }

    function test_eachFieldFreezesIndependentlyAtItsIndex() public {
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _spread());
        _revealQueued(id);
        _toRevealEnd(id);
        int32[9] memory want = _spreadValues();
        uint16 expectMask = 0;
        // descending order so an index mix-up cannot hide behind the ascending default
        for (uint8 j = 0; j < 9; j++) {
            uint8 f = 8 - j;
            vm.expectEmit(true, true, false, true, address(arena));
            emit FieldFrozen(id, Kind.Human, f, want[f]);
            arena.freezeConsensus(id, Kind.Human, f);
            expectMask |= uint16(1) << f;
            assertEq(arena.frozenMask(id, Kind.Human), expectMask, "mask");
        }
        (Candle[3] memory path, bool ready) = arena.consensus(id, Kind.Human);
        assertTrue(ready);
        _assertPath(path, want);
    }

    // ------------------------------------------------------------ timing

    function test_freezeBeforeRevealEndReverts() public {
        uint256 id = _humansWithCloses(_closes3(1, 2, 3));
        vm.warp(arena.getRound(id).revealEnd - 1);
        vm.expectRevert(Arena.FreezeTooEarly.selector);
        arena.freezeConsensus(id, Kind.Human, 0);
        vm.expectRevert(Arena.FreezeTooEarly.selector);
        arena.freezeAll(id);
        assertEq(arena.frozenMask(id, Kind.Human), 0);
        // exactly revealEnd is the first allowed second
        vm.warp(arena.getRound(id).revealEnd);
        arena.freezeConsensus(id, Kind.Human, 0);
        assertEq(arena.frozenMask(id, Kind.Human), 1);
        arena.freezeAll(id);
        assertEq(arena.frozenMask(id, Kind.Human), 0x1FF);
    }

    function test_freezeAllExactBoundary() public {
        uint256 id = _humansWithCloses(_closes3(1, 2, 3));
        vm.warp(arena.getRound(id).revealEnd - 1);
        vm.expectRevert(Arena.FreezeTooEarly.selector);
        arena.freezeAll(id);
        vm.warp(arena.getRound(id).revealEnd);
        arena.freezeAll(id);
        assertEq(arena.frozenMask(id, Kind.Human), 0x1FF);
    }

    function test_freezeStillWorksAfterMarketEndAndSettleDeadline() public {
        uint256 id = _humansWithCloses(_closes3(10, 30, 20));
        RoundParams memory rp = arena.getRound(id);
        vm.warp(uint256(rp.marketEnd) + 3 * uint256(rp.candleSec) + 1);
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 0, 20);
        arena.freezeConsensus(id, Kind.Human, 0);
        vm.warp(uint256(rp.settleDeadline) + 1);
        arena.freezeAll(id);
        (Candle[3] memory path, bool ready) = arena.consensus(id, Kind.Human);
        assertTrue(ready);
        assertEq(path[0].close, 20);
    }

    function test_freezeLongAfterEverything() public {
        uint256 id = _humansWithCloses(_closes3(10, 30, 20));
        vm.warp(block.timestamp + 365 days);
        arena.freezeAll(id);
        (Candle[3] memory path, bool ready) = arena.consensus(id, Kind.Human);
        assertTrue(ready);
        assertEq(path[0].close, 20);
    }

    // ------------------------------------------------------------ reverts

    function test_freezeTwiceReverts() public {
        uint256 id = _humansWithCloses(_closes3(10, 30, 20));
        arena.freezeConsensus(id, Kind.Human, 3);
        vm.expectRevert(Arena.AlreadyFrozen.selector);
        arena.freezeConsensus(id, Kind.Human, 3);
        // another field of the same kind is still open
        arena.freezeConsensus(id, Kind.Human, 4);
        assertEq(arena.frozenMask(id, Kind.Human), (1 << 3) | (1 << 4));
    }

    function test_freezeAfterFreezeAllRevertsAlreadyFrozen() public {
        uint256 id = _humansWithCloses(_closes3(10, 30, 20));
        arena.freezeAll(id);
        vm.expectRevert(Arena.AlreadyFrozen.selector);
        arena.freezeConsensus(id, Kind.Human, 8);
    }

    function test_freezeRejectsFieldAboveEight() public {
        uint256 id = _humansWithCloses(_closes3(10, 30, 20));
        vm.expectRevert(Arena.InvalidField.selector);
        arena.freezeConsensus(id, Kind.Human, 9);
        vm.expectRevert(Arena.InvalidField.selector);
        arena.freezeConsensus(id, Kind.Human, 255);
        arena.freezeConsensus(id, Kind.Human, 8); // 8 is the last valid field
        assertEq(arena.frozenMask(id, Kind.Human), 1 << 8);
    }

    function test_freezeRejectsKindNone() public {
        uint256 id = _humansWithCloses(_closes3(10, 30, 20));
        vm.expectRevert(Arena.InvalidKind.selector);
        arena.freezeConsensus(id, Kind.None, 0);
        vm.expectRevert(Arena.InvalidKind.selector);
        arena.consensus(id, Kind.None);
    }

    function test_unknownRoundReverts() public {
        uint256 id = _humansWithCloses(_closes3(10, 30, 20));
        uint256[2] memory bad = [uint256(0), id + 1];
        for (uint256 i = 0; i < 2; i++) {
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.freezeConsensus(bad[i], Kind.Human, 0);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.freezeAll(bad[i]);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.consensus(bad[i], Kind.Human);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.isPresent(bad[i], Kind.Human);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.frozenMask(bad[i], Kind.Human);
        }
    }

    function test_checkOrder() public {
        // round first
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.freezeConsensus(7, Kind.None, 200);

        uint256 id = _openW1(); // no reveals, still before revealEnd
        // kind before field, field before time, time before reveals
        vm.expectRevert(Arena.InvalidKind.selector);
        arena.freezeConsensus(id, Kind.None, 200);
        vm.expectRevert(Arena.InvalidField.selector);
        arena.freezeConsensus(id, Kind.Human, 200);
        vm.expectRevert(Arena.FreezeTooEarly.selector);
        arena.freezeConsensus(id, Kind.Human, 0);
        _toRevealEnd(id);
        vm.expectRevert(Arena.NoReveals.selector);
        arena.freezeConsensus(id, Kind.Human, 0);
    }

    // ------------------------------------------------------------ readiness

    function test_consensusNotReadyUntilAllNineFields() public {
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _spread());
        _revealQueued(id);
        _toRevealEnd(id);

        (Candle[3] memory path, bool ready) = arena.consensus(id, Kind.Human);
        assertFalse(ready, "ready before any freeze");
        assertEq(path[0].close, 0);

        for (uint8 f = 0; f < 8; f++) {
            arena.freezeConsensus(id, Kind.Human, f);
            (, ready) = arena.consensus(id, Kind.Human);
            assertFalse(ready, "ready after fewer than nine");
        }
        // the ninth freeze emits ConsensusReady exactly once, after its FieldFrozen
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 8, -90);
        vm.expectEmit(true, true, false, false, address(arena));
        emit ConsensusReady(id, Kind.Human);
        arena.freezeConsensus(id, Kind.Human, 8);
        (path, ready) = arena.consensus(id, Kind.Human);
        assertTrue(ready);
        _assertPath(path, _spreadValues());
    }

    function test_consensusReadyEmitsOnlyOnNinthFreeze() public {
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _spread());
        _revealQueued(id);
        _toRevealEnd(id);
        vm.recordLogs();
        for (uint8 f = 0; f < 9; f++) {
            arena.freezeConsensus(id, Kind.Human, f);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, Arena.FieldFrozen.selector), 9);
        assertEq(_countLogs(logs, Arena.ConsensusReady.selector), 1);
        assertEq(logs[logs.length - 1].topics[0], Arena.ConsensusReady.selector, "ConsensusReady comes last");
    }

    function test_partialConsensusIsPartial() public {
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _spread());
        _revealQueued(id);
        _toRevealEnd(id);
        arena.freezeConsensus(id, Kind.Human, 0); // close 1 only
        (Candle[3] memory path, bool ready) = arena.consensus(id, Kind.Human);
        assertFalse(ready);
        assertEq(path[0].close, 30);
        assertEq(path[0].high, 30, "repair lifts the unfrozen high to the close");
        assertEq(path[1].close, 0, "unfrozen close reads 0");
    }

    // ------------------------------------------------------------ repair (harness)

    function test_repairKeepsHighAboveCloseAndLowBelow() public {
        uint256 id = _openW1();
        // candle 1 (open 0): close 50, high 20 below close, low 10 above open -> high 50, low 0
        // candle 2 (open 50): close 80, high 90 valid, low 60 above open -> low 50
        // candle 3 (open 80): close 70, high 60 below open, low 75 above close -> high 80, low 70
        arena.forceFrozen(id, Kind.Human, [int32(50), 20, 10, 80, 90, 60, 70, 60, 75]);
        (Candle[3] memory p, bool ready) = arena.consensus(id, Kind.Human);
        assertTrue(ready);
        assertEq(p[0].close, 50);
        assertEq(p[0].high, 50, "high lifted to close");
        assertEq(p[0].low, 0, "low dropped to open");
        assertEq(p[1].close, 80);
        assertEq(p[1].high, 90, "valid high untouched");
        assertEq(p[1].low, 50, "low dropped to open 50 (close is 80)");
        assertEq(p[2].close, 70);
        assertEq(p[2].high, 80, "high lifted to open 80");
        assertEq(p[2].low, 70, "low dropped to close 70");
        assertTrue(ScoreLib.isValid(p));
    }

    function test_repairHighBelowOpenOnly() public {
        uint256 id = _openW1();
        // candle 2: open 40, close 10, high 20 (>= close, < open) -> lifted to 40
        arena.forceFrozen(id, Kind.Agent, [int32(40), 40, 0, 10, 20, 5, 10, 10, 10]);
        (Candle[3] memory p,) = arena.consensus(id, Kind.Agent);
        assertEq(p[1].high, 40);
        assertEq(p[1].low, 5, "valid low untouched");
        assertTrue(ScoreLib.isValid(p));
    }

    function test_repairLowAboveOpenOnly() public {
        uint256 id = _openW1();
        // candle 2: open -40, close -10, low -20 (<= close, > open) -> dropped to -40
        arena.forceFrozen(id, Kind.Human, [int32(-40), 0, -40, -10, 0, -20, -10, 0, -10]);
        (Candle[3] memory p,) = arena.consensus(id, Kind.Human);
        assertEq(p[1].low, -40);
        assertEq(p[1].high, 0, "valid high untouched");
        assertTrue(ScoreLib.isValid(p));
    }

    function test_repairNeverChangesCloses() public {
        uint256 id = _openW1();
        int32[9] memory v = [int32(-5), -100, 100, 7, -100, 100, -9, -100, 100];
        arena.forceFrozen(id, Kind.Human, v);
        (Candle[3] memory p,) = arena.consensus(id, Kind.Human);
        assertEq(p[0].close, -5);
        assertEq(p[1].close, 7);
        assertEq(p[2].close, -9);
        assertTrue(ScoreLib.isValid(p));
        // high -100 lifted to max(open, close), low 100 dropped to min(open, close)
        assertEq(p[0].high, 0);
        assertEq(p[0].low, -5);
        assertEq(p[1].high, 7);
        assertEq(p[1].low, -5);
        assertEq(p[2].high, 7);
        assertEq(p[2].low, -9);
    }

    function testFuzz_repairAlwaysValid(int32[9] memory v) public {
        uint256 id = _openW1();
        arena.forceFrozen(id, Kind.Human, v);
        (Candle[3] memory p, bool ready) = arena.consensus(id, Kind.Human);
        assertTrue(ready);
        assertTrue(ScoreLib.isValid(p), "repaired path invalid");
        int256 open = 0;
        for (uint256 i = 0; i < 3; i++) {
            int256 close = v[i * 3];
            int256 hi = v[i * 3 + 1];
            int256 lo = v[i * 3 + 2];
            int256 wantHi = hi;
            if (open > wantHi) wantHi = open;
            if (close > wantHi) wantHi = close;
            int256 wantLo = lo;
            if (open < wantLo) wantLo = open;
            if (close < wantLo) wantLo = close;
            assertEq(int256(p[i].close), close);
            assertEq(int256(p[i].high), wantHi);
            assertEq(int256(p[i].low), wantLo);
            open = close;
        }
    }

    // ------------------------------------------------------------ absent sides, freezeAll

    function test_freezeAllWithZeroRevealsMarksSideAbsent() public {
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _spread()); // agents never reveal
        _revealQueued(id);
        _toRevealEnd(id);
        assertTrue(arena.isPresent(id, Kind.Human));
        assertFalse(arena.isPresent(id, Kind.Agent));

        vm.expectEmit(true, true, false, false, address(arena));
        emit KindAbsent(id, Kind.Agent);
        arena.freezeAll(id); // must not revert

        assertFalse(arena.isPresent(id, Kind.Agent));
        (Candle[3] memory path, bool ready) = arena.consensus(id, Kind.Agent);
        assertFalse(ready);
        _assertPath(path, [int32(0), 0, 0, 0, 0, 0, 0, 0, 0]);
        assertEq(arena.frozenMask(id, Kind.Agent), 0, "nothing frozen for the absent side");
        vm.expectRevert(Arena.NoReveals.selector);
        arena.freezeConsensus(id, Kind.Agent, 0);

        // the present side is unaffected
        (path, ready) = arena.consensus(id, Kind.Human);
        assertTrue(ready);
        _assertPath(path, _spreadValues());
    }

    function test_freezeAllWithNoRevealsAtAllDoesNotRevert() public {
        uint256 id = _openW10();
        _toRevealEnd(id);
        vm.recordLogs();
        arena.freezeAll(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, Arena.KindAbsent.selector), 2);
        assertEq(_countLogs(logs, Arena.FieldFrozen.selector), 0);
        assertFalse(arena.isPresent(id, Kind.Human));
        assertFalse(arena.isPresent(id, Kind.Agent));
        (, bool ready) = arena.consensus(id, Kind.Human);
        assertFalse(ready);
        (, ready) = arena.consensus(id, Kind.Agent);
        assertFalse(ready);
    }

    function test_freezeAllFreezesBothKinds() public {
        uint256 id = _openW1();
        _joinN(id, Kind.Human, 3, _flat(10));
        _joinN(id, Kind.Agent, 3, _flat(-20));
        _revealQueued(id);
        _toRevealEnd(id);
        vm.recordLogs();
        arena.freezeAll(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, Arena.FieldFrozen.selector), 18);
        assertEq(_countLogs(logs, Arena.ConsensusReady.selector), 2);
        assertEq(_countLogs(logs, Arena.KindAbsent.selector), 0);

        assertEq(arena.frozenMask(id, Kind.Human), 0x1FF);
        assertEq(arena.frozenMask(id, Kind.Agent), 0x1FF);
        (Candle[3] memory h, bool hr) = arena.consensus(id, Kind.Human);
        (Candle[3] memory a, bool ar) = arena.consensus(id, Kind.Agent);
        assertTrue(hr);
        assertTrue(ar);
        _assertPath(h, [int32(10), 10, 0, 10, 10, 10, 10, 10, 10]);
        _assertPath(a, [int32(-20), 0, -20, -20, -20, -20, -20, -20, -20]);
    }

    function test_freezeAllIsIdempotent() public {
        uint256 id = _openW1();
        _joinN(id, Kind.Human, 3, _flat(10));
        _joinN(id, Kind.Agent, 3, _flat(-20));
        _revealQueued(id);
        _toRevealEnd(id);
        arena.freezeAll(id);
        (Candle[3] memory before_,) = arena.consensus(id, Kind.Human);

        vm.recordLogs();
        arena.freezeAll(id);
        arena.freezeAll(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "no events, no duplicate FieldFrozen or ConsensusReady");

        (Candle[3] memory after_,) = arena.consensus(id, Kind.Human);
        assertEq(abi.encode(before_), abi.encode(after_));
        assertEq(arena.frozenMask(id, Kind.Human), 0x1FF);
    }

    function test_freezeAllEmitsKindAbsentOnEveryCall() public {
        // documented behaviour: presence is derived, so the absent event is stateless and repeats
        uint256 id = _openW1();
        _joinN(id, Kind.Human, 3, _flat(10));
        _revealQueued(id);
        _toRevealEnd(id);
        vm.recordLogs();
        arena.freezeAll(id);
        arena.freezeAll(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, Arena.KindAbsent.selector), 2);
        assertEq(_countLogs(logs, Arena.FieldFrozen.selector), 9);
        assertEq(_countLogs(logs, Arena.ConsensusReady.selector), 1);
    }

    function test_freezeAllSkipsFieldsFrozenByAGriefer() public {
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _spread());
        _joinN(id, Kind.Agent, 3, _spread());
        _revealQueued(id);
        _toRevealEnd(id);

        vm.prank(stranger);
        arena.freezeConsensus(id, Kind.Human, 4);
        vm.prank(stranger);
        arena.freezeConsensus(id, Kind.Agent, 0);

        vm.recordLogs();
        arena.freezeAll(id); // must not revert on the frozen fields
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, Arena.FieldFrozen.selector), 16, "9 + 9 - 2 already frozen");
        assertEq(_countLogs(logs, Arena.ConsensusReady.selector), 2);
        assertEq(arena.frozenMask(id, Kind.Human), 0x1FF);
        assertEq(arena.frozenMask(id, Kind.Agent), 0x1FF);
        (Candle[3] memory h, bool hr) = arena.consensus(id, Kind.Human);
        assertTrue(hr);
        _assertPath(h, _spreadValues());
    }

    function test_freezeAllCompletesAfterEightManualFreezes() public {
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _spread());
        _revealQueued(id);
        _toRevealEnd(id);
        for (uint8 f = 0; f < 8; f++) {
            arena.freezeConsensus(id, Kind.Human, f);
        }
        vm.expectEmit(true, true, false, true, address(arena));
        emit FieldFrozen(id, Kind.Human, 8, -90);
        vm.expectEmit(true, true, false, false, address(arena));
        emit ConsensusReady(id, Kind.Human);
        arena.freezeAll(id);
        (, bool ready) = arena.consensus(id, Kind.Human);
        assertTrue(ready);
    }

    function test_skewedPresenceWithoutFreezeAll() public {
        // only humans reveal; the human side is frozen field by field, freezeAll never runs
        uint256 id = _openW10();
        _joinN(id, Kind.Human, 3, _spread());
        _revealQueued(id);
        _toRevealEnd(id);
        for (uint8 f = 0; f < 9; f++) {
            arena.freezeConsensus(id, Kind.Human, f);
        }
        (, bool hr) = arena.consensus(id, Kind.Human);
        assertTrue(hr);
        assertTrue(arena.isPresent(id, Kind.Human));
        assertFalse(arena.isPresent(id, Kind.Agent), "absent side is derived from revealCount");
        (Candle[3] memory a, bool ar) = arena.consensus(id, Kind.Agent);
        assertFalse(ar);
        _assertPath(a, [int32(0), 0, 0, 0, 0, 0, 0, 0, 0]);
        vm.expectRevert(Arena.NoReveals.selector);
        arena.freezeConsensus(id, Kind.Agent, 3);
    }

    // ------------------------------------------------------------ rounds

    function test_freezeIsRoundIsolated() public {
        uint256 id1 = _openW10(); // width 10
        RoundParams memory p2 = _params(15); // width 2
        p2.revealEnd = t0 + 400;
        p2.marketEnd = t0 + 500;
        p2.settleDeadline = t0 + 1680;
        uint256 id2 = _open(p2);
        assertEq(arena.bucketWidth(id1), 10);
        assertEq(arena.bucketWidth(id2), 2);

        _joinN(id1, Kind.Human, 3, _spread());
        _joinN(id2, Kind.Human, 3, _flat(7)); // bucket 103 -> 6
        _joinN(id2, Kind.Agent, 3, _flat(-7)); // bucket 96 -> -8
        _revealQueued(id1);
        _revealQueued(id2);

        vm.warp(arena.getRound(id1).revealEnd);
        arena.freezeAll(id1);
        assertEq(arena.frozenMask(id1, Kind.Human), 0x1FF);

        // round 2 is untouched: nothing frozen, not ready, and its own window is still closed
        assertEq(arena.frozenMask(id2, Kind.Human), 0);
        assertEq(arena.frozenMask(id2, Kind.Agent), 0);
        (, bool ready2) = arena.consensus(id2, Kind.Human);
        assertFalse(ready2);
        vm.expectRevert(Arena.FreezeTooEarly.selector);
        arena.freezeConsensus(id2, Kind.Human, 0);
        // round 1 never had agents; round 2's agents do not leak into it
        assertFalse(arena.isPresent(id1, Kind.Agent));
        assertTrue(arena.isPresent(id2, Kind.Agent));

        vm.warp(arena.getRound(id2).revealEnd);
        arena.freezeAll(id2);
        (Candle[3] memory h2,) = arena.consensus(id2, Kind.Human);
        (Candle[3] memory a2,) = arena.consensus(id2, Kind.Agent);
        _assertPath(h2, [int32(6), 6, 0, 6, 6, 6, 6, 6, 6]);
        _assertPath(a2, [int32(-8), 0, -8, -8, -8, -8, -8, -8, -8]);
        // round 1 is unchanged by round 2's freeze
        (Candle[3] memory h1, bool ready1) = arena.consensus(id1, Kind.Human);
        assertTrue(ready1);
        _assertPath(h1, _spreadValues());
        assertEq(arena.frozenMask(id1, Kind.Agent), 0);
    }

    /// @dev Older round 1 has 3 humans + 4 agents, newer round 2 has 7 humans + 0 agents (complementary
    ///      presence, different per-kind counts), and the newer round is frozen first. Every cross-round
    ///      read (`roundCount` instead of `id`) for reveal counts and masks changes an assertion here.
    function test_freezeIsRoundIsolatedWithDifferentCountsAndPresence() public {
        uint256 id1 = _openW1(); // width 1, revealEnd t0+200
        RoundParams memory p2 = _params(100); // width 10
        p2.revealEnd = t0 + 400;
        p2.marketEnd = t0 + 500;
        p2.settleDeadline = t0 + 1680;
        uint256 id2 = _open(p2);
        assertEq(arena.bucketWidth(id1), 1);
        assertEq(arena.bucketWidth(id2), 10);

        _join(id1, Kind.Human, _flat(10));
        _join(id1, Kind.Human, _flat(30));
        _join(id1, Kind.Human, _flat(20));
        _joinN(id1, Kind.Agent, 4, _flat(-7));
        _joinN(id2, Kind.Human, 7, _flat(500));
        _revealQueued(id1);
        _revealQueued(id2);
        assertEq(arena.revealCount(id1, Kind.Human), 3);
        assertEq(arena.revealCount(id1, Kind.Agent), 4);
        assertEq(arena.revealCount(id2, Kind.Human), 7);
        assertEq(arena.revealCount(id2, Kind.Agent), 0);

        // t0+200: freeze round 1's agents field by field (round 2 has no agents and is still closed)
        vm.warp(arena.getRound(id1).revealEnd);
        for (uint8 f = 0; f < 9; f++) {
            arena.freezeConsensus(id1, Kind.Agent, f);
        }
        (Candle[3] memory a1, bool ar1) = arena.consensus(id1, Kind.Agent);
        assertTrue(ar1, "round 1 agents ready");
        _assertPath(a1, [int32(-7), 0, -7, -7, -7, -7, -7, -7, -7]);
        assertEq(arena.frozenMask(id1, Kind.Agent), 0x1FF);
        vm.expectRevert(Arena.AlreadyFrozen.selector);
        arena.freezeConsensus(id1, Kind.Agent, 0);
        // round 1's humans are untouched so far, round 2 is untouched
        assertEq(arena.frozenMask(id1, Kind.Human), 0);
        (, bool hr1) = arena.consensus(id1, Kind.Human);
        assertFalse(hr1);
        assertEq(arena.frozenMask(id2, Kind.Human), 0);
        assertFalse(arena.isPresent(id2, Kind.Agent));

        // t0+400: the newer round is frozen first
        vm.warp(arena.getRound(id2).revealEnd);
        arena.freezeAll(id2);
        assertEq(arena.frozenMask(id2, Kind.Human), 0x1FF);
        vm.expectRevert(Arena.NoReveals.selector);
        arena.freezeConsensus(id2, Kind.Agent, 0);
        (Candle[3] memory h2, bool hr2) = arena.consensus(id2, Kind.Human);
        assertTrue(hr2);
        _assertPath(h2, [int32(500), 500, 0, 500, 500, 500, 500, 500, 500]);
        (, bool ar2) = arena.consensus(id2, Kind.Agent);
        assertFalse(ar2, "round 2 has no agents");
        // round 1's humans are still not ready: round 2's full mask must not leak into them
        (, hr1) = arena.consensus(id1, Kind.Human);
        assertFalse(hr1);
        assertEq(arena.frozenMask(id1, Kind.Human), 0);

        // freezeAll(1) must freeze all nine human fields (not skip them) with round 1's own target (2 of 3)
        vm.recordLogs();
        arena.freezeAll(id1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, Arena.FieldFrozen.selector), 9, "only the humans were left to freeze");
        assertEq(_countLogs(logs, Arena.ConsensusReady.selector), 1);
        assertEq(_countLogs(logs, Arena.KindAbsent.selector), 0);
        (Candle[3] memory h1, bool hr1b) = arena.consensus(id1, Kind.Human);
        assertTrue(hr1b);
        _assertPath(h1, [int32(20), 20, 0, 20, 20, 20, 20, 20, 20]);
        (a1, ar1) = arena.consensus(id1, Kind.Agent);
        assertTrue(ar1);
        _assertPath(a1, [int32(-7), 0, -7, -7, -7, -7, -7, -7, -7]);
    }

    /// @dev A side below the 3-reveal quorum is still present: it is frozen and ready (Review Focus 4);
    ///      the quorum rule lives in the market, not in the consensus.
    function test_freezeAllFreezesSidesBelowQuorum() public {
        uint256 id = _openW1();
        _join(id, Kind.Human, _flat(10));
        _join(id, Kind.Agent, _flat(-20));
        _join(id, Kind.Agent, _flat(-30));
        _revealQueued(id);
        _toRevealEnd(id);
        assertEq(arena.revealCount(id, Kind.Human), 1);
        assertEq(arena.revealCount(id, Kind.Agent), 2);

        vm.recordLogs();
        arena.freezeAll(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countLogs(logs, Arena.KindAbsent.selector), 0);
        assertEq(_countLogs(logs, Arena.FieldFrozen.selector), 18);
        assertEq(_countLogs(logs, Arena.ConsensusReady.selector), 2);
        assertTrue(arena.isPresent(id, Kind.Human));
        assertTrue(arena.isPresent(id, Kind.Agent));
        (Candle[3] memory h, bool hr) = arena.consensus(id, Kind.Human);
        (Candle[3] memory a, bool ar) = arena.consensus(id, Kind.Agent);
        assertTrue(hr);
        assertTrue(ar);
        _assertPath(h, [int32(10), 10, 0, 10, 10, 10, 10, 10, 10]);
        // two agents, lower median: sorted -30, -20 -> -30
        _assertPath(a, [int32(-30), 0, -30, -30, -30, -30, -30, -30, -30]);
    }

    // ------------------------------------------------------------ saturation

    function test_bucketValueTable() public view {
        uint32 w = 429496730; // T = uint32.max
        assertEq(arena.bucketValue(100, 1), 0);
        assertEq(arena.bucketValue(0, 1), -100);
        assertEq(arena.bucketValue(200, 1), 100);
        assertEq(arena.bucketValue(103, 2), 6);
        assertEq(arena.bucketValue(96, 2), -8);
        assertEq(arena.bucketValue(104, w), 1717986920);
        assertEq(arena.bucketValue(105, w), type(int32).max, "5 * width exceeds int32.max");
        assertEq(arena.bucketValue(200, w), type(int32).max, "saturates high");
        assertEq(arena.bucketValue(96, w), -1717986920);
        assertEq(arena.bucketValue(95, w), type(int32).min, "-5 * width is below int32.min");
        assertEq(arena.bucketValue(0, w), type(int32).min, "saturates low");
        assertEq(arena.bucketValue(100, w), 0);
    }

    function test_maxTLowerSaturationThroughConsensus() public {
        uint256 id = _open(_params(type(uint32).max));
        assertEq(arena.bucketWidth(id), 429496730);
        // every value is int32.min: floor(min / width) = -5 -> bucket 95 -> -2147483650 -> saturates
        Candle[3] memory low;
        low[0] = _c(type(int32).min, 0, type(int32).min);
        low[1] = _c(type(int32).min, type(int32).min, type(int32).min);
        low[2] = _c(type(int32).min, type(int32).min, type(int32).min);
        // every value is int32.max: floor(max / width) = 4 -> bucket 104 -> 1717986920 (no saturation)
        Candle[3] memory top;
        top[0] = _c(type(int32).max, type(int32).max, 0);
        top[1] = _c(type(int32).max, type(int32).max, type(int32).max);
        top[2] = _c(type(int32).max, type(int32).max, type(int32).max);
        assertTrue(ScoreLib.isValid(low));
        assertTrue(ScoreLib.isValid(top));
        _joinN(id, Kind.Human, 3, low);
        _joinN(id, Kind.Agent, 3, top);
        _revealQueued(id);
        _toRevealEnd(id);
        arena.freezeAll(id); // must not revert

        (Candle[3] memory h, bool hr) = arena.consensus(id, Kind.Human);
        (Candle[3] memory a, bool ar) = arena.consensus(id, Kind.Agent);
        assertTrue(hr);
        assertTrue(ar);
        int32 mn = type(int32).min;
        _assertPath(h, [mn, 0, mn, mn, mn, mn, mn, mn, mn]);
        _assertPath(
            a,
            [int32(1717986920), 1717986920, 0, 1717986920, 1717986920, 1717986920, 1717986920, 1717986920, 1717986920]
        );
        assertTrue(ScoreLib.isValid(h));
        assertTrue(ScoreLib.isValid(a));
    }

    // ------------------------------------------------------------ proof and fuzz

    function test_mixedOpensNeedNoRepair() public {
        // Mixed reveals with very different opens. For valid reveals the median high is never below the
        // median close or the previous median close (and the median low never above), so the repair is
        // defence in depth: the repaired path equals the raw medians.
        uint256 id = _openW1();
        Candle[3] memory a;
        a[0] = _c(100, 100, 0);
        a[1] = _c(100, 100, 100);
        a[2] = _c(100, 100, 100);
        Candle[3] memory b;
        b[0] = _c(-100, 0, -100);
        b[1] = _c(-100, -100, -100);
        b[2] = _c(-100, -100, -100);
        Candle[3] memory c;
        c[0] = _c(100, 100, 0);
        c[1] = _c(-100, 100, -100);
        c[2] = _c(100, 100, -100);
        _join(id, Kind.Human, a);
        _join(id, Kind.Human, b);
        _join(id, Kind.Human, c);
        _revealQueued(id);
        _toRevealEnd(id);
        arena.freezeAll(id);
        (Candle[3] memory p,) = arena.consensus(id, Kind.Human);
        assertTrue(ScoreLib.isValid(p));
        assertEq(p[0].close, 100);
        assertEq(p[0].high, 100);
        assertEq(p[0].low, 0);
        assertEq(p[1].close, -100);
        assertEq(p[1].high, 100);
        assertEq(p[1].low, -100);
    }

    function testFuzz_consensusMatchesIndependentOracle(uint256 seed, uint32 tRaw) public {
        uint32 T = _pickT(seed, tRaw);
        uint256 id = _open(_params(T));
        uint32 w = arena.bucketWidth(id);
        uint256 nH = 3 + (seed >> 8) % 5;
        uint256 nA = 3 + (seed >> 16) % 5;
        Candle[3][] memory hp = _randomPaths(seed, 1, nH);
        Candle[3][] memory ap = _randomPaths(seed, 2, nA);
        for (uint256 i = 0; i < nH; i++) {
            _join(id, Kind.Human, hp[i]);
        }
        for (uint256 i = 0; i < nA; i++) {
            _join(id, Kind.Agent, ap[i]);
        }
        _revealQueued(id);
        _toRevealEnd(id);
        arena.freezeAll(id);

        _checkAgainstOracle(id, Kind.Human, hp, w);
        _checkAgainstOracle(id, Kind.Agent, ap, w);
    }

    function _checkAgainstOracle(uint256 id, Kind k, Candle[3][] memory paths, uint32 w) internal view {
        (Candle[3] memory got, bool ready) = arena.consensus(id, k);
        assertTrue(ready);
        assertTrue(ScoreLib.isValid(got), "repaired path invalid");
        for (uint256 f = 0; f < 9; f++) {
            assertEq(_field(got, f), _oracleMedian(paths, f, w), "median");
        }
    }

    function _pickT(uint256 seed, uint32 tRaw) internal pure returns (uint32) {
        uint256 m = (seed >> 32) % 4;
        if (m == 0) return uint32(bound(tRaw, 1, type(uint32).max));
        if (m == 1) return uint32(bound(tRaw, 1, 20));
        if (m == 2) return uint32(bound(tRaw, 1, 5000));
        return uint32(bound(tRaw, type(uint32).max - 1000, type(uint32).max));
    }

    function _field(Candle[3] memory p, uint256 f) internal pure returns (int32) {
        Candle memory c = p[f / 3];
        uint256 r = f % 3;
        return r == 0 ? c.close : (r == 1 ? c.high : c.low);
    }

    /// @dev Independent oracle: floor-bucket every value, insertion-sort, take element ceil(n/2)-1, saturate.
    function _oracleMedian(Candle[3][] memory paths, uint256 f, uint32 w) internal pure returns (int32) {
        uint256 n = paths.length;
        int256[] memory b = new int256[](n);
        for (uint256 i = 0; i < n; i++) {
            int256 v = _field(paths[i], f);
            int256 q = v / int256(uint256(w));
            if (v % int256(uint256(w)) < 0) q -= 1;
            int256 idx = 100 + q;
            if (idx < 0) idx = 0;
            if (idx > 200) idx = 200;
            b[i] = idx;
        }
        for (uint256 i = 1; i < n; i++) {
            int256 key = b[i];
            uint256 j = i;
            while (j > 0 && b[j - 1] > key) {
                b[j] = b[j - 1];
                j--;
            }
            b[j] = key;
        }
        int256 val = (b[(n + 1) / 2 - 1] - 100) * int256(uint256(w));
        if (val < type(int32).min) return type(int32).min;
        if (val > type(int32).max) return type(int32).max;
        // forge-lint: disable-next-line(unsafe-typecast)
        return int32(val);
    }

    function _randomPaths(uint256 seed, uint256 salt, uint256 n) internal pure returns (Candle[3][] memory out) {
        out = new Candle[3][](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = _randomPath(uint256(keccak256(abi.encode(seed, salt, i))));
        }
    }

    function _randomPath(uint256 r) internal pure returns (Candle[3] memory p) {
        int256 open = 0;
        for (uint256 i = 0; i < 3; i++) {
            uint256 scale = _scale(r >> (i * 8));
            int256 close = _clamp(int256(uint256(keccak256(abi.encode(r, i, "c"))) % (2 * scale + 1)) - int256(scale));
            int256 hi = open > close ? open : close;
            int256 lo = open < close ? open : close;
            int256 up = int256(uint256(keccak256(abi.encode(r, i, "h"))) % (scale + 1));
            int256 dn = int256(uint256(keccak256(abi.encode(r, i, "l"))) % (scale + 1));
            hi = _clamp(hi + up);
            lo = _clamp(lo - dn);
            // forge-lint: disable-next-line(unsafe-typecast)
            p[i] = Candle(int32(close), int32(hi), int32(lo));
            open = close;
        }
    }

    function _scale(uint256 r) internal pure returns (uint256) {
        uint256 m = uint8(r) % 5;
        if (m == 0) return 10;
        if (m == 1) return 1000;
        if (m == 2) return 100_000;
        if (m == 3) return 1_000_000_000;
        return uint256(uint32(type(int32).max));
    }

    function _clamp(int256 x) internal pure returns (int256) {
        if (x < type(int32).min) return type(int32).min;
        if (x > type(int32).max) return type(int32).max;
        return x;
    }

    // ------------------------------------------------------------ gas

    function test_gasFreezeAllWorstCase() public {
        // Worst achievable walk: every field except candle-1 low lands in bucket 200 (width 10, value 5000
        // clamps). Candle-1 low <= open_1 = 0, so it can reach bucket 100 at most.
        uint256 id = _openW10();
        Candle[3] memory top;
        top[0] = _c(5000, 5000, 0);
        top[1] = _c(5000, 5000, 5000);
        top[2] = _c(5000, 5000, 5000);
        _joinN(id, Kind.Human, 3, top);
        _joinN(id, Kind.Agent, 3, top);
        _revealQueued(id);
        _toRevealEnd(id);
        uint256 g = gasleft();
        arena.freezeAll(id);
        g -= gasleft();
        console.log("freezeAll worst-case gas (both kinds):", g);
        assertLt(g, 3_000_000);
        (Candle[3] memory h,) = arena.consensus(id, Kind.Human);
        _assertPath(h, [int32(1000), 1000, 0, 1000, 1000, 1000, 1000, 1000, 1000]);
    }
}
