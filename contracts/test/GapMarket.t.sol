// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Points} from "../src/Points.sol";
import {Registry, Kind} from "../src/Registry.sol";
import {AllowlistGate} from "../src/AllowlistGate.sol";
import {Candle} from "../src/ScoreLib.sol";
import {Arena, RoundParams} from "../src/Arena.sol";
import {GapMarket, Side} from "../src/GapMarket.sol";

/// @dev Known-answer numbers (hand-derived from the pinned score formula; the first three are the
///      approved Task 2 / Task 6 literals, T = 20, bucket width 2):
///        real R1 = close [10,20,30] high [12,22,32] low [-2,8,18]
///          perfect path (= R1) 100, "neg" path 3, all-zero path 29 (the baseline of R1).
///        real RN = the neg path (close [-10,-20,-30] high [0,-10,-20] low [-10,-20,-30])
///          neg path 100, all-zero path 30 (the baseline of RN):
///            candle 1: C 5000, R 7500, D 5000 -> 55000; candle 2: C 0, R 2500, D 5000 -> 20000;
///            candle 3: C 0, R 0, D 5000 -> 15000; (55000+20000+15000)*100/300000 = 30.
///      Every reveal on one side uses the same path, so the frozen median equals that path exactly
///      (all values are even and the bucket width is 2).
abstract contract GapBase is Test {
    event Bet(uint256 indexed id, address indexed who, Side side, uint256 amt);
    event Claimed(uint256 indexed id, address indexed who, uint256 payout);

    Points internal points;
    AllowlistGate internal gate;
    Registry internal registry;
    Arena internal arena;
    GapMarket internal market;

    address internal keeper = address(0x4EE9E4);
    address[12] internal humans;
    address[12] internal agents;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);
    address internal dave = address(0xDA7E);
    address internal erin = address(0xE41);
    address internal frank = address(0xF4A4C);

    uint64 internal t0 = 1_000_000;
    uint256 internal constant STAKE = 10;
    uint256 internal constant START_BAL = 1000;
    bytes32 internal constant SRC = keccak256("source");

    function setUp() public virtual {
        vm.warp(t0);
        points = new Points(address(this));
        gate = new AllowlistGate(address(this));
        registry = new Registry(points, gate, address(this));
        arena = new Arena(points, registry, address(this));
        market = new GapMarket(arena);
        points.setMinter(address(registry), true);
        points.setSpender(address(registry), true);
        points.setMinter(address(arena), true);
        points.setSpender(address(arena), true);
        points.setMinter(address(market), true);
        points.setSpender(address(market), true);
        points.setMinter(address(this), true); // funds the bettors; never calls lockRoles()
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
        address[6] memory b = [alice, bob, carol, dave, erin, frank];
        for (uint256 i = 0; i < 6; i++) {
            points.mint(b[i], START_BAL);
        }
    }

    // ------------------------------------------------------------ paths

    function _real1() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(10, 12, -2);
        p[1] = Candle(20, 22, 8);
        p[2] = Candle(30, 32, 18);
    }

    function _pPerfect() internal pure returns (Candle[3] memory) {
        return _real1();
    }

    function _pNeg() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(-10, 0, -10);
        p[1] = Candle(-20, -10, -20);
        p[2] = Candle(-30, -20, -30);
    }

    function _pZero() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(0, 0, 0);
        p[1] = Candle(0, 0, 0);
        p[2] = Candle(0, 0, 0);
    }

    // ------------------------------------------------------------ rounds

    /// @dev Opens a round with T = 20 and times relative to t0 (all arguments are offsets in seconds).
    function _open(uint64 ce, uint64 re, uint64 me, uint32 candleSec, uint64 deadline) internal returns (uint256 id) {
        RoundParams memory p;
        p.ticker = bytes32("AAPL");
        p.p0 = 190_00;
        p.T = 20;
        p.commitEnd = t0 + ce;
        p.revealEnd = t0 + re;
        p.marketEnd = t0 + me;
        p.candleSec = candleSec;
        p.settleDeadline = t0 + deadline;
        p.entryStake = STAKE;
        vm.prank(keeper);
        id = arena.openRound(p);
    }

    /// @dev commitEnd t0+100, revealEnd t0+200, marketEnd t0+300, candleSec 60: postable from t0+480,
    ///      settleDeadline t0+1480.
    function _openStd() internal returns (uint256) {
        return _open(100, 200, 300, 60, 1480);
    }

    function _commitOne(uint256 id, address who, Candle[3] memory path) internal {
        bytes32 salt = keccak256(abi.encode("salt", id, who));
        bytes32 h = arena.hashPath(path, salt, who);
        vm.prank(who);
        arena.commit(id, h);
    }

    function _revealOne(uint256 id, address who, Candle[3] memory path) internal {
        bytes32 salt = keccak256(abi.encode("salt", id, who));
        arena.reveal(id, who, path, salt);
    }

    function _commitAll(uint256 id, uint256 nH, Candle[3] memory hp, uint256 nA, Candle[3] memory ap) internal {
        for (uint256 i = 0; i < nH; i++) {
            _commitOne(id, humans[i], hp);
        }
        for (uint256 i = 0; i < nA; i++) {
            _commitOne(id, agents[i], ap);
        }
    }

    function _revealAll(uint256 id, uint256 nH, Candle[3] memory hp, uint256 nA, Candle[3] memory ap) internal {
        for (uint256 i = 0; i < nH; i++) {
            _revealOne(id, humans[i], hp);
        }
        for (uint256 i = 0; i < nA; i++) {
            _revealOne(id, agents[i], ap);
        }
    }

    /// @dev Standard round, committed at t0 and revealed at t0+100 (time ends at t0+100).
    function _std(uint256 nH, Candle[3] memory hp, uint256 nA, Candle[3] memory ap) internal returns (uint256 id) {
        id = _openStd();
        _commitAll(id, nH, hp, nA, ap);
        vm.warp(t0 + 100);
        _revealAll(id, nH, hp, nA, ap);
    }

    /// @dev `_std`, then warps to revealEnd (t0+200) and freezes everything: betting is open.
    function _ready(uint256 nH, Candle[3] memory hp, uint256 nA, Candle[3] memory ap) internal returns (uint256 id) {
        id = _std(nH, hp, nA, ap);
        vm.warp(t0 + 200);
        arena.freezeAll(id);
    }

    function _post(uint256 id, Candle[3] memory real) internal {
        vm.prank(keeper);
        arena.postCandles(id, real, SRC);
    }

    /// @dev Warps to t0+480 (marketEnd + 3 * candleSec of the standard round) and posts real R1.
    function _postStd(uint256 id) internal {
        vm.warp(t0 + 480);
        _post(id, _real1());
    }

    function _bet(address who, uint256 id, Side s, uint256 amt) internal {
        vm.prank(who);
        market.bet(id, s, amt);
    }

    function _claimAs(address who, uint256 id) internal {
        vm.prank(who);
        market.claim(id);
    }

    function _bal(address a) internal view returns (uint256) {
        return points.balanceOf(a);
    }

    function _status(uint256 id) internal view returns (uint8) {
        return market.status(id);
    }
}

