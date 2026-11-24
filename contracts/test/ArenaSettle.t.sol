// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Points} from "../src/Points.sol";
import {Registry, Kind} from "../src/Registry.sol";
import {AllowlistGate} from "../src/AllowlistGate.sol";
import {Candle} from "../src/ScoreLib.sol";
import {Arena, RoundParams} from "../src/Arena.sol";

/// @dev Known-answer numbers (hand-derived from the pinned score formula, Task 2 vectors):
///      real R1 = close [10,20,30] high [12,22,32] low [-2,8,18], T = 20.
///        perfect path (= R1) 100, "B" path 98, all-zero path 29 (= the baseline), "neg" path 3.
///      With the baseline 29 the rewards are 71, 69, 0, 0 (REWARD_PER_POINT = 1).
contract ArenaSettleTest is Test {
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
    Arena internal arena;

    Pending[] internal pending;

    address internal keeper = address(0x4EE9E4);
    address internal stranger = address(0x57A4);
    address[12] internal humans;
    address[12] internal agents;

    uint64 internal t0 = 1_000_000;
    uint256 internal constant STAKE = 50;
    bytes32 internal constant SRC = keccak256("source");

    // Per pool path index: 0 perfect, 1 B, 2 zero, 3 neg (against R1 / T = 20).
    uint8[4] internal SCORE = [100, 98, 29, 3];
    uint256[4] internal REWARD = [71, 69, 0, 0];

    function setUp() public {
        vm.warp(t0);
        points = new Points(address(this));
        gate = new AllowlistGate(address(this));
        registry = new Registry(points, gate, address(this));
        arena = new Arena(points, registry, address(this));
        points.setMinter(address(registry), true);
        points.setSpender(address(registry), true);
        points.setMinter(address(arena), true);
        points.setSpender(address(arena), true);
        registry.setArena(arena);
        arena.setKeeper(keeper);
        for (uint160 i = 0; i < 12; i++) {
            humans[i] = address(uint160(0x1000) + i);
            gate.setAllowed(humans[i], true);
            vm.prank(humans[i]);
            registry.registerHuman();
            agents[i] = address(uint160(0x2000) + i);
            vm.prank(agents[i]);
            registry.registerAgent("ipfs://agent");
        }
    }

    // ------------------------------------------------------------ paths

    function _real1() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(10, 12, -2);
        p[1] = Candle(20, 22, 8);
        p[2] = Candle(30, 32, 18);
    }

    /// @dev Real candles of the second round (T = 40): all values are multiples of 4.
    function _real2() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(-8, 0, -12);
        p[1] = Candle(-16, -8, -20);
        p[2] = Candle(-4, 0, -16);
    }

    function _pPerfect() internal pure returns (Candle[3] memory) {
        return _real1();
    }

    function _pB() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(10, 10, 0);
        p[1] = Candle(20, 20, 10);
        p[2] = Candle(30, 30, 20);
    }

    function _pZero() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(0, 0, 0);
        p[1] = Candle(0, 0, 0);
        p[2] = Candle(0, 0, 0);
    }

    function _pNeg() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(-10, 0, -10);
        p[1] = Candle(-20, -10, -20);
        p[2] = Candle(-30, -20, -30);
    }

    function _pool(uint8 i) internal pure returns (Candle[3] memory) {
        if (i == 0) return _pPerfect();
        if (i == 1) return _pB();
        if (i == 2) return _pZero();
        return _pNeg();
    }

    // ------------------------------------------------------------ helpers

    function _open(uint32 T, uint256 stake, uint32 candleSec, uint64 deadline) internal returns (uint256 id) {
        return _openME(T, stake, t0 + 300, candleSec, deadline);
    }

    /// @dev Same as `_open` with an explicit `marketEnd` (commitEnd t0+100 and revealEnd t0+200 are fixed).
    function _openME(uint32 T, uint256 stake, uint64 marketEnd, uint32 candleSec, uint64 deadline)
        internal
        returns (uint256 id)
    {
        RoundParams memory p;
        p.ticker = bytes32("AAPL");
        p.p0 = 190_00;
        p.T = T;
        p.commitEnd = t0 + 100;
        p.revealEnd = t0 + 200;
        p.marketEnd = marketEnd;
        p.candleSec = candleSec;
        p.settleDeadline = deadline;
        p.entryStake = stake;
        vm.prank(keeper);
        id = arena.openRound(p);
    }

    /// @dev T = 20 (bucket width 2), stake 50, candleSec 60: postable from t0+480, deadline t0+1480.
    function _stdOpen() internal returns (uint256) {
        return _open(20, STAKE, 60, t0 + 1480);
    }

    function _commit(uint256 id, address who, Candle[3] memory path, bool willReveal) internal {
        bytes32 salt = keccak256(abi.encode("salt", id, who));
        bytes32 h = arena.hashPath(path, salt, who);
        vm.prank(who);
        arena.commit(id, h);
        Pending storage q = pending.push();
        q.id = id;
        q.who = who;
        q.salt = salt;
        q.done = !willReveal;
        for (uint256 i = 0; i < 3; i++) {
            q.path[i] = path[i];
        }
    }

    function _revealAll(uint256 id) internal {
        uint64 ce = arena.getRound(id).commitEnd;
        if (vm.getBlockTimestamp() < ce) vm.warp(ce);
        for (uint256 i = 0; i < pending.length; i++) {
            Pending storage q = pending[i];
            if (q.id != id || q.done) continue;
            q.done = true;
            arena.reveal(id, q.who, q.path, q.salt);
        }
    }

    function _earliest(uint256 id) internal view returns (uint256) {
        RoundParams memory p = arena.getRound(id);
        return uint256(p.marketEnd) + 3 * uint256(p.candleSec);
    }

    function _toEarliest(uint256 id) internal {
        vm.warp(_earliest(id));
    }

    function _postWith(uint256 id, Candle[3] memory real) internal {
        vm.prank(keeper);
        arena.postCandles(id, real, SRC);
    }

    function _post(uint256 id) internal {
        _postWith(id, _real1());
    }

    /// @dev Round with humans (perfect, B, neg) and agents (neg, neg, B), all revealed; time at commitEnd.
    ///      Human consensus (hand-derived) is close [10,20,30] high [10,20,30] low [-2,8,18] -> 99;
    ///      agent consensus is the neg path -> 3.
    function _mixedRound() internal returns (uint256 id) {
        id = _stdOpen();
        _commit(id, humans[0], _pPerfect(), true);
        _commit(id, humans[1], _pB(), true);
        _commit(id, humans[2], _pNeg(), true);
        _commit(id, agents[0], _pNeg(), true);
        _commit(id, agents[1], _pNeg(), true);
        _commit(id, agents[2], _pB(), true);
        _revealAll(id);
    }

    function _bal(address a) internal view returns (uint256) {
        return points.balanceOf(a);
    }

    function _claimAs(address who, uint256 id) internal {
        vm.prank(who);
        arena.claim(id);
    }

    // ------------------------------------------------------------ postCandles: gating

    function test_postCandlesOnceOnly() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        _post(id);
        vm.expectRevert(Arena.AlreadyPosted.selector);
        _post(id);
        // A second post with different candles cannot overwrite either.
        vm.expectRevert(Arena.AlreadyPosted.selector);
        _postWith(id, _real2());
        (Candle[3] memory real,) = arena.realCandles(id);
        assertEq(real[0].close, 10);
        assertEq(real[2].low, 18);
    }

    function test_postCandlesBeforeCandlesEndReverts() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 300); // marketEnd
        vm.expectRevert(Arena.CandlesTooEarly.selector);
        _post(id);
        vm.warp(t0 + 479); // earliest - 1
        vm.expectRevert(Arena.CandlesTooEarly.selector);
        _post(id);
        assertFalse(arena.settled(id));
    }

    function test_postCandlesAtExactEarliestSucceeds() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 480); // marketEnd + 3 * candleSec
        _post(id);
        assertTrue(arena.settled(id));
    }

    function test_postCandlesAtSettleDeadlineSucceeds() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 1480);
        _post(id);
        assertTrue(arena.settled(id));
        assertFalse(arena.isVoid(id));
    }

    function test_postCandlesAfterSettleDeadlineReverts() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 1481);
        vm.expectRevert(Arena.PostWindowClosed.selector);
        _post(id);
        assertFalse(arena.settled(id));
        assertTrue(arena.isVoid(id));
    }

    function test_postCandlesNotKeeperReverts() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        vm.prank(stranger);
        vm.expectRevert(Arena.NotKeeper.selector);
        arena.postCandles(id, _real1(), SRC);
        vm.prank(address(this)); // the owner is not the keeper either
        vm.expectRevert(Arena.NotKeeper.selector);
        arena.postCandles(id, _real1(), SRC);
    }

    function test_postCandlesUnknownRoundReverts() public {
        _mixedRound();
        vm.warp(t0 + 5000);
        vm.prank(keeper);
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.postCandles(0, _real1(), SRC);
        vm.prank(keeper);
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.postCandles(2, _real1(), SRC);
    }

    function test_postCandlesInvalidRealRevertsAndOneShotSurvives() public {
        uint256 id = _mixedRound();
        _toEarliest(id);

        Candle[3] memory bad = _real1();
        bad[0].high = 5; // high < close
        vm.expectRevert(Arena.InvalidRealCandles.selector);
        _postWith(id, bad);

        bad = _real1();
        bad[1].low = 12; // low > open (= close of candle 1 = 10)
        vm.expectRevert(Arena.InvalidRealCandles.selector);
        _postWith(id, bad);

        bad = _real1();
        bad[0].low = 3; // low > open (P0 = 0)
        vm.expectRevert(Arena.InvalidRealCandles.selector);
        _postWith(id, bad);

        assertFalse(arena.settled(id));
        _post(id); // the one-shot survived every reverted attempt
        assertTrue(arena.settled(id));
    }

    // ------------------------------------------------------------ postCandles: effects

    function test_postCandlesFreezesItself() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        assertEq(arena.frozenMask(id, Kind.Human), 0); // nobody called freezeAll
        assertEq(arena.frozenMask(id, Kind.Agent), 0);
        _post(id);
        assertEq(arena.frozenMask(id, Kind.Human), 0x1FF);
        assertEq(arena.frozenMask(id, Kind.Agent), 0x1FF);
        (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(id);
        assertEq(h, 99);
        assertEq(a, 3);
        assertTrue(hp);
        assertTrue(ap);
    }

    function test_postCandlesWorksAfterGrieferFrozeSomeFields() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        vm.prank(stranger);
        arena.freezeConsensus(id, Kind.Human, 4);
        vm.prank(stranger);
        arena.freezeConsensus(id, Kind.Agent, 0);
        _post(id);
        assertEq(arena.frozenMask(id, Kind.Human), 0x1FF);
        assertEq(arena.frozenMask(id, Kind.Agent), 0x1FF);
        (uint8 h, uint8 a,,) = arena.consensusScores(id);
        assertEq(h, 99);
        assertEq(a, 3);
    }

    function test_postCandlesWorksAfterFreezeAll() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        arena.freezeAll(id);
        _post(id);
        (uint8 h, uint8 a,,) = arena.consensusScores(id);
        assertEq(h, 99);
        assertEq(a, 3);
    }

    function test_postCandlesEmitsEvent() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        vm.expectEmit(true, false, false, true, address(arena));
        emit CandlesPosted(id, SRC, 99, 3, true, true, 29);
        _post(id);
    }

    function test_postCandlesSucceedsWithEmptySide() public {
        uint256 id = _stdOpen();
        _commit(id, humans[0], _pPerfect(), true);
        _commit(id, humans[1], _pPerfect(), true);
        _commit(id, humans[2], _pPerfect(), true);
        _revealAll(id);
        _toEarliest(id);
        assertEq(arena.revealCount(id, Kind.Agent), 0);
        vm.expectEmit(true, false, false, true, address(arena));
        emit CandlesPosted(id, SRC, 100, 0, true, false, 29);
        _post(id);
        (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(id);
        assertEq(h, 100);
        assertEq(a, 0);
        assertTrue(hp);
        assertFalse(ap);
    }

    function test_postCandlesSucceedsWithEmptyHumanSide() public {
        uint256 id = _stdOpen();
        _commit(id, agents[0], _pB(), true);
        _commit(id, agents[1], _pB(), true);
        _commit(id, agents[2], _pB(), true);
        _revealAll(id);
        _toEarliest(id);
        _post(id);
        (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(id);
        assertEq(h, 0);
        assertEq(a, 98);
        assertFalse(hp);
        assertTrue(ap);
    }

    function test_postCandlesSucceedsWithNoRevealsAtAll() public {
        uint256 id = _stdOpen();
        _commit(id, humans[0], _pPerfect(), false);
        _toEarliest(id);
        _post(id);
        (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(id);
        assertEq(h, 0);
        assertEq(a, 0);
        assertFalse(hp);
        assertFalse(ap);
        assertEq(arena.baselineScore(id), 29);
        assertTrue(arena.settled(id));
    }

    function test_belowQuorumSidesAreStillScored() public {
        uint256 id = _stdOpen();
        _commit(id, humans[0], _pPerfect(), true); // 1 human reveal
        _commit(id, agents[0], _pB(), true); // 2 agent reveals
        _commit(id, agents[1], _pB(), true);
        _revealAll(id);
        _toEarliest(id);
        _post(id);
        (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(id);
        assertEq(h, 100);
        assertEq(a, 98);
        assertTrue(hp);
        assertTrue(ap);
    }

    function test_consensusScoresStored() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        _post(id);
        (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(id);
        assertEq(h, 99);
        assertEq(a, 3);
        assertTrue(hp);
        assertTrue(ap);
        // Stored: reading later, after a griefing freezeAll and a long wait, gives the same answer.
        arena.freezeAll(id);
        vm.warp(t0 + 100_000);
        (h, a, hp, ap) = arena.consensusScores(id);
        assertEq(h, 99);
        assertEq(a, 3);
    }

    function test_consensusEqualToRealScores100() public {
        uint256 id = _stdOpen();
        for (uint256 i = 0; i < 3; i++) {
            _commit(id, humans[i], _real1(), true);
            _commit(id, agents[i], _real1(), true);
        }
        _revealAll(id);
        _toEarliest(id);
        _post(id);
        (uint8 h, uint8 a,,) = arena.consensusScores(id);
        assertEq(h, 100);
        assertEq(a, 100);
    }

    function test_baselineScoreStored() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        _post(id);
        assertEq(arena.baselineScore(id), 29);
    }

    /// @dev The baseline is the all-zero path against the real candles, never the consensus: a
    ///      consensus equal to the real path (100) must leave it at 29.
    function test_baselineIsIndependentOfConsensus() public {
        uint256 id = _stdOpen();
        for (uint256 i = 0; i < 3; i++) {
            _commit(id, humans[i], _real1(), true);
        }
        _revealAll(id);
        _toEarliest(id);
        _post(id);
        (uint8 h,,,) = arena.consensusScores(id);
        assertEq(h, 100);
        assertEq(arena.baselineScore(id), 29);
    }

    function test_realCandlesStored() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        _post(id);
        (Candle[3] memory real, bytes32 src) = arena.realCandles(id);
        assertEq(src, SRC);
        Candle[3] memory want = _real1();
        for (uint256 i = 0; i < 3; i++) {
            assertEq(real[i].close, want[i].close);
            assertEq(real[i].high, want[i].high);
            assertEq(real[i].low, want[i].low);
        }
    }

    // ------------------------------------------------------------ views before posting / unknown ids

    function test_settledViewsRevertBeforePosting() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        assertFalse(arena.settled(id));
        vm.expectRevert(Arena.NotSettled.selector);
        arena.consensusScores(id);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.baselineScore(id);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.realCandles(id);
    }

    function test_viewsUnknownRoundReverts() public {
        _mixedRound();
        for (uint256 k = 0; k < 2; k++) {
            uint256 bad = k == 0 ? 0 : 2;
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.settled(bad);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.isVoid(bad);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.consensusScores(bad);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.baselineScore(bad);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.realCandles(bad);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.isClaimed(bad, humans[0]);
            vm.expectRevert(Arena.UnknownRound.selector);
            arena.voidRound(bad);
            vm.expectRevert(Arena.UnknownRound.selector);
            _claimAs(humans[0], bad);
        }
    }

    // ------------------------------------------------------------ claim: settled round

    function test_claimReturnsStakeForRevealed() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        _post(id);
        // humans[2] revealed the "neg" path: score 3 < baseline 29, so the stake comes back and nothing else.
        uint256 before_ = _bal(humans[2]);
        assertEq(before_, 1000 - STAKE);
        uint256 supplyBefore = points.totalSupply();
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, humans[2], Kind.Human, 3, 0, STAKE);
        _claimAs(humans[2], id);
        assertEq(_bal(humans[2]), 1000);
        assertEq(points.totalSupply(), supplyBefore + STAKE);
        assertTrue(arena.isClaimed(id, humans[2]));
    }

    function test_unrevealedStakeIsBurned() public {
        uint256 id = _stdOpen();
        _commit(id, humans[0], _pPerfect(), true);
        _commit(id, humans[1], _pPerfect(), true);
        _commit(id, humans[2], _pPerfect(), true);
        _commit(id, humans[3], _pPerfect(), false); // never reveals
        uint256 supplyAfterCommits = points.totalSupply();
        _revealAll(id);
        _toEarliest(id);
        _post(id);
        assertEq(_bal(humans[3]), 1000 - STAKE);
        vm.prank(humans[3]);
        vm.expectRevert(Arena.NotRevealed.selector);
        arena.claim(id);
        assertEq(_bal(humans[3]), 1000 - STAKE);
        assertEq(points.totalSupply(), supplyAfterCommits);
        assertFalse(arena.isClaimed(id, humans[3]));
        // Still burned after everybody else claimed: supply = start - 4 stakes + 3 stakes + 3 rewards.
        for (uint256 i = 0; i < 3; i++) {
            _claimAs(humans[i], id);
        }
        assertEq(points.totalSupply(), supplyAfterCommits + 3 * STAKE + 3 * 71);
        vm.prank(humans[3]);
        vm.expectRevert(Arena.NotRevealed.selector);
        arena.claim(id);
    }

    function test_rewardMintedOnlyAboveBaseline() public {
        uint256 id = _stdOpen();
        address[4] memory who = [humans[0], humans[1], humans[2], humans[3]];
        // pool index: perfect 100, B 98, zero 29 (== baseline), neg 3
        _commit(id, who[0], _pool(0), true);
        _commit(id, who[1], _pool(1), true);
        _commit(id, who[2], _pool(2), true);
        _commit(id, who[3], _pool(3), true);
        _revealAll(id);
        _toEarliest(id);
        _post(id);
        assertEq(arena.baselineScore(id), 29);

        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, who[0], Kind.Human, 100, 71, STAKE);
        _claimAs(who[0], id);
        assertEq(_bal(who[0]), 1000 - STAKE + STAKE + 71);

        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, who[1], Kind.Human, 98, 69, STAKE);
        _claimAs(who[1], id);
        assertEq(_bal(who[1]), 1000 + 69);

        // exactly equal to the baseline: stake only
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, who[2], Kind.Human, 29, 0, STAKE);
        _claimAs(who[2], id);
        assertEq(_bal(who[2]), 1000);

        // below the baseline: stake only
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, who[3], Kind.Human, 3, 0, STAKE);
        _claimAs(who[3], id);
        assertEq(_bal(who[3]), 1000);
    }

    function test_agentEntryIsPaidAndLabelledAgent() public {
        uint256 id = _stdOpen();
        _commit(id, agents[0], _pB(), true);
        _revealAll(id);
        _toEarliest(id);
        _post(id);
        uint256 before_ = _bal(agents[0]);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, agents[0], Kind.Agent, 98, 69, STAKE);
        _claimAs(agents[0], id);
        assertEq(_bal(agents[0]), before_ + STAKE + 69);
    }

    function test_claimUsesCommitTimeKindAfterReclassify() public {
        uint256 id = _stdOpen();
        _commit(id, humans[0], _pPerfect(), true);
        _revealAll(id);
        _toEarliest(id);
        _post(id);
        // Every commit window is closed, so the owner may reclassify.
        registry.reclassify(humans[0], Kind.Agent);
        assertEq(uint8(registry.kindOf(humans[0])), uint8(Kind.Agent));
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, humans[0], Kind.Human, 100, 71, STAKE); // snapshot kind, not registry.kindOf
        _claimAs(humans[0], id);
    }

    function test_claimTwiceReverts() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        _post(id);
        _claimAs(humans[0], id);
        uint256 bal = _bal(humans[0]);
        uint256 supply = points.totalSupply();
        vm.prank(humans[0]);
        vm.expectRevert(Arena.AlreadyClaimed.selector);
        arena.claim(id);
        assertEq(_bal(humans[0]), bal);
        assertEq(points.totalSupply(), supply);
    }

    function test_claimBeforeSettleOrVoidReverts() public {
        uint256 id = _mixedRound();
        vm.prank(humans[0]);
        vm.expectRevert(Arena.NotClaimable.selector);
        arena.claim(id); // before candles can even be posted
        _toEarliest(id);
        vm.prank(humans[0]);
        vm.expectRevert(Arena.NotClaimable.selector);
        arena.claim(id); // postable but not posted
        vm.warp(t0 + 1480); // == settleDeadline: not void yet
        vm.prank(humans[0]);
        vm.expectRevert(Arena.NotClaimable.selector);
        arena.claim(id);
    }

    function test_claimWithoutCommitReverts() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        _post(id);
        vm.prank(stranger);
        vm.expectRevert(Arena.NoCommit.selector);
        arena.claim(id);
        vm.prank(humans[5]); // registered but did not enter this round
        vm.expectRevert(Arena.NoCommit.selector);
        arena.claim(id);
    }

    function test_claimNoCommitOnVoidRoundReverts() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 1481);
        vm.prank(stranger);
        vm.expectRevert(Arena.NoCommit.selector);
        arena.claim(id);
    }

    function test_claimCheckOrderNotClaimableBeforeNoCommit() public {
        uint256 id = _mixedRound();
        vm.prank(stranger);
        vm.expectRevert(Arena.NotClaimable.selector);
        arena.claim(id);
    }

    // ------------------------------------------------------------ void

    function test_voidAfterDeadlineRefundsAllStakes() public {
        uint256 id = _stdOpen();
        _commit(id, humans[0], _pPerfect(), true); // revealed, would be a 71-point winner if settled
        _commit(id, humans[1], _pB(), true);
        _commit(id, humans[2], _pZero(), false); // unrevealed
        _commit(id, agents[0], _pNeg(), true);
        uint256 supplyAfterCommits = points.totalSupply();
        _revealAll(id);
        vm.warp(t0 + 1481);
        vm.expectEmit(true, false, false, true, address(arena));
        emit RoundVoided(id);
        arena.voidRound(id);
        assertTrue(arena.isVoid(id));

        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, humans[0], Kind.Human, 0, 0, STAKE);
        _claimAs(humans[0], id);
        assertEq(_bal(humans[0]), 1000); // stake only, no reward
        _claimAs(humans[1], id);
        assertEq(_bal(humans[1]), 1000);
        _claimAs(humans[2], id); // unrevealed gets the stake back too
        assertEq(_bal(humans[2]), 1000);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, agents[0], Kind.Agent, 0, 0, STAKE);
        _claimAs(agents[0], id);
        assertEq(_bal(agents[0]), 900);
        assertEq(points.totalSupply(), supplyAfterCommits + 4 * STAKE);
    }

    /// @dev Refunds must not depend on anyone sending `voidRound`.
    function test_voidIsDerivedRefundWorksWithoutVoidRoundCall() public {
        uint256 id = _stdOpen();
        _commit(id, humans[0], _pPerfect(), true);
        _commit(id, humans[1], _pZero(), false);
        _revealAll(id);
        vm.warp(t0 + 1480);
        assertFalse(arena.isVoid(id)); // == settleDeadline: still postable
        vm.warp(t0 + 1481);
        assertTrue(arena.isVoid(id));
        assertFalse(arena.settled(id));
        _claimAs(humans[0], id);
        _claimAs(humans[1], id);
        assertEq(_bal(humans[0]), 1000);
        assertEq(_bal(humans[1]), 1000);
    }

    function test_voidBeforeDeadlineReverts() public {
        uint256 id = _mixedRound();
        vm.expectRevert(Arena.NotVoidable.selector);
        arena.voidRound(id);
        vm.warp(t0 + 1480); // == settleDeadline
        vm.expectRevert(Arena.NotVoidable.selector);
        arena.voidRound(id);
        assertFalse(arena.isVoid(id));
        vm.warp(t0 + 1481);
        arena.voidRound(id); // anyone
        assertTrue(arena.isVoid(id));
    }

    function test_voidRoundAfterPostingReverts() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 1480);
        _post(id);
        vm.warp(t0 + 99_999);
        vm.expectRevert(Arena.AlreadySettled.selector);
        arena.voidRound(id);
        assertFalse(arena.isVoid(id));
        assertTrue(arena.settled(id));
    }

    function test_voidRoundTwiceReverts() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 1481);
        vm.prank(stranger);
        arena.voidRound(id);
        vm.expectRevert(Arena.AlreadyVoided.selector);
        arena.voidRound(id);
    }

    function test_postCandlesAfterVoidRoundReverts() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 1481);
        arena.voidRound(id);
        vm.expectRevert(Arena.RoundIsVoid.selector);
        _post(id);
        assertFalse(arena.settled(id));
        assertTrue(arena.isVoid(id));
    }

    function test_voidRoundClaimTwiceReverts() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 1481);
        _claimAs(humans[0], id);
        uint256 supply = points.totalSupply();
        vm.prank(humans[0]);
        vm.expectRevert(Arena.AlreadyClaimed.selector);
        arena.claim(id);
        assertEq(points.totalSupply(), supply);
        assertEq(_bal(humans[0]), 1000);
    }

    function test_voidRoundViewsRevertNotSettled() public {
        uint256 id = _mixedRound();
        vm.warp(t0 + 1481);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.consensusScores(id);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.baselineScore(id);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.realCandles(id);
    }

    function test_settledRoundIsNeverVoid() public {
        uint256 id = _mixedRound();
        _toEarliest(id);
        _post(id);
        assertFalse(arena.isVoid(id));
        vm.warp(t0 + 10_000_000);
        assertFalse(arena.isVoid(id));
    }

    // ------------------------------------------------------------ two live rounds

    /// @dev Three live rounds that differ in T, stake, real candles, reveal counts, kinds present,
    ///      candleSec and deadline. Round 2 (the newer) is posted before round 1; round 3 voids.
    ///      Hand-derived known answers:
    ///        R1 (T=20, real R1): baseline 29; human consensus (lower median of 4) scores 29; no agents.
    ///        R2 (T=40, real R2): baseline 68; human consensus 100 (1 reveal); agent consensus 69 (2 reveals).
    ///        h0's R1-perfect path scores 31 against R2 and 100 against R1.
    function test_twoLiveRoundsDoNotLeak() public {
        uint256 r1 = _open(20, 50, 60, t0 + 1480);
        uint256 r2 = _open(40, 80, 30, t0 + 900);
        uint256 r3 = _open(20, 30, 20, t0 + 600);
        assertEq(r1, 1);
        assertEq(r2, 2);
        assertEq(r3, 3);

        // round 1: four revealed humans + one unrevealed
        _commit(r1, humans[0], _pPerfect(), true);
        _commit(r1, humans[1], _pB(), true);
        _commit(r1, humans[2], _pNeg(), true);
        _commit(r1, humans[3], _pZero(), true);
        _commit(r1, humans[4], _pPerfect(), false);
        // round 2: one human (below quorum), two agents
        _commit(r2, humans[0], _real2(), true);
        _commit(r2, agents[0], _real1(), true);
        _commit(r2, agents[1], _pZero(), true);
        // round 3: one revealed, one not
        _commit(r3, humans[0], _pPerfect(), true);
        _commit(r3, humans[1], _pNeg(), false);
        uint256 supply0 = points.totalSupply() + 5 * 50 + 3 * 80 + 2 * 30;

        _revealAll(r1);
        _revealAll(r2);
        _revealAll(r3);

        // t0+390: only round 2 is postable (390 = 300 + 3*30). Round 1 needs 480, round 3 needs 360 (open).
        vm.warp(t0 + 390);
        vm.prank(keeper);
        vm.expectRevert(Arena.CandlesTooEarly.selector);
        arena.postCandles(r1, _real1(), SRC);
        vm.prank(keeper);
        arena.postCandles(r2, _real2(), bytes32(uint256(2)));

        assertTrue(arena.settled(r2));
        assertFalse(arena.settled(r1));
        assertFalse(arena.settled(r3));
        assertFalse(arena.isVoid(r1));
        assertFalse(arena.isVoid(r2));
        assertFalse(arena.isVoid(r3));
        assertEq(arena.baselineScore(r2), 68);
        {
            (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(r2);
            assertEq(h, 100);
            assertEq(a, 69);
            assertTrue(hp);
            assertTrue(ap);
        }
        vm.expectRevert(Arena.NotSettled.selector);
        arena.baselineScore(r1);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.consensusScores(r1);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.realCandles(r1);
        vm.prank(humans[0]);
        vm.expectRevert(Arena.NotClaimable.selector);
        arena.claim(r1);

        // h0 claims round 2 first: stake 80, score 100 vs real 2, reward 100 - 68 = 32.
        uint256 b0 = _bal(humans[0]);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(r2, humans[0], Kind.Human, 100, 32, 80);
        _claimAs(humans[0], r2);
        assertEq(_bal(humans[0]), b0 + 80 + 32);
        assertTrue(arena.isClaimed(r2, humans[0]));
        assertFalse(arena.isClaimed(r1, humans[0]));
        assertFalse(arena.isClaimed(r3, humans[0]));

        // t0+480: the older round settles after the newer one.
        vm.warp(t0 + 480);
        _post(r1);
        assertEq(arena.baselineScore(r1), 29);
        {
            (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(r1);
            assertEq(h, 29);
            assertEq(a, 0);
            assertTrue(hp);
            assertFalse(ap);
            // round 2's stored values are untouched
            (h, a, hp, ap) = arena.consensusScores(r2);
            assertEq(h, 100);
            assertEq(a, 69);
        }
        assertEq(arena.baselineScore(r2), 68);
        {
            (Candle[3] memory real1, bytes32 s1) = arena.realCandles(r1);
            (Candle[3] memory real2, bytes32 s2) = arena.realCandles(r2);
            assertEq(s1, SRC);
            assertEq(s2, bytes32(uint256(2)));
            assertEq(real1[0].close, 10);
            assertEq(real2[0].close, -8);
            assertEq(real2[2].low, -16);
        }

        // round 1 claims: the same address, claim in R1 after R2 was claimed
        b0 = _bal(humans[0]);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(r1, humans[0], Kind.Human, 100, 71, 50);
        _claimAs(humans[0], r1);
        assertEq(_bal(humans[0]), b0 + 50 + 71);
        assertTrue(arena.isClaimed(r1, humans[0]));
        assertFalse(arena.isClaimed(r3, humans[0]));

        uint256 b1 = _bal(humans[1]);
        _claimAs(humans[1], r1);
        assertEq(_bal(humans[1]), b1 + 50 + 69);
        uint256 b2 = _bal(humans[2]);
        _claimAs(humans[2], r1);
        assertEq(_bal(humans[2]), b2 + 50);
        uint256 b3 = _bal(humans[3]);
        _claimAs(humans[3], r1);
        assertEq(_bal(humans[3]), b3 + 50);
        vm.prank(humans[4]);
        vm.expectRevert(Arena.NotRevealed.selector);
        arena.claim(r1);

        // round 2 others: R1's perfect path scores 31 against R2 (< 68); zero path scores 68 (== baseline)
        uint256 ba0 = _bal(agents[0]);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(r2, agents[0], Kind.Agent, 31, 0, 80);
        _claimAs(agents[0], r2);
        assertEq(_bal(agents[0]), ba0 + 80);
        uint256 ba1 = _bal(agents[1]);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(r2, agents[1], Kind.Agent, 68, 0, 80);
        _claimAs(agents[1], r2);
        assertEq(_bal(agents[1]), ba1 + 80);

        // t0+1000: round 2's deadline passed but it is settled; round 3 is void (deadline t0+600).
        vm.warp(t0 + 1000);
        assertFalse(arena.isVoid(r1));
        assertFalse(arena.isVoid(r2));
        assertTrue(arena.isVoid(r3));
        assertFalse(arena.settled(r3));
        vm.expectRevert(Arena.AlreadySettled.selector);
        arena.voidRound(r2);
        vm.expectRevert(Arena.AlreadySettled.selector);
        arena.voidRound(r1);
        vm.prank(keeper);
        vm.expectRevert(Arena.PostWindowClosed.selector);
        arena.postCandles(r3, _real1(), SRC);

        // round 3: stake 30 refunded, no reward even for the perfect path; unrevealed refunded too
        b0 = _bal(humans[0]);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(r3, humans[0], Kind.Human, 0, 0, 30);
        _claimAs(humans[0], r3);
        assertEq(_bal(humans[0]), b0 + 30);
        b1 = _bal(humans[1]);
        _claimAs(humans[1], r3);
        assertEq(_bal(humans[1]), b1 + 30);

        // supply: start, minus the burned unrevealed R1 stake, plus rewards 71 + 69 + 32
        assertEq(points.totalSupply(), supply0 - 50 + 71 + 69 + 32);
        // nobody can claim twice in any round
        vm.prank(humans[0]);
        vm.expectRevert(Arena.AlreadyClaimed.selector);
        arena.claim(r1);
        vm.prank(humans[0]);
        vm.expectRevert(Arena.AlreadyClaimed.selector);
        arena.claim(r2);
        vm.prank(humans[0]);
        vm.expectRevert(Arena.AlreadyClaimed.selector);
        arena.claim(r3);
    }

    /// @dev A voided older round and a settled newer round in the same block range.
    function test_olderRoundVoidNewerSettled() public {
        uint256 r1 = _open(20, 50, 20, t0 + 600); // will void
        uint256 r2 = _open(40, 80, 60, t0 + 1480); // will settle
        _commit(r1, humans[0], _pPerfect(), true);
        _commit(r2, humans[0], _real2(), true);
        _commit(r2, humans[1], _pZero(), true);
        _revealAll(r1);
        _revealAll(r2);
        vm.warp(t0 + 480);
        _postWith(r2, _real2());
        vm.warp(t0 + 601);
        assertTrue(arena.isVoid(r1));
        assertFalse(arena.isVoid(r2));
        // claim in the settled round first, then the void one
        _claimAs(humans[0], r2);
        assertEq(_bal(humans[0]), 1000 - 50 - 80 + 80 + 32);
        _claimAs(humans[0], r1);
        assertEq(_bal(humans[0]), 1000 - 50 - 80 + 80 + 32 + 50);
        _claimAs(humans[1], r2); // zero path scores exactly the baseline 68
        assertEq(_bal(humans[1]), 1000);
    }

    /// @dev Older round R1 (T=20, candleSec 60, deadline t0+1480) and newer R2 (T=40, candleSec 20,
    ///      deadline t0+600): every window and view must key on the id, not on `roundCount`.
    function test_windowsAndViewsKeyOnIdNewerHasShorterDeadline() public {
        uint256 r1 = _open(20, 50, 60, t0 + 1480);
        uint256 r2 = _open(40, 80, 20, t0 + 600);
        vm.warp(t0 + 400); // R2 postable since t0+360, R1 only from t0+480
        vm.prank(keeper);
        vm.expectRevert(Arena.CandlesTooEarly.selector);
        arena.postCandles(r1, _real1(), SRC);

        vm.warp(t0 + 700); // R2 is past its deadline, R1 is not
        assertTrue(arena.isVoid(r2));
        assertFalse(arena.isVoid(r1));
        vm.expectRevert(Arena.NotVoidable.selector);
        arena.voidRound(r1);
        vm.prank(keeper);
        vm.expectRevert(Arena.PostWindowClosed.selector);
        arena.postCandles(r2, _real2(), SRC);
        _post(r1); // R1 is still postable (and R1's T = 20 gives baseline 29; T = 40 would give 52)

        assertTrue(arena.settled(r1));
        assertFalse(arena.settled(r2));
        assertEq(arena.baselineScore(r1), 29);
        (Candle[3] memory real, bytes32 src) = arena.realCandles(r1);
        assertEq(real[0].close, 10);
        assertEq(src, SRC);
        (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(r1);
        assertEq(h, 0);
        assertEq(a, 0);
        assertFalse(hp);
        assertFalse(ap);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.baselineScore(r2);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.consensusScores(r2);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.realCandles(r2);

        arena.voidRound(r2); // allowed: R2 unposted and past its deadline
        assertTrue(arena.isVoid(r2));
        assertFalse(arena.isVoid(r1));
        assertFalse(arena.isClaimed(r1, humans[0]));
    }

    /// @dev Reverse direction: the older round R1 has the short deadline and the newer R2 the long one.
    function test_windowsAndViewsKeyOnIdNewerHasLongerDeadline() public {
        uint256 r1 = _open(20, 50, 20, t0 + 600);
        uint256 r2 = _open(40, 80, 60, t0 + 1480);
        vm.warp(t0 + 500); // R2 postable from t0+480
        _postWith(r2, _real2());
        assertEq(arena.baselineScore(r2), 68);
        assertTrue(arena.settled(r2));
        assertFalse(arena.settled(r1));
        vm.expectRevert(Arena.NotSettled.selector);
        arena.baselineScore(r1);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.consensusScores(r1);
        vm.expectRevert(Arena.NotSettled.selector);
        arena.realCandles(r1);

        vm.warp(t0 + 700); // R1 past its deadline, R2 not (and R2 is posted anyway)
        assertTrue(arena.isVoid(r1));
        assertFalse(arena.isVoid(r2));
        vm.prank(keeper);
        vm.expectRevert(Arena.PostWindowClosed.selector);
        arena.postCandles(r1, _real1(), SRC);
        arena.voidRound(r1);
        vm.expectRevert(Arena.AlreadySettled.selector);
        arena.voidRound(r2);
        assertTrue(arena.isVoid(r1));
        assertFalse(arena.isVoid(r2));
    }

    /// @dev Older R1 has the EARLY marketEnd (t0+300, earliest t0+480), newer R2 the late one
    ///      (t0+1500, earliest t0+1680, deadline t0+2000). Exact boundaries for both rounds.
    function test_marketEndKeyedOnIdNewerIsLater() public {
        uint256 r1 = _openME(20, 50, t0 + 300, 60, t0 + 1480);
        uint256 r2 = _openME(40, 80, t0 + 1500, 60, t0 + 2000);
        vm.warp(t0 + 479);
        vm.prank(keeper);
        vm.expectRevert(Arena.CandlesTooEarly.selector);
        arena.postCandles(r1, _real1(), SRC);
        vm.warp(t0 + 480);
        vm.prank(keeper);
        vm.expectRevert(Arena.CandlesTooEarly.selector); // R2's own earliest is t0+1680
        arena.postCandles(r2, _real2(), SRC);
        _post(r1); // R1 at exactly its own earliest
        assertTrue(arena.settled(r1));
        assertFalse(arena.settled(r2));
        assertEq(arena.baselineScore(r1), 29);

        vm.warp(t0 + 1679);
        vm.prank(keeper);
        vm.expectRevert(Arena.CandlesTooEarly.selector);
        arena.postCandles(r2, _real2(), SRC);
        vm.warp(t0 + 1680);
        _postWith(r2, _real2());
        assertTrue(arena.settled(r2));
        assertEq(arena.baselineScore(r2), 68);
        assertFalse(arena.isVoid(r1));
        assertFalse(arena.isVoid(r2));
    }

    /// @dev Reverse: older R1 has the LATE marketEnd (t0+1000, earliest t0+1180), newer R2 the early one
    ///      (t0+300, earliest t0+480, deadline t0+1480).
    function test_marketEndKeyedOnIdOlderIsLater() public {
        uint256 r1 = _openME(20, 50, t0 + 1000, 60, t0 + 2000);
        uint256 r2 = _openME(40, 80, t0 + 300, 60, t0 + 1480);
        vm.warp(t0 + 479);
        vm.prank(keeper);
        vm.expectRevert(Arena.CandlesTooEarly.selector);
        arena.postCandles(r2, _real2(), SRC);
        vm.warp(t0 + 480);
        vm.prank(keeper);
        vm.expectRevert(Arena.CandlesTooEarly.selector); // R1's own earliest is t0+1180
        arena.postCandles(r1, _real1(), SRC);
        _postWith(r2, _real2()); // R2 at exactly its own earliest (a read of R1's marketEnd would revert)
        assertTrue(arena.settled(r2));
        assertFalse(arena.settled(r1));
        assertEq(arena.baselineScore(r2), 68);

        vm.warp(t0 + 1179);
        vm.prank(keeper);
        vm.expectRevert(Arena.CandlesTooEarly.selector);
        arena.postCandles(r1, _real1(), SRC);
        vm.warp(t0 + 1180);
        _post(r1);
        assertTrue(arena.settled(r1));
        assertEq(arena.baselineScore(r1), 29);
    }

    /// @dev The older round must stay postable up to its own `settleDeadline` even when the newer round's
    ///      earliest post time (t0+1680) lies after it; otherwise a wrong read would force R1 to void.
    function test_olderRoundPostableAtOwnDeadlineWhenNewerMarketEndIsLate() public {
        uint256 r1 = _openME(20, 50, t0 + 300, 60, t0 + 1480);
        _commit(r1, humans[0], _pPerfect(), true);
        _openME(40, 80, t0 + 1500, 60, t0 + 2000);
        _revealAll(r1);
        vm.warp(t0 + 1480); // R1's last legal second
        _post(r1);
        assertTrue(arena.settled(r1));
        assertFalse(arena.isVoid(r1));
        uint256 b = _bal(humans[0]);
        _claimAs(humans[0], r1);
        assertEq(_bal(humans[0]), b + STAKE + 71);
    }

    /// @dev Flat real candles and T = 1: baseline is 100, so nothing can beat it and every claim refunds
    ///      the stake only. Hand-derived (T = 1, bucket width 1):
    ///      human consensus (lower median of perfect and zero) = (0,0,-2),(0,0,0),(0,0,0):
    ///        candle 1: C 10000, R = 10000 - 2*10000/2 = 0, D 10000 -> 80000; candles 2, 3: 100000 each
    ///        -> 280000*100/300000 = 93.
    ///      agent consensus = neg path: C 0, R 0, D 5000 per candle -> 15000 per candle, sum 45000 -> 15.
    ///      Perfect path vs flat: also 15; zero path vs flat: 100.
    function test_flatRealCandlesAndT1() public {
        uint256 id = _open(1, STAKE, 60, t0 + 1480);
        _commit(id, humans[0], _pPerfect(), true);
        _commit(id, humans[1], _pZero(), true);
        _commit(id, agents[0], _pNeg(), true);
        _revealAll(id);
        _toEarliest(id);
        Candle[3] memory flat;
        uint256 supplyAfterCommits = points.totalSupply();
        _postWith(id, flat);
        assertEq(arena.baselineScore(id), 100);
        (uint8 h, uint8 a, bool hp, bool ap) = arena.consensusScores(id);
        assertEq(h, 93);
        assertEq(a, 15);
        assertTrue(hp);
        assertTrue(ap);

        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, humans[0], Kind.Human, 15, 0, STAKE);
        _claimAs(humans[0], id);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, humans[1], Kind.Human, 100, 0, STAKE);
        _claimAs(humans[1], id);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Claimed(id, agents[0], Kind.Agent, 15, 0, STAKE);
        _claimAs(agents[0], id);
        assertEq(_bal(humans[0]), 1000);
        assertEq(_bal(humans[1]), 1000);
        assertEq(_bal(agents[0]), 900);
        assertEq(points.totalSupply(), supplyAfterCommits + 3 * STAKE);
    }

    // ------------------------------------------------------------ accounting (fuzz)

    function _entrant(uint256 i) internal view returns (address) {
        return i % 2 == 0 ? humans[i / 2] : agents[i / 2];
    }

    function _pick(uint256 seed, uint256 i) internal pure returns (uint8) {
        return uint8(uint256(keccak256(abi.encode(seed, i))) % 4);
    }

    function testFuzz_settledRoundAccounting(uint256 nRevRaw, uint256 nUnrevRaw, uint256 seed) public {
        uint256 nRev = bound(nRevRaw, 3, 6);
        uint256 nUnrev = bound(nUnrevRaw, 3, 6);
        uint256 n = nRev + nUnrev;
        uint256 id = _stdOpen();
        uint256 supply0 = points.totalSupply(); // after registration, before the commits
        for (uint256 i = 0; i < n; i++) {
            _commit(id, _entrant(i), _pool(_pick(seed, i)), i < nRev);
        }
        assertEq(points.totalSupply(), supply0 - n * STAKE);
        _revealAll(id);
        _toEarliest(id);
        _post(id);

        uint256 rewards = 0;
        for (uint256 i = 0; i < nRev; i++) {
            address who = _entrant(i);
            uint8 k = _pick(seed, i);
            uint256 b = _bal(who);
            _claimAs(who, id);
            assertEq(_bal(who), b + STAKE + REWARD[k]);
            rewards += REWARD[k];
        }
        for (uint256 i = nRev; i < n; i++) {
            address who = _entrant(i);
            uint256 b = _bal(who);
            uint256 s = points.totalSupply();
            vm.prank(who);
            vm.expectRevert(Arena.NotRevealed.selector);
            arena.claim(id);
            assertEq(_bal(who), b);
            assertEq(points.totalSupply(), s);
        }
        assertEq(points.totalSupply(), supply0 - nUnrev * STAKE + rewards);
    }

    function testFuzz_voidRoundAccounting(uint256 nRevRaw, uint256 nUnrevRaw, uint256 seed, bool callVoid) public {
        uint256 nRev = bound(nRevRaw, 3, 6);
        uint256 nUnrev = bound(nUnrevRaw, 3, 6);
        uint256 n = nRev + nUnrev;
        uint256 id = _stdOpen();
        uint256 supply0 = points.totalSupply();
        for (uint256 i = 0; i < n; i++) {
            _commit(id, _entrant(i), _pool(_pick(seed, i)), i < nRev);
        }
        _revealAll(id);
        vm.warp(t0 + 1481);
        if (callVoid) arena.voidRound(id);
        for (uint256 i = 0; i < n; i++) {
            address who = _entrant(i);
            uint256 b = _bal(who);
            _claimAs(who, id);
            assertEq(_bal(who), b + STAKE); // revealed or not: stake only, never a reward
        }
        assertEq(points.totalSupply(), supply0);
    }

    // ------------------------------------------------------------ gas

    /// @dev Worst case for `postCandles`: both sides present, nothing frozen beforehand, and every
    ///      bucket walk runs the full 200 steps (closes and highs clamp to the top bucket, T = 10).
    function test_gasPostCandlesWorstCase() public {
        uint256 id = _open(10, STAKE, 60, t0 + 1480);
        Candle[3] memory top;
        top[0] = Candle(5000, 5000, 0);
        top[1] = Candle(5000, 5000, 5000);
        top[2] = Candle(5000, 5000, 5000);
        for (uint256 i = 0; i < 3; i++) {
            _commit(id, humans[i], top, true);
            _commit(id, agents[i], top, true);
        }
        _revealAll(id);
        _toEarliest(id);
        vm.prank(keeper);
        uint256 g = gasleft();
        arena.postCandles(id, _real1(), SRC);
        uint256 used = g - gasleft();
        console.log("postCandles worst-case gas", used);
        assertLt(used, 5_000_000);
    }
}