contract GapMarketTest is GapBase {
    // ------------------------------------------------------------ constructor and constants

    function test_constructorWiring() public view {
        assertEq(address(market.arena()), address(arena));
        assertEq(address(market.points()), address(points));
        assertEq(address(market.points()), address(arena.points()));
        assertEq(market.MAX_BET_PER_ADDRESS(), 200);
        assertEq(market.MIN_REVEALS(), 3);
    }

    // ------------------------------------------------------------ bet window

    function test_betOutsideWindowReverts() public {
        uint256 id = _std(3, _pPerfect(), 3, _pNeg()); // t0+100: reveals done, nothing frozen yet
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, id, Side.Human, 10);
        vm.warp(t0 + 199);
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, id, Side.Human, 10);
        vm.warp(t0 + 200);
        arena.freezeAll(id);
        _bet(alice, id, Side.Human, 10); // sanity: the window is open now
        vm.warp(t0 + 300);
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, id, Side.Human, 10);
        vm.warp(t0 + 301);
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, id, Side.Human, 10);
        vm.warp(t0 + 480);
        _post(id, _real1());
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, id, Side.Human, 10);
        // Only the single in-window bet landed.
        assertEq(market.stakeOf(id, alice, Side.Human), 10);
        assertEq(_bal(alice), 990);
    }

    function test_betWindowBoundariesExact() public {
        uint256 id = _std(3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 199); // revealEnd - 1
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, id, Side.Human, 10);
        vm.warp(t0 + 200); // revealEnd
        arena.freezeAll(id);
        _bet(alice, id, Side.Human, 10);
        vm.warp(t0 + 299); // marketEnd - 1
        _bet(bob, id, Side.Agent, 15);
        vm.warp(t0 + 300); // marketEnd
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(carol, id, Side.Human, 10);
        (uint256 h, uint256 a) = market.pools(id);
        assertEq(h, 10);
        assertEq(a, 15);
    }

    function test_unknownRoundReverts() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg()); // roundCount == 1
        vm.expectRevert(Arena.UnknownRound.selector);
        _bet(alice, 0, Side.Human, 10);
        vm.expectRevert(Arena.UnknownRound.selector);
        _bet(alice, id + 1, Side.Human, 10);
        vm.expectRevert(Arena.UnknownRound.selector);
        market.status(0);
        vm.expectRevert(Arena.UnknownRound.selector);
        market.status(id + 1);
        vm.expectRevert(Arena.UnknownRound.selector);
        _claimAs(alice, 0);
        vm.expectRevert(Arena.UnknownRound.selector);
        _claimAs(alice, id + 1);
    }

    function test_zeroAmountReverts() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        vm.expectRevert(GapMarket.ZeroAmount.selector);
        _bet(alice, id, Side.Human, 0);
        vm.expectRevert(GapMarket.ZeroAmount.selector);
        _bet(alice, id, Side.Agent, 0);
        (uint256 h, uint256 a) = market.pools(id);
        assertEq(h + a, 0);
    }

    function test_insufficientBalanceReverts() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        address broke = address(0xDEAD);
        vm.expectRevert(abi.encodeWithSelector(Points.InsufficientBalance.selector, 0, 5));
        _bet(broke, id, Side.Human, 5);
        // The revert rolled back the stake write.
        assertEq(market.stakeOf(id, broke, Side.Human), 0);
        (uint256 h,) = market.pools(id);
        assertEq(h, 0);
    }

    function test_betDebitsBalanceAndEmitsEvent() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        uint256 supply = points.totalSupply();
        vm.expectEmit(true, true, false, true, address(market));
        emit Bet(id, alice, Side.Agent, 75);
        _bet(alice, id, Side.Agent, 75);
        assertEq(_bal(alice), 925);
        assertEq(points.totalSupply(), supply - 75);
    }

    // ------------------------------------------------------------ check order

    function test_checkOrderWindowThenAmountThenQuorum() public {
        // 2 humans + 3 agents, nothing frozen: quorum fails.
        uint256 id = _std(2, _pPerfect(), 3, _pNeg()); // t0+100
        // window beats amount: zero amount outside the window reports the window.
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, id, Side.Human, 0);
        vm.warp(t0 + 200);
        // amount beats quorum.
        vm.expectRevert(GapMarket.ZeroAmount.selector);
        _bet(alice, id, Side.Human, 0);
        // quorum beats ready (nothing frozen here) and beats the cap (500 > 200).
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, id, Side.Human, 500);
    }

    function test_readyBeatsCap() public {
        uint256 id = _std(3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 200); // not frozen
        vm.expectRevert(GapMarket.ConsensusNotReady.selector);
        _bet(alice, id, Side.Human, 500);
        arena.freezeAll(id);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Human, 500);
    }

    // ------------------------------------------------------------ quorum

    function test_quorumThreeThreeOpens() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        assertEq(_status(id), 0);
        _bet(alice, id, Side.Human, 10);
        _bet(bob, id, Side.Agent, 10);
        (uint256 h, uint256 a) = market.pools(id);
        assertEq(h, 10);
        assertEq(a, 10);
        assertEq(_status(id), 0);
    }

    function test_cancelledWhenSideBelowQuorum() public {
        // 2 humans + 3 agents.
        uint256 id = _ready(2, _pPerfect(), 3, _pNeg());
        assertEq(_status(id), 1);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, id, Side.Human, 10);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, id, Side.Agent, 10);
        assertEq(market.stakeOf(id, alice, Side.Human), 0);
        assertEq(_bal(alice), START_BAL);
    }

    function test_cancelledWhenAgentSideBelowQuorum() public {
        uint256 id = _ready(3, _pPerfect(), 2, _pNeg());
        assertEq(_status(id), 1);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, id, Side.Human, 10);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, id, Side.Agent, 10);
    }

    /// @dev Different counts and different scores per side: a swapped or one-sided quorum read fails.
    function test_quorumReadsTheRightKindPerSide() public {
        // 5 humans (below nothing) + 2 agents -> cancelled by the Agent side.
        uint256 a = _ready(5, _pPerfect(), 2, _pNeg());
        assertEq(_status(a), 1);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, a, Side.Human, 10);
    }

    function test_quorumReadsTheRightKindPerSideReverse() public {
        // 2 humans + 5 agents -> cancelled by the Human side.
        uint256 a = _ready(2, _pNeg(), 5, _pPerfect());
        assertEq(_status(a), 1);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, a, Side.Agent, 10);
    }

    function test_cancelledWhenAgentSideAbsent() public {
        // No agent reveals at all: the Agent consensus is not ready, but quorum is reported first.
        uint256 id = _ready(3, _pPerfect(), 0, _pNeg());
        assertEq(_status(id), 1);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, id, Side.Human, 10);
    }

    function test_cancelledWhenNobodyRevealed() public {
        uint256 id = _ready(0, _pPerfect(), 0, _pNeg());
        assertEq(_status(id), 1);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, id, Side.Human, 10);
        // status must not revert even after the keeper posted candles for a round without reveals.
        _postStd(id);
        assertEq(_status(id), 1);
    }

    function test_quorumGuardStartsAtRevealEnd() public {
        uint256 id = _std(2, _pPerfect(), 3, _pNeg()); // t0+100
        assertEq(_status(id), 0);
        vm.warp(t0 + 199); // revealEnd - 1
        assertEq(_status(id), 0);
        vm.warp(t0 + 200); // revealEnd
        assertEq(_status(id), 1);
    }

    function test_quorumCancelledRoundRefundsNothingAndStaysCancelledAfterPost() public {
        uint256 id = _ready(2, _pPerfect(), 3, _pNeg());
        _postStd(id); // consensus scores exist (human 100, agent 3) but the quorum rule wins
        assertEq(_status(id), 1);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(alice, id);
    }

    // ------------------------------------------------------------ consensus ready

    function test_consensusNotReadyBeforeFreeze() public {
        uint256 id = _std(3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 200);
        vm.expectRevert(GapMarket.ConsensusNotReady.selector);
        _bet(alice, id, Side.Human, 10);
        vm.expectRevert(GapMarket.ConsensusNotReady.selector);
        _bet(alice, id, Side.Agent, 10);
        arena.freezeAll(id); // anyone
        _bet(alice, id, Side.Human, 10);
        _bet(bob, id, Side.Agent, 10);
        assertEq(market.stakeOf(id, alice, Side.Human), 10);
    }

    function test_consensusReadyNeedsBothSides() public {
        uint256 id = _std(3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 200);
        for (uint8 f = 0; f < 9; f++) {
            arena.freezeConsensus(id, Kind.Human, f);
        }
        (, bool humanReady) = arena.consensus(id, Kind.Human);
        (, bool agentReady) = arena.consensus(id, Kind.Agent);
        assertTrue(humanReady);
        assertFalse(agentReady);
        vm.expectRevert(GapMarket.ConsensusNotReady.selector);
        _bet(alice, id, Side.Human, 10);
        vm.expectRevert(GapMarket.ConsensusNotReady.selector);
        _bet(alice, id, Side.Agent, 10);
        // Eight of nine agent fields are not enough.
        for (uint8 f = 0; f < 8; f++) {
            arena.freezeConsensus(id, Kind.Agent, f);
        }
        vm.expectRevert(GapMarket.ConsensusNotReady.selector);
        _bet(alice, id, Side.Human, 10);
        arena.freezeConsensus(id, Kind.Agent, 8);
        _bet(alice, id, Side.Human, 10);
        _bet(alice, id, Side.Agent, 10);
    }

    function test_consensusReadyNeedsBothSidesAgentFirst() public {
        uint256 id = _std(3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 200);
        for (uint8 f = 0; f < 9; f++) {
            arena.freezeConsensus(id, Kind.Agent, f);
        }
        vm.expectRevert(GapMarket.ConsensusNotReady.selector);
        _bet(alice, id, Side.Human, 10);
        vm.expectRevert(GapMarket.ConsensusNotReady.selector);
        _bet(alice, id, Side.Agent, 10);
    }

    // ------------------------------------------------------------ cap (D3)

    function test_capExactlyAllowedAndOneOverReverts() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 200);
        assertEq(market.stakeOf(id, alice, Side.Human), 200);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Human, 1);
        // Another address on its own: 201 reverts, 200 passes.
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(bob, id, Side.Agent, 201);
        _bet(bob, id, Side.Agent, 200);
        (uint256 h, uint256 a) = market.pools(id);
        assertEq(h, 200);
        assertEq(a, 200);
    }

    function test_capCountsBothSides() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 150);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Agent, 51);
        _bet(alice, id, Side.Agent, 50); // 150 + 50 == 200
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Human, 1);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Agent, 1);
        assertEq(market.stakeOf(id, alice, Side.Human), 150);
        assertEq(market.stakeOf(id, alice, Side.Agent), 50);
    }

    function test_capIncrementalBetsAccumulate() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        _bet(alice, id, Side.Human, 99);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Human, 2);
        _bet(alice, id, Side.Human, 1);
        assertEq(market.stakeOf(id, alice, Side.Human), 200);
    }

    function test_hugeAmountRevertsWithCapErrorNotPanic() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Human, type(uint256).max);
        _bet(alice, id, Side.Human, 5);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Agent, type(uint256).max);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, id, Side.Agent, type(uint256).max - 4);
    }

    function test_capIsPerRound() public {
        // Round 1 and round 2 are both open at t0+200; alice fills the cap in each.
        uint256 r1 = _open(100, 200, 300, 60, 1480);
        uint256 r2 = _open(100, 200, 300, 60, 1480);
        _commitAll(r1, 3, _pPerfect(), 3, _pNeg());
        _commitAll(r2, 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 100);
        _revealAll(r1, 3, _pPerfect(), 3, _pNeg());
        _revealAll(r2, 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 200);
        arena.freezeAll(r1);
        arena.freezeAll(r2);
        _bet(alice, r1, Side.Human, 200);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, r1, Side.Agent, 1);
        _bet(alice, r2, Side.Agent, 200);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, r2, Side.Human, 1);
        assertEq(market.stakeOf(r1, alice, Side.Human), 200);
        assertEq(market.stakeOf(r1, alice, Side.Agent), 0);
        assertEq(market.stakeOf(r2, alice, Side.Human), 0);
        assertEq(market.stakeOf(r2, alice, Side.Agent), 200);
        assertEq(_bal(alice), 600);
    }

    /// @dev The cap's Human and Agent terms must both be keyed on the bet's own round. Round 2 is the
    ///      newest round (roundCount), round 1 the oldest: stakes in one round never count in the other.
    function _twoOpenRounds() internal returns (uint256 r1, uint256 r2) {
        r1 = _open(100, 200, 300, 60, 1480);
        r2 = _open(100, 200, 300, 60, 1480);
        _commitAll(r1, 3, _pPerfect(), 3, _pNeg());
        _commitAll(r2, 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 100);
        _revealAll(r1, 3, _pPerfect(), 3, _pNeg());
        _revealAll(r2, 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 200);
        arena.freezeAll(r1);
        arena.freezeAll(r2);
    }

    function test_capAgentTermKeyedOnOwnRoundNewestHoldsAgent() public {
        (uint256 r1, uint256 r2) = _twoOpenRounds();
        _bet(alice, r2, Side.Agent, 200); // newest round: alice at the cap on Agent
        _bet(alice, r1, Side.Human, 200); // older round starts at 0
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, r1, Side.Human, 1);
        assertEq(market.stakeOf(r1, alice, Side.Human), 200);
        assertEq(market.stakeOf(r2, alice, Side.Agent), 200);
    }

    function test_capAgentTermKeyedOnOwnRoundOlderHoldsAgent() public {
        (uint256 r1, uint256 r2) = _twoOpenRounds();
        _bet(alice, r1, Side.Agent, 200); // older round: alice at the cap on Agent
        _bet(alice, r2, Side.Human, 200); // newest round starts at 0
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, r2, Side.Agent, 1);
        assertEq(market.stakeOf(r2, alice, Side.Human), 200);
        assertEq(market.stakeOf(r1, alice, Side.Agent), 200);
    }

    function test_capHumanTermKeyedOnOwnRoundNewestHoldsHuman() public {
        (uint256 r1, uint256 r2) = _twoOpenRounds();
        _bet(alice, r2, Side.Human, 200);
        _bet(alice, r1, Side.Agent, 200);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, r1, Side.Agent, 1);
        assertEq(market.stakeOf(r1, alice, Side.Agent), 200);
    }

    function test_capHumanTermKeyedOnOwnRoundOlderHoldsHuman() public {
        (uint256 r1, uint256 r2) = _twoOpenRounds();
        _bet(alice, r1, Side.Human, 200);
        _bet(alice, r2, Side.Agent, 200);
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, r2, Side.Human, 1);
        assertEq(market.stakeOf(r2, alice, Side.Agent), 200);
    }

    // ------------------------------------------------------------ one-sided pool

    function test_oneSidedPoolRefunds() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        uint256 supply = points.totalSupply();
        _bet(alice, id, Side.Human, 100);
        vm.warp(t0 + 299);
        assertEq(_status(id), 0); // still open: the other side may yet bet
        vm.expectRevert(GapMarket.NotClaimable.selector);
        _claimAs(alice, id);
        vm.warp(t0 + 300);
        assertEq(_status(id), 1);
        _claimAs(alice, id);
        assertEq(_bal(alice), START_BAL);
        assertEq(points.totalSupply(), supply);
        assertTrue(market.isClaimed(id, alice));
    }

    function test_oneSidedAgentPoolRefunds() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Agent, 40);
        _bet(bob, id, Side.Agent, 25);
        vm.warp(t0 + 300);
        assertEq(_status(id), 1);
        _claimAs(alice, id);
        _claimAs(bob, id);
        assertEq(_bal(alice), START_BAL);
        assertEq(_bal(bob), START_BAL);
    }

    function test_emptyMarketIsCancelled() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        assertEq(_status(id), 0);
        vm.warp(t0 + 300);
        assertEq(_status(id), 1);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(alice, id);
    }

    function test_statusOneAfterOneSidedStaysOneAfterPost() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100); // human wins the real outcome, but nobody bet against
        vm.warp(t0 + 300);
        assertEq(_status(id), 1);
        _claimAs(alice, id);
        _postStd(id);
        assertTrue(arena.settled(id));
        assertEq(_status(id), 1);
        vm.expectRevert(GapMarket.AlreadyClaimed.selector);
        _claimAs(alice, id);
        assertEq(_bal(alice), START_BAL);
    }

    // ------------------------------------------------------------ resolved: Human wins

    function test_humanWinPaysProRata() public {
        // Humans 3 x perfect (score 100), agents 3 x neg (score 3): Human wins.
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        uint256 supply = points.totalSupply();
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        _postStd(id);
        (uint8 hs, uint8 as_, bool hp, bool ap) = arena.consensusScores(id);
        assertEq(hs, 100);
        assertEq(as_, 3);
        assertTrue(hp);
        assertTrue(ap);
        assertEq(_status(id), 2);
        _claimAs(alice, id);
        assertEq(_bal(alice), 1050); // 1000 - 100 + exactly 150
        assertEq(_bal(bob), 950);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(bob, id);
        assertEq(points.totalSupply(), supply); // 150 burned at bet time, 150 minted at claim
    }

    function test_humanWinDifferentCountsPerSide() public {
        // 4 humans (perfect, 100) and 3 agents (neg, 3): the counts differ per side.
        uint256 id = _ready(4, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 60);
        _bet(bob, id, Side.Agent, 40);
        _postStd(id);
        assertEq(_status(id), 2);
        _claimAs(alice, id);
        assertEq(_bal(alice), 1040); // 60 * 100 / 60 = 100 payout: 1000 - 60 + 100
    }

    function test_agentWinPaysProRataWithFloor() public {
        // Humans 3 x neg (score 3), agents 4 x perfect (score 100): Agent wins.
        uint256 id = _ready(3, _pNeg(), 4, _pPerfect());
        uint256 supply = points.totalSupply();
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 30);
        _bet(carol, id, Side.Agent, 21);
        _postStd(id);
        (uint8 hs, uint8 as_,,) = arena.consensusScores(id);
        assertEq(hs, 3);
        assertEq(as_, 100);
        assertEq(_status(id), 2);
        // pool 151, winner pool 51: bob 30*151/51 = 88 (88.82), carol 21*151/51 = 62 (62.18).
        _claimAs(bob, id);
        _claimAs(carol, id);
        assertEq(_bal(bob), 1058); // 1000 - 30 + 88
        assertEq(_bal(carol), 1041); // 1000 - 21 + 62
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(alice, id);
        assertEq(_bal(alice), 900);
        assertEq(points.totalSupply(), supply - 1); // one point of rounding dust stays burned
    }

    function test_dustStaysBurned() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg()); // Human wins
        uint256 supply = points.totalSupply();
        _bet(alice, id, Side.Human, 1);
        _bet(bob, id, Side.Human, 1);
        _bet(carol, id, Side.Agent, 1);
        _postStd(id);
        assertEq(_status(id), 2);
        _claimAs(alice, id); // 1 * 3 / 2 = 1
        _claimAs(bob, id); // 1 * 3 / 2 = 1
        assertEq(_bal(alice), START_BAL);
        assertEq(_bal(bob), START_BAL);
        assertEq(_bal(carol), START_BAL - 1);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(carol, id);
        assertEq(points.totalSupply(), supply - 1);
    }

    function test_bothSideBettorIsPaidOnlyTheWinningShare() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg()); // Human wins
        uint256 supply = points.totalSupply();
        _bet(alice, id, Side.Human, 60);
        _bet(alice, id, Side.Agent, 40);
        _bet(bob, id, Side.Agent, 50);
        _bet(carol, id, Side.Human, 20);
        // pools: human 80, agent 90, total 170.
        _postStd(id);
        assertEq(_status(id), 2);
        _claimAs(alice, id); // 60 * 170 / 80 = 127 (127.5)
        _claimAs(carol, id); // 20 * 170 / 80 = 42 (42.5)
        assertEq(_bal(alice), 1027); // 1000 - 100 + 127
        assertEq(_bal(carol), 1022); // 1000 - 20 + 42
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(bob, id);
        assertEq(points.totalSupply(), supply - 1); // 170 bet, 169 paid
    }

    function test_bothSideBettorOnAgentWinIsPaidTheAgentShareOnly() public {
        // Alice bets on both sides and the Agent side wins: she is paid for her Agent stake only.
        uint256 id = _ready(3, _pNeg(), 3, _pPerfect()); // Agent wins
        _bet(alice, id, Side.Human, 70);
        _bet(alice, id, Side.Agent, 30);
        _bet(bob, id, Side.Agent, 10);
        // pools: human 70, agent 40, total 110. alice 30*110/40 = 82 (82.5).
        _postStd(id);
        assertEq(_status(id), 2);
        _claimAs(alice, id);
        assertEq(_bal(alice), 982); // 1000 - 100 + 82
    }

    // ------------------------------------------------------------ tie

    function test_tieRefunds() public {
        // Both sides use the perfect path: equal scores (100, 100).
        uint256 id = _ready(3, _pPerfect(), 4, _pPerfect());
        uint256 supply = points.totalSupply();
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        _bet(carol, id, Side.Agent, 7);
        _postStd(id);
        (uint8 hs, uint8 as_,,) = arena.consensusScores(id);
        assertEq(hs, 100);
        assertEq(as_, 100);
        assertEq(_status(id), 3);
        _claimAs(alice, id);
        _claimAs(bob, id);
        _claimAs(carol, id);
        assertEq(_bal(alice), START_BAL);
        assertEq(_bal(bob), START_BAL);
        assertEq(_bal(carol), START_BAL);
        assertEq(points.totalSupply(), supply);
    }

    function test_tieRefundsBothSidesOfABothSideBettor() public {
        uint256 id = _ready(3, _pNeg(), 3, _pNeg());
        _bet(alice, id, Side.Human, 60);
        _bet(alice, id, Side.Agent, 40);
        _bet(bob, id, Side.Agent, 5);
        _postStd(id); // both sides score 3
        assertEq(_status(id), 3);
        _claimAs(alice, id);
        assertEq(_bal(alice), START_BAL);
        _claimAs(bob, id);
        assertEq(_bal(bob), START_BAL);
    }

    // ------------------------------------------------------------ void

    function test_voidRoundRefunds() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        uint256 supply = points.totalSupply();
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        vm.warp(t0 + 1480); // the deadline itself: posting is still allowed, so not void yet
        assertEq(_status(id), 0);
        vm.expectRevert(GapMarket.NotClaimable.selector);
        _claimAs(alice, id);
        vm.warp(t0 + 1481);
        // Nobody posted and nobody called voidRound: the derived rule alone makes refunds work.
        assertTrue(arena.isVoid(id));
        assertFalse(arena.settled(id));
        assertEq(_status(id), 1);
        _claimAs(alice, id);
        _claimAs(bob, id);
        assertEq(_bal(alice), START_BAL);
        assertEq(_bal(bob), START_BAL);
        assertEq(points.totalSupply(), supply);
        vm.expectRevert(GapMarket.AlreadyClaimed.selector);
        _claimAs(alice, id);
    }

    function test_voidRoundStaysVoidAfterVoidRoundCall() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        vm.warp(t0 + 1481);
        arena.voidRound(id);
        assertEq(_status(id), 1);
        _claimAs(bob, id);
        assertEq(_bal(bob), START_BAL);
    }

    function test_lateButInTimePostResolvesInsteadOfVoid() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        vm.warp(t0 + 1480); // settleDeadline: the last second a post is accepted
        _post(id, _real1());
        vm.warp(t0 + 1481);
        assertFalse(arena.isVoid(id));
        assertEq(_status(id), 2);
        _claimAs(alice, id);
        assertEq(_bal(alice), 1050);
    }

    function test_voidWithOneSidedPoolIsStillCancelled() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        vm.warp(t0 + 1481);
        assertEq(_status(id), 1);
        _claimAs(alice, id);
        assertEq(_bal(alice), START_BAL);
    }

    // ------------------------------------------------------------ claim guards

    function test_claimBeforeResolutionReverts() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        vm.expectRevert(GapMarket.NotClaimable.selector);
        _claimAs(alice, id); // t0+200
        vm.warp(t0 + 300);
        assertEq(_status(id), 0);
        vm.expectRevert(GapMarket.NotClaimable.selector);
        _claimAs(alice, id); // betting closed, nothing posted
        vm.warp(t0 + 479);
        assertEq(_status(id), 0);
        vm.expectRevert(GapMarket.NotClaimable.selector);
        _claimAs(bob, id);
        // A never-bet address also sees NotClaimable first.
        vm.expectRevert(GapMarket.NotClaimable.selector);
        _claimAs(dave, id);
        assertFalse(market.isClaimed(id, alice));
    }

    function test_claimTwiceReverts() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        _postStd(id);
        _claimAs(alice, id);
        assertEq(_bal(alice), 1050);
        vm.expectRevert(GapMarket.AlreadyClaimed.selector);
        _claimAs(alice, id);
        assertEq(_bal(alice), 1050);
        // The loser never claimed, so a second call keeps reporting NothingToClaim, not AlreadyClaimed.
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(bob, id);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(bob, id);
    }

    function test_neverBetAddressHasNothingToClaim() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        _postStd(id);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(dave, id);
        assertFalse(market.isClaimed(id, dave));
    }

    function test_claimGuardsOnRefundPaths() public {
        // One-sided round: never-bet address reverts NothingToClaim.
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Agent, 5);
        vm.warp(t0 + 300);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(dave, id);
        _claimAs(alice, id);
        vm.expectRevert(GapMarket.AlreadyClaimed.selector);
        _claimAs(alice, id);
    }

    function test_claimEmitsEventAndSetsFlag() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        _postStd(id);
        assertFalse(market.isClaimed(id, alice));
        vm.expectEmit(true, true, false, true, address(market));
        emit Claimed(id, alice, 150);
        _claimAs(alice, id);
        assertTrue(market.isClaimed(id, alice));
        assertFalse(market.isClaimed(id, bob));
    }

    // ------------------------------------------------------------ status

    function test_statusIsStableOnceNonZero() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 100);
        _bet(bob, id, Side.Agent, 50);
        assertEq(_status(id), 0);
        _postStd(id);
        assertEq(_status(id), 2);
        _claimAs(alice, id);
        assertEq(_status(id), 2);
        vm.warp(t0 + 1480);
        assertEq(_status(id), 2);
        vm.warp(t0 + 5000); // far beyond the settle deadline: a posted round is never void
        assertEq(_status(id), 2);
        assertFalse(arena.isVoid(id));
    }

    function test_statusOpenWhileBothPoolsAndNotSettled() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Human, 10);
        _bet(bob, id, Side.Agent, 10);
        assertEq(_status(id), 0);
        vm.warp(t0 + 300);
        assertEq(_status(id), 0); // not settled: scores must not be read (they would revert)
        vm.warp(t0 + 479);
        assertEq(_status(id), 0);
    }

    function test_statusNeverRevertsBeforeAnyActivity() public {
        uint256 id = _openStd();
        assertEq(_status(id), 0); // nobody committed
        vm.warp(t0 + 99);
        assertEq(_status(id), 0);
        vm.warp(t0 + 200);
        assertEq(_status(id), 1); // no reveals: below quorum from revealEnd
        vm.warp(t0 + 1481);
        assertEq(_status(id), 1); // void
    }

    function test_oneSidedPoolReadsOpenBeforeMarketEndAndCancelledAtMarketEnd() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        _bet(alice, id, Side.Agent, 10);
        vm.warp(t0 + 299);
        assertEq(_status(id), 0);
        vm.warp(t0 + 300);
        assertEq(_status(id), 1);
    }

    // ------------------------------------------------------------ getters

    function test_gettersTrackPerSidePerAddressStakes() public {
        uint256 id = _ready(3, _pPerfect(), 3, _pNeg());
        (uint256 h0, uint256 a0) = market.pools(id);
        assertEq(h0, 0);
        assertEq(a0, 0);
        _bet(alice, id, Side.Human, 30);
        _bet(alice, id, Side.Agent, 20);
        _bet(alice, id, Side.Human, 5);
        _bet(bob, id, Side.Agent, 7);
        (uint256 h, uint256 a) = market.pools(id);
        assertEq(h, 35);
        assertEq(a, 27);
        assertEq(market.stakeOf(id, alice, Side.Human), 35);
        assertEq(market.stakeOf(id, alice, Side.Agent), 20);
        assertEq(market.stakeOf(id, bob, Side.Human), 0);
        assertEq(market.stakeOf(id, bob, Side.Agent), 7);
        assertEq(market.stakeOf(id, carol, Side.Human), 0);
        assertFalse(market.isClaimed(id, alice));
    }

    // ------------------------------------------------------------ cross-round

    /// @dev Three live rounds that differ in windows, counts, quorum outcome, real candles, pools and
    ///      result. The older round (1) settles AFTER the newer round (2), and round 2 is frozen first.
    ///        R1: ce 100, re 200, me 400, candleSec 60 (post 580), deadline 1600; humans 4 x perfect,
    ///            agents 3 x neg; real R1 -> scores (100, 3), baseline 29; Human wins.
    ///        R2: ce 50, re 150, me 300, candleSec 30 (post 390), deadline 800; humans 3 x zero,
    ///            agents 5 x neg; real RN -> scores (30, 100), baseline 30; Agent wins.
    ///        R3: ce 80, re 180, me 500, candleSec 10 (post 530), deadline 900; humans 2, agents 3:
    ///            cancelled by quorum.
    function test_crossRoundOlderRoundSettlesLast() public {
        uint256 r1 = _open(100, 200, 400, 60, 1600);
        uint256 r2 = _open(50, 150, 300, 30, 800);
        uint256 r3 = _open(80, 180, 500, 10, 900);
        assertEq(r1, 1);
        assertEq(r2, 2);
        assertEq(r3, 3);
        _commitAll(r1, 4, _pPerfect(), 3, _pNeg());
        _commitAll(r2, 3, _pZero(), 5, _pNeg());
        _commitAll(r3, 2, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 100);
        _revealAll(r1, 4, _pPerfect(), 3, _pNeg());
        _revealAll(r2, 3, _pZero(), 5, _pNeg());
        _revealAll(r3, 2, _pPerfect(), 3, _pNeg());

        // Windows and reveal counts differ per round.
        assertEq(arena.getRound(r1).revealEnd, t0 + 200);
        assertEq(arena.getRound(r1).marketEnd, t0 + 400);
        assertEq(arena.getRound(r2).revealEnd, t0 + 150);
        assertEq(arena.getRound(r2).marketEnd, t0 + 300);
        assertEq(arena.getRound(r3).revealEnd, t0 + 180);
        assertEq(arena.getRound(r3).marketEnd, t0 + 500);
        assertEq(arena.revealCount(r1, Kind.Human), 4);
        assertEq(arena.revealCount(r1, Kind.Agent), 3);
        assertEq(arena.revealCount(r2, Kind.Human), 3);
        assertEq(arena.revealCount(r2, Kind.Agent), 5);
        assertEq(arena.revealCount(r3, Kind.Human), 2);
        assertEq(arena.revealCount(r3, Kind.Agent), 3);

        // t0+150: round 2 is frozen first (the newer round); rounds 1 and 3 are not even freezable.
        vm.warp(t0 + 150);
        arena.freezeAll(r2);
        _assertReady(r1, false, false);
        _assertReady(r2, true, true);
        _assertReady(r3, false, false);
        // Round 1 and 3 windows are still closed, round 2 is open.
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, r1, Side.Human, 10);
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, r3, Side.Human, 10);
        _bet(alice, r2, Side.Human, 200); // alice fills her whole cap in round 2
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, r2, Side.Agent, 1);
        _bet(bob, r2, Side.Agent, 70);
        _bet(carol, r2, Side.Agent, 30);

        // t0+180: round 3 is frozen and cancelled by quorum.
        vm.warp(t0 + 180);
        arena.freezeAll(r3);
        _assertReady(r3, true, true);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, r3, Side.Human, 10);
        assertEq(_status(r3), 1);
        assertEq(_status(r2), 0);
        assertEq(_status(r1), 0);

        // t0+200: round 1 (the OLDER round) is frozen last.
        vm.warp(t0 + 200);
        arena.freezeAll(r1);
        _assertReady(r1, true, true);
        _bet(alice, r1, Side.Human, 140); // alice is at the cap in round 2, but round 1 starts at 0
        vm.expectRevert(GapMarket.BetCapExceeded.selector);
        _bet(alice, r1, Side.Human, 61);
        _bet(alice, r1, Side.Human, 60);
        _bet(carol, r1, Side.Human, 31);

        // t0+300: round 2's window closed, round 1's is open.
        vm.warp(t0 + 300);
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(frank, r2, Side.Human, 5);
        _bet(bob, r1, Side.Agent, 60);
        assertEq(_status(r2), 0); // both pools, not settled yet
        assertEq(_status(r1), 0);

        // t0+390: round 2 is posted while the older round 1 can still take bets.
        vm.warp(t0 + 390);
        _post(r2, _pNeg()); // real RN
        assertTrue(arena.settled(r2));
        assertFalse(arena.settled(r1));
        assertFalse(arena.isVoid(r1));
        assertEq(_status(r2), 2);
        assertEq(_status(r1), 0);
        {
            (uint8 hs, uint8 as_,,) = arena.consensusScores(r2);
            assertEq(hs, 30);
            assertEq(as_, 100);
            assertEq(arena.baselineScore(r2), 30);
        }
        vm.expectRevert(Arena.NotSettled.selector);
        arena.consensusScores(r1);
        vm.warp(t0 + 399);
        _bet(erin, r1, Side.Agent, 90); // still inside round 1's window
        vm.warp(t0 + 400);
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(frank, r1, Side.Human, 5);

        // Pools and stakes are per round.
        (uint256 h1, uint256 a1) = market.pools(r1);
        (uint256 h2, uint256 a2) = market.pools(r2);
        (uint256 h3, uint256 a3) = market.pools(r3);
        assertEq(h1, 231);
        assertEq(a1, 150);
        assertEq(h2, 200);
        assertEq(a2, 100);
        assertEq(h3, 0);
        assertEq(a3, 0);
        assertEq(market.stakeOf(r1, alice, Side.Human), 200);
        assertEq(market.stakeOf(r2, alice, Side.Human), 200);
        assertEq(market.stakeOf(r1, carol, Side.Human), 31);
        assertEq(market.stakeOf(r2, carol, Side.Human), 0);
        assertEq(market.stakeOf(r1, carol, Side.Agent), 0);
        assertEq(market.stakeOf(r2, carol, Side.Agent), 30);

        // Round 2 pays from round 2's pools only: pool 300, winner pool 100.
        vm.expectRevert(GapMarket.NotClaimable.selector);
        _claimAs(carol, r1); // round 1 is not resolved yet
        _claimAs(bob, r2); // 70 * 300 / 100 = 210
        _claimAs(carol, r2); // 30 * 300 / 100 = 90
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(alice, r2); // alice bet on the losing Human side
        assertEq(_bal(bob), 1000 - 70 - 60 + 210);
        assertEq(_bal(carol), 1000 - 30 - 31 + 90);
        assertTrue(market.isClaimed(r2, bob));
        assertTrue(market.isClaimed(r2, carol));
        assertFalse(market.isClaimed(r1, bob));
        assertFalse(market.isClaimed(r1, carol));

        // t0+580: round 1 settles last.
        vm.warp(t0 + 580);
        _post(r1, _real1());
        assertEq(_status(r1), 2);
        assertEq(_status(r2), 2);
        assertEq(_status(r3), 1);
        {
            (uint8 hs, uint8 as_,,) = arena.consensusScores(r1);
            assertEq(hs, 100);
            assertEq(as_, 3);
            assertEq(arena.baselineScore(r1), 29);
        }
        // Round 1: pool 381, winner (Human) pool 231.
        _claimAs(alice, r1); // 200 * 381 / 231 = 329 (329.87)
        _claimAs(carol, r1); // 31 * 381 / 231 = 51 (51.13)
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(erin, r1);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(bob, r1); // bob claimed round 2 but lost round 1
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(dave, r1);
        vm.expectRevert(GapMarket.AlreadyClaimed.selector);
        _claimAs(carol, r1);
        assertEq(_bal(alice), 1000 - 200 - 200 + 329);
        assertEq(_bal(carol), 1000 - 30 - 31 + 90 + 51);
        assertEq(_bal(erin), 1000 - 90);
        assertTrue(market.isClaimed(r1, carol));

        // Round 3 stays cancelled and has no stakes to refund; it turns void at its own deadline.
        vm.warp(t0 + 950);
        assertEq(_status(r3), 1);
        assertTrue(arena.isVoid(r3));
        assertFalse(arena.isVoid(r1));
        assertFalse(arena.isVoid(r2));
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(alice, r3);
    }

    /// @dev Round 1 (older) is void (never posted), round 2 settles, round 3 is still open.
    function test_crossRoundVoidOlderWhileNewerSettles() public {
        uint256 r1 = _open(100, 200, 300, 60, 700); // postable 480..700
        uint256 r2 = _open(50, 150, 250, 30, 1000); // postable 340..1000
        uint256 r3 = _open(90, 190, 320, 60, 1500); // postable 500..1500
        _commitAll(r1, 3, _pPerfect(), 3, _pNeg());
        _commitAll(r2, 3, _pNeg(), 4, _pPerfect());
        _commitAll(r3, 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 100);
        _revealAll(r1, 3, _pPerfect(), 3, _pNeg());
        _revealAll(r2, 3, _pNeg(), 4, _pPerfect());
        _revealAll(r3, 3, _pPerfect(), 3, _pNeg());

        vm.warp(t0 + 150);
        arena.freezeAll(r2);
        _bet(alice, r2, Side.Agent, 50);
        _bet(carol, r2, Side.Human, 25);
        vm.warp(t0 + 200);
        arena.freezeAll(r1);
        arena.freezeAll(r3);
        _bet(alice, r1, Side.Human, 100);
        _bet(bob, r1, Side.Agent, 60);
        _bet(dave, r3, Side.Human, 40);
        _bet(erin, r3, Side.Agent, 20);

        vm.warp(t0 + 340);
        _post(r2, _real1()); // Agent perfect (100) vs Human neg (3): Agent wins round 2
        vm.warp(t0 + 701);
        // Round 1 is past its deadline unposted: void, and the post window is closed.
        vm.prank(keeper);
        vm.expectRevert(Arena.PostWindowClosed.selector);
        arena.postCandles(r1, _real1(), SRC);
        assertTrue(arena.isVoid(r1));
        assertFalse(arena.isVoid(r2));
        assertFalse(arena.isVoid(r3));
        assertEq(_status(r1), 1);
        assertEq(_status(r2), 2);
        assertEq(_status(r3), 0);
        vm.expectRevert(GapMarket.NotClaimable.selector);
        _claimAs(dave, r3);

        // Round 1 refunds the stakes; round 2 pays from round 2's pools: pool 75, winner pool 50.
        _claimAs(alice, r1);
        _claimAs(bob, r1);
        _claimAs(alice, r2); // 50 * 75 / 50 = 75
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(carol, r2);
        vm.expectRevert(GapMarket.AlreadyClaimed.selector);
        _claimAs(alice, r1);
        assertEq(_bal(alice), 1000 - 100 - 50 + 100 + 75);
        assertEq(_bal(bob), START_BAL);
        assertEq(_bal(carol), START_BAL - 25);
        assertTrue(market.isClaimed(r1, alice));
        assertTrue(market.isClaimed(r2, alice));
        assertFalse(market.isClaimed(r3, alice));
        (uint256 h1, uint256 a1) = market.pools(r1);
        (uint256 h2, uint256 a2) = market.pools(r2);
        assertEq(h1, 100);
        assertEq(a1, 60);
        assertEq(h2, 25);
        assertEq(a2, 50);
    }

    /// @dev Four live rounds: R1 (3H, 3A) ends one-sided, R2 (2H, 3A) and R3 (3H, 2A) fail the quorum on
    ///      different sides, R4 (3H, 3A) is the newest round with later windows (revealEnd 350, marketEnd 600).
    ///      Status, quorum and window reads must use each round's own data, not the newest or the first.
    function test_crossRoundQuorumAndOneSidedPerRound() public {
        uint256 r1 = _open(100, 200, 300, 60, 1480);
        uint256 r2 = _open(100, 200, 300, 60, 1480);
        uint256 r3 = _open(100, 200, 300, 60, 1480);
        uint256 r4 = _open(100, 350, 600, 60, 1500);
        _commitAll(r1, 3, _pPerfect(), 3, _pNeg());
        _commitAll(r2, 2, _pPerfect(), 3, _pNeg());
        _commitAll(r3, 3, _pPerfect(), 2, _pNeg());
        _commitAll(r4, 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 100);
        _revealAll(r1, 3, _pPerfect(), 3, _pNeg());
        _revealAll(r2, 2, _pPerfect(), 3, _pNeg());
        _revealAll(r3, 3, _pPerfect(), 2, _pNeg());
        _revealAll(r4, 3, _pPerfect(), 3, _pNeg());

        vm.warp(t0 + 200);
        arena.freezeAll(r1);
        arena.freezeAll(r2);
        arena.freezeAll(r3);
        assertEq(_status(r1), 0);
        assertEq(_status(r2), 1); // Human side below quorum from its own revealEnd
        assertEq(_status(r3), 1); // Agent side below quorum from its own revealEnd
        assertEq(_status(r4), 0); // revealEnd 350 not reached
        _bet(alice, r1, Side.Human, 10);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, r2, Side.Agent, 10);
        vm.expectRevert(GapMarket.MarketCancelled.selector);
        _bet(alice, r3, Side.Human, 10);
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(alice, r4, Side.Human, 10);

        // t0+300: R1..R3 closed their windows; the newest round is still before its own revealEnd.
        vm.warp(t0 + 300);
        assertEq(_status(r1), 1); // one-sided pool read at R1's own marketEnd
        assertEq(_status(r2), 1);
        assertEq(_status(r3), 1);
        assertEq(_status(r4), 0);
        _claimAs(alice, r1);
        assertEq(_bal(alice), START_BAL);
        vm.expectRevert(GapMarket.NothingToClaim.selector);
        _claimAs(alice, r2);

        // t0+350: R4 opens while R1..R3 are long closed.
        vm.warp(t0 + 350);
        arena.freezeAll(r4);
        _bet(alice, r4, Side.Human, 10);
        _bet(bob, r4, Side.Agent, 10);
        vm.expectRevert(GapMarket.OutsideBetWindow.selector);
        _bet(bob, r1, Side.Agent, 10);
        (uint256 h1, uint256 a1) = market.pools(r1);
        (uint256 h4, uint256 a4) = market.pools(r4);
        assertEq(h1, 10);
        assertEq(a1, 0);
        assertEq(h4, 10);
        assertEq(a4, 10);
        // R4 has both pools: its status stays open at its own marketEnd (t0+600), while R1's one-sided pool
        // (read from R1's own id) makes R1 cancelled.
        vm.warp(t0 + 600);
        assertEq(_status(r4), 0);
        assertEq(_status(r1), 1);
    }

    function _assertReady(uint256 id, bool humanReady, bool agentReady) internal view {
        (, bool hr) = arena.consensus(id, Kind.Human);
        (, bool ar) = arena.consensus(id, Kind.Agent);
        assertEq(hr, humanReady);
        assertEq(ar, agentReady);
    }
}

/// @dev Property tests. `setUp` pre-builds four frozen rounds, so each fuzz run only pays for bets,
///      one post and the claims.
contract GapMarketFuzzTest is GapBase {
    uint256[4] internal ids; // 0 Human wins, 1 Agent wins, 2 tie, 3 Human-win paths (one-sided bets)
    address[4] internal bettors;

    function setUp() public override {
        super.setUp();
        for (uint256 k = 0; k < 4; k++) {
            ids[k] = _openStd();
            bettors[k] = address(uint160(0xB000 + k));
            points.mint(bettors[k], START_BAL);
        }
        _commitAll(ids[0], 3, _pPerfect(), 3, _pNeg());
        _commitAll(ids[1], 3, _pNeg(), 3, _pPerfect());
        _commitAll(ids[2], 3, _pPerfect(), 3, _pPerfect());
        _commitAll(ids[3], 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 100);
        _revealAll(ids[0], 3, _pPerfect(), 3, _pNeg());
        _revealAll(ids[1], 3, _pNeg(), 3, _pPerfect());
        _revealAll(ids[2], 3, _pPerfect(), 3, _pPerfect());
        _revealAll(ids[3], 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 200);
        for (uint256 k = 0; k < 4; k++) {
            arena.freezeAll(ids[k]);
        }
    }

    struct Run {
        uint256 id;
        uint256 supplyBefore;
        uint256 totalBet;
        uint256 hp; // human pool
        uint256 ap; // agent pool
        uint256 winnerSide;
        uint8 expected;
        uint256 paid;
        uint256 winners;
        uint256[2][4] g; // ghost stakes per bettor and side
    }

    /// @dev Fuzzes bettors, sides, amounts (within the cap) and the outcome (Human win, Agent win, tie,
    ///      one-sided cancel); everybody claims. Asserts: resolved pool - paid < number of winning
    ///      claimants (floor loses under 1 per claimant), cancelled or tie paid == total bet, always
    ///      paid <= pool, and each payout is the floor of its pro-rata share.
    function testInvariant_totalClaimsNeverExceedPool(uint8 outcomeRaw, uint8 countRaw, uint256[8] memory raw) public {
        uint256 outcome = bound(outcomeRaw, 0, 3);
        Run memory r;
        r.id = ids[outcome];
        r.supplyBefore = points.totalSupply();
        _placeBets(r, outcome, bound(countRaw, 1, 8), raw);

        (uint256 ph, uint256 pa) = market.pools(r.id);
        assertEq(ph, r.hp);
        assertEq(pa, r.ap);
        assertEq(r.totalBet, r.hp + r.ap);
        assertEq(points.totalSupply(), r.supplyBefore - r.totalBet);

        _postStd(r.id);
        r.winnerSide = outcome == 1 ? 1 : 0;
        if (r.hp == 0 || r.ap == 0) r.expected = 1;
        else if (outcome == 2) r.expected = 3;
        else r.expected = 2;
        assertEq(_status(r.id), r.expected);

        for (uint256 w = 0; w < 4; w++) {
            _claimOne(r, w);
        }
        assertLe(r.paid, r.hp + r.ap);
        if (r.expected == 2) {
            assertLt(r.hp + r.ap - r.paid, r.winners); // floor loses < 1 per winning claimant
        } else {
            assertEq(r.paid, r.hp + r.ap); // cancelled or tie: every point comes back
        }
        assertEq(points.totalSupply(), r.supplyBefore - r.totalBet + r.paid);
    }

    function _placeBets(Run memory r, uint256 outcome, uint256 count, uint256[8] memory raw) internal {
        for (uint256 i = 0; i < count; i++) {
            uint256 who = (raw[i] >> 1) % 4;
            uint256 side = outcome == 3 ? 0 : (raw[i] & 1); // outcome 3: only the Human side is ever bet
            uint256 rem = 200 - r.g[who][0] - r.g[who][1];
            if (rem == 0) continue;
            uint256 amt = 1 + (raw[i] >> 8) % rem;
            _bet(bettors[who], r.id, side == 0 ? Side.Human : Side.Agent, amt);
            r.g[who][side] += amt;
            r.totalBet += amt;
            if (side == 0) r.hp += amt;
            else r.ap += amt;
        }
    }

    function _claimOne(Run memory r, uint256 w) internal {
        uint256 total = r.g[w][0] + r.g[w][1];
        uint256 stakeWin = r.g[w][r.winnerSide];
        bool claimable = r.expected == 2 ? stakeWin > 0 : total > 0;
        if (!claimable) {
            vm.expectRevert(GapMarket.NothingToClaim.selector);
            _claimAs(bettors[w], r.id);
            return;
        }
        uint256 balBefore = _bal(bettors[w]);
        _claimAs(bettors[w], r.id);
        uint256 payout = _bal(bettors[w]) - balBefore;
        r.paid += payout;
        if (r.expected == 2) {
            r.winners++;
            uint256 winnerPool = r.winnerSide == 0 ? r.hp : r.ap;
            // payout == floor(stake * pool / winnerPool): payout*winnerPool <= stake*pool < (payout+1)*winnerPool
            assertLe(payout * winnerPool, stakeWin * (r.hp + r.ap));
            assertLt(stakeWin * (r.hp + r.ap), (payout + 1) * winnerPool);
        } else {
            assertEq(payout, total);
        }
        vm.expectRevert(GapMarket.AlreadyClaimed.selector);
        _claimAs(bettors[w], r.id);
    }

    /// @dev Pool-sized payouts never divide by zero: status 2 implies both pools are non-empty.
    function testFuzz_resolvedImpliesBothPoolsNonEmpty(
        uint8 outcomeRaw,
        uint256 hAmt,
        uint256 aAmt,
        uint256 h2Amt,
        uint256 a2Amt
    ) public {
        uint256 id = ids[bound(outcomeRaw, 0, 3)];
        uint256[4] memory amt = [bound(hAmt, 0, 200), bound(aAmt, 0, 200), bound(h2Amt, 0, 200), bound(a2Amt, 0, 200)];
        // alice and carol bet Human, bob and dave bet Agent.
        address[4] memory who = [alice, bob, carol, dave];
        for (uint256 i = 0; i < 4; i++) {
            if (amt[i] > 0) _bet(who[i], id, i % 2 == 0 ? Side.Human : Side.Agent, amt[i]);
        }
        _postStd(id);
        uint8 st = _status(id);
        (uint256 h, uint256 a) = market.pools(id);
        assertEq(h, amt[0] + amt[2]);
        assertEq(a, amt[1] + amt[3]);
        if (st == 2 || st == 3) {
            assertGt(h, 0);
            assertGt(a, 0);
        }
        if (h == 0 || a == 0) assertEq(st, 1);
        if (st == 2) {
            // The winner's claim divides by the winner pool: it must work (no division by zero), and each
            // winner gets exactly floor(stake * (humanPool + agentPool) / winnerPool).
            uint256 first = id == ids[1] ? 1 : 0; // Agent wins round 1, Human wins the others
            uint256 winnerPool = first == 0 ? h : a;
            for (uint256 k = 0; k < 2; k++) {
                uint256 idx = first + 2 * k;
                if (amt[idx] == 0) continue;
                uint256 balBefore = _bal(who[idx]);
                _claimAs(who[idx], id);
                assertEq(_bal(who[idx]) - balBefore, amt[idx] * (h + a) / winnerPool);
            }
        }
    }
}

/// @dev Drives bets, time and claims across five rounds for the stateful invariant tests. Every call is
///      guarded so that it either does real work or returns without reverting.
contract GapHandler is Test {
    GapMarket public market;
    Arena public arena;
    Points public points;
    address public keeper;
    uint64 public t0;

    uint256[] public ids; // the last id is the round nobody posts (it turns void)
    address[] public actors;

    mapping(uint256 => uint256) public betTotal; // per round
    mapping(uint256 => uint256) public paidTotal; // per round
    mapping(uint256 => uint8) public firstStatus; // first non-zero status seen per round
    mapping(uint256 => mapping(address => bool)) public didClaim;
    uint256 public totalBet;
    uint256 public totalPaid;
    uint256 public betCalls;
    uint256 public claimCalls;
    bool public postedAll;

    constructor(GapMarket m, Arena a, Points p, address keeper_, uint64 t0_, uint256[] memory ids_) {
        market = m;
        arena = a;
        points = p;
        keeper = keeper_;
        t0 = t0_;
        ids = ids_;
        for (uint160 i = 0; i < 5; i++) {
            actors.push(address(uint160(0xC000) + i));
        }
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function bet(uint256 actorSeed, uint256 idSeed, uint256 sideSeed, uint256 amtSeed) external {
        if (vm.getBlockTimestamp() >= t0 + 300) return; // betting is closed (marketEnd)
        address who = actors[actorSeed % actors.length];
        uint256 id = ids[idSeed % ids.length];
        Side s = sideSeed % 2 == 0 ? Side.Human : Side.Agent;
        uint256 rem = 200 - market.stakeOf(id, who, Side.Human) - market.stakeOf(id, who, Side.Agent);
        if (rem == 0) return;
        uint256 amt = 1 + amtSeed % rem;
        vm.prank(who);
        market.bet(id, s, amt);
        betTotal[id] += amt;
        totalBet += amt;
        betCalls++;
    }

    /// @dev Finds an unclaimed position (starting at the seeds), settles time as needed, claims it.
    function claim(uint256 actorSeed, uint256 idSeed) external {
        uint256 n = actors.length;
        uint256 m = ids.length;
        for (uint256 i = 0; i < m; i++) {
            uint256 id = ids[(idSeed % m + i) % m];
            for (uint256 j = 0; j < n; j++) {
                address who = actors[(actorSeed % n + j) % n];
                if (didClaim[id][who]) continue;
                uint256 h = market.stakeOf(id, who, Side.Human);
                uint256 a = market.stakeOf(id, who, Side.Agent);
                if (h + a == 0) continue;
                _settle(id);
                uint8 st = market.status(id);
                if (st == 0) return;
                _observe(id, st);
                if (st == 2 && !_winnerHasStake(id, h, a)) continue;
                uint256 before = points.balanceOf(who);
                vm.prank(who);
                market.claim(id);
                uint256 payout = points.balanceOf(who) - before;
                didClaim[id][who] = true;
                paidTotal[id] += payout;
                totalPaid += payout;
                claimCalls++;
                return;
            }
        }
    }

    function advance() external {
        if (vm.getBlockTimestamp() < t0 + 300) vm.warp(t0 + 300);
        else if (!postedAll) _postAll();
        else if (vm.getBlockTimestamp() <= t0 + 1480) vm.warp(t0 + 1481);
    }

    function _winnerHasStake(uint256 id, uint256 h, uint256 a) private view returns (bool) {
        (uint8 hs, uint8 as_,,) = arena.consensusScores(id);
        return hs > as_ ? h > 0 : a > 0;
    }

    function _settle(uint256 id) private {
        if (!postedAll) _postAll();
        if (id == ids[ids.length - 1] && vm.getBlockTimestamp() <= t0 + 1480) vm.warp(t0 + 1481);
    }

    /// @dev Posts every round except the last one at t0+480 (the earliest allowed time).
    function _postAll() private {
        if (vm.getBlockTimestamp() < t0 + 480) vm.warp(t0 + 480);
        for (uint256 i = 0; i + 1 < ids.length; i++) {
            vm.prank(keeper);
            arena.postCandles(ids[i], _real1(), keccak256("source"));
        }
        postedAll = true;
    }

    function _observe(uint256 id, uint8 st) private {
        if (firstStatus[id] == 0) firstStatus[id] = st;
    }

    function observeAll() external {
        for (uint256 i = 0; i < ids.length; i++) {
            uint8 st = market.status(ids[i]);
            if (st != 0 && firstStatus[ids[i]] == 0) firstStatus[ids[i]] = st;
        }
    }

    function _real1() private pure returns (Candle[3] memory p) {
        p[0] = Candle(10, 12, -2);
        p[1] = Candle(20, 22, 8);
        p[2] = Candle(30, 32, 18);
    }
}

contract GapMarketInvariantTest is GapBase {
    GapHandler internal handler;
    uint256[] internal roundIds;
    uint256 internal startSupply;

    function setUp() public override {
        super.setUp();
        // five rounds: Human wins, Agent wins, tie, Human wins (4 vs 5 reveals), and a round nobody posts.
        for (uint256 k = 0; k < 5; k++) {
            roundIds.push(_openStd());
        }
        _commitAll(roundIds[0], 3, _pPerfect(), 3, _pNeg());
        _commitAll(roundIds[1], 3, _pNeg(), 3, _pPerfect());
        _commitAll(roundIds[2], 3, _pPerfect(), 3, _pPerfect());
        _commitAll(roundIds[3], 4, _pPerfect(), 5, _pNeg());
        _commitAll(roundIds[4], 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 100);
        _revealAll(roundIds[0], 3, _pPerfect(), 3, _pNeg());
        _revealAll(roundIds[1], 3, _pNeg(), 3, _pPerfect());
        _revealAll(roundIds[2], 3, _pPerfect(), 3, _pPerfect());
        _revealAll(roundIds[3], 4, _pPerfect(), 5, _pNeg());
        _revealAll(roundIds[4], 3, _pPerfect(), 3, _pNeg());
        vm.warp(t0 + 200);
        for (uint256 k = 0; k < 5; k++) {
            arena.freezeAll(roundIds[k]);
        }
        handler = new GapHandler(market, arena, points, keeper, t0, roundIds);
        for (uint256 i = 0; i < handler.actorsLength(); i++) {
            points.mint(handler.actors(i), 1000); // 5 rounds x 200 cap
        }
        startSupply = points.totalSupply();
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](4);
        sels[0] = GapHandler.bet.selector;
        sels[1] = GapHandler.claim.selector;
        sels[2] = GapHandler.advance.selector;
        sels[3] = GapHandler.observeAll.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Deterministic proof that the handler is not vacuous: a bet and a claim really happen.
    function test_handlerDoesRealWork() public {
        handler.bet(0, 0, 0, 99); // actor 0, round 0 (Human wins), Human, 100
        handler.bet(1, 0, 1, 49); // actor 1, round 0, Agent, 50
        assertEq(handler.betCalls(), 2);
        assertEq(handler.betTotal(roundIds[0]), 150);
        handler.claim(0, 0); // settles (posts all), actor 0 claims 150
        assertEq(handler.claimCalls(), 1);
        assertEq(handler.paidTotal(roundIds[0]), 150);
        assertEq(points.totalSupply(), startSupply - 150 + 150);
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 60
    /// forge-config: default.invariant.fail_on_revert = true
    function invariant_totalClaimsNeverExceedPool() public view {
        for (uint256 i = 0; i < roundIds.length; i++) {
            uint256 id = roundIds[i];
            (uint256 h, uint256 a) = market.pools(id);
            assertEq(handler.betTotal(id), h + a); // the ghost agrees with the contract
            assertLe(handler.paidTotal(id), h + a); // never pays out more than the pool
        }
        // Total supply consistency: every bet burns, every payout mints, nothing else.
        assertEq(points.totalSupply(), startSupply - handler.totalBet() + handler.totalPaid());
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 60
    /// forge-config: default.invariant.fail_on_revert = true
    function invariant_statusNeverChangesOnceSet() public view {
        for (uint256 i = 0; i < roundIds.length; i++) {
            uint8 first = handler.firstStatus(roundIds[i]);
            if (first != 0) assertEq(market.status(roundIds[i]), first);
        }
    }
}
