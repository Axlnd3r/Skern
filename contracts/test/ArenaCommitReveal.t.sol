// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Points} from "../src/Points.sol";
import {Registry, Kind} from "../src/Registry.sol";
import {AllowlistGate} from "../src/AllowlistGate.sol";
import {Candle} from "../src/ScoreLib.sol";
import {Arena, RoundParams} from "../src/Arena.sol";

contract ArenaCommitRevealTest is Test {
    event KeeperSet(address indexed keeper);
    event RoundOpened(uint256 indexed id, RoundParams params, uint32 bucketWidth);
    event Committed(uint256 indexed id, address indexed who, Kind kind);
    event Revealed(uint256 indexed id, address indexed who, Kind kind, Candle[3] path);

    Points internal points;
    AllowlistGate internal gate;
    Registry internal registry;
    Arena internal arena;

    address internal keeper = address(0x4EE9E4);
    address internal stranger = address(0x57A4);

    uint64 internal t0 = 1_000_000;
    uint256 internal constant STAKE = 50;
    uint256 internal constant SALT_SEED = 0x5a17;

    function setUp() public {
        vm.warp(t0);
        points = new Points(address(this));
        gate = new AllowlistGate(address(this));
        registry = new Registry(points, gate, address(this));
        arena = new Arena(points, registry, address(this));
        points.setMinter(address(registry), true);
        points.setSpender(address(registry), true);
        points.setSpender(address(arena), true);
        registry.setArena(arena);
        arena.setKeeper(keeper);
    }

    // ------------------------------------------------------------ helpers

    function _params() internal view returns (RoundParams memory p) {
        p.ticker = bytes32("AAPL");
        p.p0 = 190_00;
        p.T = 100;
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

    function _openDefault() internal returns (uint256) {
        return _open(_params());
    }

    function _human(uint160 n) internal returns (address who) {
        who = address(uint160(0x1000) + n);
        gate.setAllowed(who, true);
        vm.prank(who);
        registry.registerHuman();
    }

    function _agent(uint160 n) internal returns (address who) {
        who = address(uint160(0x2000) + n);
        vm.prank(who);
        registry.registerAgent("ipfs://agent");
    }

    function _c(int32 close, int32 high, int32 low) internal pure returns (Candle memory) {
        return Candle(close, high, low);
    }

    /// @dev Valid path used as the default and as the known-answer fixture.
    function _basePath() internal pure returns (Candle[3] memory p) {
        p[0] = _c(10, 25, -5);
        p[1] = _c(-20, 15, -30);
        p[2] = _c(-8, 3, -40);
    }

    /// @dev Valid path whose nine fields all land in different buckets for width 10.
    function _spreadPath() internal pure returns (Candle[3] memory p) {
        p[0] = _c(30, 45, -5);
        p[1] = _c(-60, 50, -75);
        p[2] = _c(-20, 20, -85);
    }

    function _salt(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode(SALT_SEED, n));
    }

    function _commitAs(uint256 id, address who, Candle[3] memory path, bytes32 salt) internal {
        bytes32 h = arena.hashPath(path, salt, who);
        vm.prank(who);
        arena.commit(id, h);
    }

    function _kindOfEntry(uint256 id, address who) internal view returns (Kind k) {
        (k,,,) = arena.entryOf(id, who);
    }

    // ------------------------------------------------------------ constructor, keeper

    function test_constructorStoresWiringAndRejectsZero() public {
        assertEq(address(arena.points()), address(points));
        assertEq(address(arena.registry()), address(registry));
        assertEq(arena.owner(), address(this));
        assertEq(arena.keeper(), keeper);
        vm.expectRevert(Arena.ZeroAddress.selector);
        new Arena(Points(address(0)), registry, address(this));
        vm.expectRevert(Arena.ZeroAddress.selector);
        new Arena(points, Registry(address(0)), address(this));
        vm.expectRevert(Arena.ZeroAddress.selector);
        new Arena(points, registry, address(0));
    }

    function test_setKeeperEmitsAndIsSetOnce() public {
        Arena a = new Arena(points, registry, address(this));
        assertEq(a.keeper(), address(0));
        vm.expectEmit(true, false, false, false, address(a));
        emit KeeperSet(keeper);
        a.setKeeper(keeper);
        assertEq(a.keeper(), keeper);
        vm.expectRevert(Arena.KeeperAlreadySet.selector);
        a.setKeeper(stranger);
        assertEq(a.keeper(), keeper);
    }

    function test_setKeeperRejectsZero() public {
        Arena a = new Arena(points, registry, address(this));
        vm.expectRevert(Arena.ZeroAddress.selector);
        a.setKeeper(address(0));
        // a failed zero attempt must not consume the single allowed call
        a.setKeeper(keeper);
        assertEq(a.keeper(), keeper);
    }

    function test_setKeeperOnlyOwner() public {
        Arena a = new Arena(points, registry, address(this));
        vm.prank(stranger);
        vm.expectRevert(Arena.NotOwner.selector);
        a.setKeeper(stranger);
        assertEq(a.keeper(), address(0));
    }

    function test_openRoundOnlyKeeper() public {
        RoundParams memory p = _params();
        vm.prank(stranger);
        vm.expectRevert(Arena.NotKeeper.selector);
        arena.openRound(p);
        // the owner is not the keeper either
        vm.expectRevert(Arena.NotKeeper.selector);
        arena.openRound(p);
        assertEq(arena.roundCount(), 0);
    }

    function test_openRoundBeforeKeeperSetReverts() public {
        Arena a = new Arena(points, registry, address(this));
        RoundParams memory p = _params();
        vm.expectRevert(Arena.NotKeeper.selector);
        a.openRound(p);
    }

    // ------------------------------------------------------------ openRound

    function test_openRoundStoresParamsAndWidth() public {
        RoundParams memory p = _params();
        p.T = 15;
        uint256 id = _open(p);
        assertEq(id, 1);
        assertEq(arena.roundCount(), 1);
        assertEq(arena.bucketWidth(id), 2);

        RoundParams memory q = arena.getRound(id);
        assertEq(q.ticker, p.ticker);
        assertEq(q.p0, p.p0);
        assertEq(q.T, 15);
        assertEq(q.commitEnd, p.commitEnd);
        assertEq(q.revealEnd, p.revealEnd);
        assertEq(q.marketEnd, p.marketEnd);
        assertEq(q.candleSec, p.candleSec);
        assertEq(q.settleDeadline, p.settleDeadline);
        assertEq(q.entryStake, p.entryStake);

        p.T = 1;
        uint256 id2 = _open(p);
        assertEq(id2, 2);
        assertEq(arena.bucketWidth(id2), 1);
        // the first round is untouched
        assertEq(arena.bucketWidth(id), 2);
        assertEq(arena.getRound(id).T, 15);
    }

    function test_openRoundEmitsEvent() public {
        RoundParams memory p = _params();
        p.T = 15;
        vm.expectEmit(true, false, false, true, address(arena));
        emit RoundOpened(1, p, 2);
        _open(p);
    }

    function test_bucketWidthTable() public {
        uint32[6] memory ts = [uint32(1), 10, 11, 15, 20, 21];
        uint32[6] memory ws = [uint32(1), 1, 2, 2, 2, 3];
        for (uint256 i = 0; i < ts.length; i++) {
            RoundParams memory p = _params();
            p.T = ts[i];
            uint256 id = _open(p);
            assertEq(arena.bucketWidth(id), ws[i], "width");
        }
    }

    function test_openRoundMaxTDoesNotOverflow() public {
        RoundParams memory p = _params();
        p.T = type(uint32).max;
        uint256 id = _open(p);
        assertEq(arena.bucketWidth(id), 429496730);
    }

    function test_openRoundRejectsTZero() public {
        RoundParams memory p = _params();
        p.T = 0;
        vm.prank(keeper);
        vm.expectRevert(Arena.ZeroT.selector);
        arena.openRound(p);
    }

    function test_openRoundRejectsZeroStake() public {
        RoundParams memory p = _params();
        p.entryStake = 0;
        vm.prank(keeper);
        vm.expectRevert(Arena.ZeroEntryStake.selector);
        arena.openRound(p);
    }

    function test_openRoundRejectsZeroCandleSec() public {
        RoundParams memory p = _params();
        p.candleSec = 0;
        vm.prank(keeper);
        vm.expectRevert(Arena.ZeroCandleSec.selector);
        arena.openRound(p);
    }

    function test_openRoundRejectsDeadlineBeforeCandlesEnd() public {
        RoundParams memory p = _params();
        uint256 floorDeadline = uint256(p.marketEnd) + 3 * uint256(p.candleSec);
        // exactly marketEnd + 3*candleSec is rejected (strict inequality)
        // forge-lint: disable-next-line(unsafe-typecast)
        p.settleDeadline = uint64(floorDeadline);
        vm.prank(keeper);
        vm.expectRevert(Arena.SettleDeadlineTooEarly.selector);
        arena.openRound(p);
        // one below is rejected too
        // forge-lint: disable-next-line(unsafe-typecast)
        p.settleDeadline = uint64(floorDeadline - 1);
        vm.prank(keeper);
        vm.expectRevert(Arena.SettleDeadlineTooEarly.selector);
        arena.openRound(p);
        // one above is the smallest accepted value
        // forge-lint: disable-next-line(unsafe-typecast)
        p.settleDeadline = uint64(floorDeadline + 1);
        uint256 id = _open(p);
        assertEq(arena.getRound(id).settleDeadline, floorDeadline + 1);
    }

    function test_openRoundDeadlineUsesWideMath() public {
        // marketEnd + 3*candleSec exceeds uint64 here; it must not wrap into a pass
        RoundParams memory p = _params();
        p.marketEnd = type(uint64).max - 1;
        p.candleSec = type(uint32).max;
        p.settleDeadline = type(uint64).max;
        vm.prank(keeper);
        vm.expectRevert(Arena.SettleDeadlineTooEarly.selector);
        arena.openRound(p);
    }

    function test_openRoundRejectsUnsortedTimes() public {
        RoundParams memory p = _params();

        // commitEnd must be strictly in the future
        p.commitEnd = t0;
        vm.prank(keeper);
        vm.expectRevert(Arena.CommitEndNotInFuture.selector);
        arena.openRound(p);
        p.commitEnd = t0 - 1;
        vm.prank(keeper);
        vm.expectRevert(Arena.CommitEndNotInFuture.selector);
        arena.openRound(p);
        p.commitEnd = t0 + 1; // smallest accepted
        p.revealEnd = t0 + 2;
        p.marketEnd = t0 + 3;
        p.settleDeadline = t0 + 3 + 180 + 1;
        uint256 okId = _open(p);
        assertEq(arena.getRound(okId).commitEnd, t0 + 1);
        assertEq(arena.getRound(okId).marketEnd, t0 + 3);

        // commitEnd < revealEnd
        p = _params();
        p.revealEnd = p.commitEnd;
        vm.prank(keeper);
        vm.expectRevert(Arena.RevealEndNotAfterCommitEnd.selector);
        arena.openRound(p);
        p.revealEnd = p.commitEnd - 1;
        vm.prank(keeper);
        vm.expectRevert(Arena.RevealEndNotAfterCommitEnd.selector);
        arena.openRound(p);

        // revealEnd < marketEnd
        p = _params();
        p.marketEnd = p.revealEnd;
        vm.prank(keeper);
        vm.expectRevert(Arena.MarketEndNotAfterRevealEnd.selector);
        arena.openRound(p);
        p.marketEnd = p.revealEnd - 1;
        vm.prank(keeper);
        vm.expectRevert(Arena.MarketEndNotAfterRevealEnd.selector);
        arena.openRound(p);
    }

    function test_roundIdsStartAtOneAndIncrement() public {
        assertEq(arena.roundCount(), 0);
        assertEq(_openDefault(), 1);
        assertEq(_openDefault(), 2);
        assertEq(_openDefault(), 3);
        assertEq(arena.roundCount(), 3);
    }

    // ------------------------------------------------------------ unknown round

    function test_unknownRoundRevertsEverywhere() public {
        address who = _human(1);
        Candle[3] memory path = _basePath();
        // nothing opened yet: id 0 and id 1 are both unknown
        _expectUnknownEverywhere(0, who, path);
        _expectUnknownEverywhere(1, who, path);

        _openDefault();
        _expectUnknownEverywhere(0, who, path);
        _expectUnknownEverywhere(2, who, path);
        _expectUnknownEverywhere(type(uint256).max, who, path);
    }

    function _expectUnknownEverywhere(uint256 id, address who, Candle[3] memory path) internal {
        vm.prank(who);
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.commit(id, bytes32(uint256(1)));
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.reveal(id, who, path, bytes32(0));
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.getRound(id);
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.entryOf(id, who);
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.bucketWidth(id);
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.revealCount(id, Kind.Human);
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.histogram(id, Kind.Human, 0, 100);
        vm.expectRevert(Arena.UnknownRound.selector);
        arena.getHistogram(id, Kind.Human, 0);
    }

    // ------------------------------------------------------------ anyCommitWindowOpen (running max)

    function test_anyCommitWindowOpenFalseWithNoRounds() public view {
        assertFalse(arena.anyCommitWindowOpen());
    }

    function test_anyCommitWindowUsesRunningMaxNotLastValue() public {
        RoundParams memory a = _params();
        a.commitEnd = t0 + 1000;
        a.revealEnd = t0 + 1100;
        a.marketEnd = t0 + 1200;
        a.settleDeadline = t0 + 1200 + 180 + 1000;
        _open(a);
        RoundParams memory b = _params(); // commitEnd = t0 + 100, earlier than A
        _open(b);

        assertTrue(arena.anyCommitWindowOpen());
        vm.warp(t0 + 99);
        assertTrue(arena.anyCommitWindowOpen());
        vm.warp(t0 + 100); // B's commitEnd: A is still open, a last-value-wins build fails here
        assertTrue(arena.anyCommitWindowOpen());
        vm.warp(t0 + 999);
        assertTrue(arena.anyCommitWindowOpen());
        vm.warp(t0 + 1000); // A's commitEnd
        assertFalse(arena.anyCommitWindowOpen());
        vm.warp(t0 + 5000);
        assertFalse(arena.anyCommitWindowOpen());
    }

    function test_anyCommitWindowSameBoundaryAsCommit() public {
        uint256 id = _openDefault();
        address who = _human(1);
        Candle[3] memory path = _basePath();
        bytes32 h = arena.hashPath(path, _salt(1), who);

        vm.warp(t0 + 99);
        assertTrue(arena.anyCommitWindowOpen());
        vm.prank(who);
        arena.commit(id, h); // commit succeeds exactly while the window reads open

        vm.warp(t0 + 100);
        assertFalse(arena.anyCommitWindowOpen());
        address who2 = _human(2);
        vm.prank(who2);
        vm.expectRevert(Arena.CommitWindowClosed.selector);
        arena.commit(id, h);
    }

    function test_anyCommitWindowOnlyGrowsWithLaterRound() public {
        _openDefault(); // commitEnd t0 + 100
        vm.warp(t0 + 100);
        assertFalse(arena.anyCommitWindowOpen());
        RoundParams memory p = _params();
        p.commitEnd = t0 + 400;
        p.revealEnd = t0 + 500;
        p.marketEnd = t0 + 600;
        p.settleDeadline = t0 + 600 + 180 + 1000;
        _open(p);
        assertTrue(arena.anyCommitWindowOpen());
    }

    // ------------------------------------------------------------ hashPath

    function test_hashPathMatchesAbiEncodeDefinition() public view {
        Candle[3] memory path = _basePath();
        address who = address(0xA11CE);
        bytes32 salt = bytes32(uint256(7));
        assertEq(arena.hashPath(path, salt, who), keccak256(abi.encode(path, salt, who)));
    }

    /// @dev Known answer, computed independently of Solidity's abi.encode with Foundry's cast:
    ///   E=$(cast abi-encode "f((int32,int32,int32)[3],bytes32,address)" \
    ///       "[(10,25,-5),(-20,15,-30),(-8,3,-40)]" \
    ///       0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef \
    ///       0x00000000000000000000000000000000000A11CE)
    ///   cast keccak $E
    ///   -> 0x6aa4ec58090dc140b2bc69d95b20635b257592ed7926af51f8e188d630953477
    /// The encoding is 352 bytes (9 path words + salt + who, inline, no offset word).
    /// Task 11 (TypeScript SDK) reuses this constant as a parity target.
    function test_hashPathKnownAnswer() public view {
        Candle[3] memory path = _basePath();
        bytes32 salt = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        address who = address(0xA11CE);
        assertEq(arena.hashPath(path, salt, who), 0x6aa4ec58090dc140b2bc69d95b20635b257592ed7926af51f8e188d630953477);
    }

    function test_hashPathBindsEveryInput() public view {
        Candle[3] memory path = _basePath();
        bytes32 salt = bytes32(uint256(1));
        address who = address(0xA11CE);
        bytes32 h = arena.hashPath(path, salt, who);
        assertTrue(h != arena.hashPath(path, bytes32(uint256(2)), who));
        assertTrue(h != arena.hashPath(path, salt, address(0xB0B)));
        path[2].low = -41;
        assertTrue(h != arena.hashPath(path, salt, who));
    }

    // ------------------------------------------------------------ commit

    function test_commitTakesStakeOnce() public {
        uint256 id = _openDefault();
        address who = _human(1);
        Candle[3] memory path = _basePath();
        bytes32 h = arena.hashPath(path, _salt(1), who);
        uint256 balBefore = points.balanceOf(who);
        uint256 supplyBefore = points.totalSupply();
        assertEq(balBefore, 1000);

        vm.expectEmit(true, true, false, true, address(arena));
        emit Committed(id, who, Kind.Human);
        vm.prank(who);
        arena.commit(id, h);

        assertEq(points.balanceOf(who), balBefore - STAKE);
        assertEq(points.totalSupply(), supplyBefore - STAKE);
        (Kind k, bool revealed, bytes32 stored,) = arena.entryOf(id, who);
        assertEq(uint8(k), uint8(Kind.Human));
        assertFalse(revealed);
        assertEq(stored, h);
        // nothing counted as revealed
        assertEq(arena.revealCount(id, Kind.Human), 0);
        assertEq(arena.revealCount(id, Kind.Agent), 0);
    }

    function test_commitSnapshotsAgentKind() public {
        uint256 id = _openDefault();
        address ag = _agent(1);
        assertEq(points.balanceOf(ag), 900);
        bytes32 h = arena.hashPath(_basePath(), _salt(1), ag);
        vm.expectEmit(true, true, false, true, address(arena));
        emit Committed(id, ag, Kind.Agent);
        vm.prank(ag);
        arena.commit(id, h);
        assertEq(uint8(_kindOfEntry(id, ag)), uint8(Kind.Agent));
        assertEq(points.balanceOf(ag), 900 - STAKE);
    }

    function test_secondCommitReverts() public {
        uint256 id = _openDefault();
        address who = _human(1);
        _commitAs(id, who, _basePath(), _salt(1));
        uint256 bal = points.balanceOf(who);
        bytes32 h2 = arena.hashPath(_spreadPath(), _salt(2), who);
        vm.prank(who);
        vm.expectRevert(Arena.AlreadyCommitted.selector);
        arena.commit(id, h2);
        // no second stake, original hash untouched
        assertEq(points.balanceOf(who), bal);
        (,, bytes32 stored,) = arena.entryOf(id, who);
        assertEq(stored, arena.hashPath(_basePath(), _salt(1), who));
    }

    function test_sameAddressCanCommitInDifferentRounds() public {
        uint256 id1 = _openDefault();
        uint256 id2 = _openDefault();
        address who = _human(1);
        _commitAs(id1, who, _basePath(), _salt(1));
        _commitAs(id2, who, _basePath(), _salt(2));
        assertEq(points.balanceOf(who), 1000 - 2 * STAKE);
    }

    function test_commitOfZeroHashIsStillACommit() public {
        uint256 id = _openDefault();
        address who = _human(1);
        vm.prank(who);
        arena.commit(id, bytes32(0));
        assertEq(uint8(_kindOfEntry(id, who)), uint8(Kind.Human));
        vm.prank(who);
        vm.expectRevert(Arena.AlreadyCommitted.selector);
        arena.commit(id, bytes32(0));
    }

    function test_commitBoundaryAtCommitEnd() public {
        uint256 id = _openDefault();
        address a = _human(1);
        address b = _human(2);
        bytes32 ha = arena.hashPath(_basePath(), _salt(1), a);
        bytes32 hb = arena.hashPath(_basePath(), _salt(2), b);

        vm.warp(t0 + 99); // commitEnd - 1
        vm.prank(a);
        arena.commit(id, ha);
        assertEq(uint8(_kindOfEntry(id, a)), uint8(Kind.Human));

        vm.warp(t0 + 100); // commitEnd
        vm.prank(b);
        vm.expectRevert(Arena.CommitWindowClosed.selector);
        arena.commit(id, hb);
        assertEq(uint8(_kindOfEntry(id, b)), uint8(Kind.None));
    }

    function test_commitAfterCommitEndReverts() public {
        uint256 id = _openDefault();
        address who = _human(1);
        bytes32 h = arena.hashPath(_basePath(), _salt(1), who);
        vm.warp(t0 + 150);
        vm.prank(who);
        vm.expectRevert(Arena.CommitWindowClosed.selector);
        arena.commit(id, h);
        assertEq(points.balanceOf(who), 1000);
    }

    function test_commitUnregisteredReverts() public {
        uint256 id = _openDefault();
        vm.prank(stranger);
        vm.expectRevert(Arena.NotRegistered.selector);
        arena.commit(id, bytes32(uint256(1)));
        assertEq(uint8(_kindOfEntry(id, stranger)), uint8(Kind.None));
    }

    function test_commitInsufficientPointsRevertsAndTakesNothing() public {
        RoundParams memory p = _params();
        p.entryStake = 1001; // a human holds exactly 1000
        uint256 id = _open(p);
        address who = _human(1);
        bytes32 h = arena.hashPath(_basePath(), _salt(1), who);
        uint256 supply = points.totalSupply();

        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(Points.InsufficientBalance.selector, 1000, 1001));
        arena.commit(id, h);

        assertEq(points.balanceOf(who), 1000);
        assertEq(points.totalSupply(), supply);
        assertEq(uint8(_kindOfEntry(id, who)), uint8(Kind.None));
    }

    function test_commitFailsWithoutSpenderRole() public {
        // an Arena that was never granted the spender role cannot take stakes
        Arena a = new Arena(points, registry, address(this));
        a.setKeeper(keeper);
        vm.prank(keeper);
        uint256 id = a.openRound(_params());
        address who = _human(1);
        vm.prank(who);
        vm.expectRevert(Points.NotSpender.selector);
        a.commit(id, bytes32(uint256(1)));
        assertEq(uint8(_kindOf(a, id, who)), uint8(Kind.None));
    }

    function _kindOf(Arena a, uint256 id, address who) internal view returns (Kind k) {
        (k,,,) = a.entryOf(id, who);
    }

    function test_commitWithInvalidPathHashIsAccepted() public {
        uint256 id = _openDefault();
        address who = _human(1);
        Candle[3] memory bad = _basePath();
        bad[0].low = 5; // low above open and close: invalid
        _commitAs(id, who, bad, _salt(1));
        assertEq(uint8(_kindOfEntry(id, who)), uint8(Kind.Human));
        vm.warp(t0 + 100);
        vm.expectRevert(Arena.InvalidPath.selector);
        arena.reveal(id, who, bad, _salt(1));
        assertEq(arena.revealCount(id, Kind.Human), 0);
    }

    // ------------------------------------------------------------ reveal

    function _commitHuman(uint256 id, uint160 n, Candle[3] memory path, bytes32 salt) internal returns (address who) {
        who = _human(n);
        _commitAs(id, who, path, salt);
    }

    function test_revealStoresPathAndEmits() public {
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address who = _commitHuman(id, 1, path, _salt(1));
        vm.warp(t0 + 100);

        vm.expectEmit(true, true, false, true, address(arena));
        emit Revealed(id, who, Kind.Human, path);
        arena.reveal(id, who, path, _salt(1));

        (Kind k, bool revealed, bytes32 h, Candle[3] memory stored) = arena.entryOf(id, who);
        assertEq(uint8(k), uint8(Kind.Human));
        assertTrue(revealed);
        assertEq(h, arena.hashPath(path, _salt(1), who));
        for (uint256 i = 0; i < 3; i++) {
            assertEq(stored[i].close, path[i].close);
            assertEq(stored[i].high, path[i].high);
            assertEq(stored[i].low, path[i].low);
        }
        assertEq(arena.revealCount(id, Kind.Human), 1);
    }

    function test_revealWrongSaltReverts() public {
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address who = _commitHuman(id, 1, path, _salt(1));
        vm.warp(t0 + 100);
        vm.expectRevert(Arena.HashMismatch.selector);
        arena.reveal(id, who, path, _salt(2));
        assertEq(arena.revealCount(id, Kind.Human), 0);
        (, bool revealed,,) = arena.entryOf(id, who);
        assertFalse(revealed);
    }

    function test_revealWrongPathReverts() public {
        uint256 id = _openDefault();
        address who = _commitHuman(id, 1, _basePath(), _salt(1));
        vm.warp(t0 + 100);
        Candle[3] memory other = _basePath();
        other[2].close = -9; // still valid, but not what was committed
        vm.expectRevert(Arena.HashMismatch.selector);
        arena.reveal(id, who, other, _salt(1));
    }

    function test_revealWithWrongWhoReverts() public {
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address alice = _commitHuman(id, 1, path, _salt(1));
        address bob = _human(2); // registered, never committed
        vm.warp(t0 + 100);
        // alice's valid reveal data aimed at an address with no commit
        vm.expectRevert(Arena.NoCommit.selector);
        arena.reveal(id, bob, path, _salt(1));
        // an address that never registered has no commit either
        vm.expectRevert(Arena.NoCommit.selector);
        arena.reveal(id, stranger, path, _salt(1));
        assertEq(arena.revealCount(id, Kind.Human), 0);
        (, bool revealed,,) = arena.entryOf(id, alice);
        assertFalse(revealed);
    }

    function test_revealBySelfSucceeds() public {
        // the local-salt fallback: `who` reveals its own commit directly
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address alice = _commitHuman(id, 1, path, _salt(1));
        vm.warp(t0 + 100);
        vm.prank(alice);
        arena.reveal(id, alice, path, _salt(1));
        (, bool revealed,,) = arena.entryOf(id, alice);
        assertTrue(revealed);
        assertEq(arena.revealCount(id, Kind.Human), 1);
    }

    // ------------------------------------------------------------ round isolation

    /// @dev Asserts that, for `k`, every field holds exactly one count at expected[field] and nothing else.
    function _assertOneEntry(uint256 id, Kind k, uint256[9] memory expected) internal view {
        for (uint8 f = 0; f < 9; f++) {
            uint32[201] memory hh = arena.getHistogram(id, k, f);
            for (uint256 i = 0; i < 201; i++) {
                assertEq(hh[i], i == expected[f] ? 1 : 0, "bucket");
            }
        }
    }

    function _assertEmpty(uint256 id, Kind k) internal view {
        for (uint8 f = 0; f < 9; f++) {
            uint32[201] memory hh = arena.getHistogram(id, k, f);
            for (uint256 i = 0; i < 201; i++) {
                assertEq(hh[i], 0, "bucket must be empty");
            }
        }
    }

    function test_roundsAreIsolated() public {
        uint256 id1 = _openDefault(); // T 100 (width 10), stake 50, commitEnd t0+100, revealEnd t0+200
        RoundParams memory p2 = _params();
        p2.T = 15; // width 2
        p2.entryStake = 70;
        p2.commitEnd = t0 + 150;
        p2.revealEnd = t0 + 400;
        p2.marketEnd = t0 + 500;
        p2.settleDeadline = t0 + 1680;
        uint256 id2 = _open(p2);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(arena.bucketWidth(id1), 10);
        assertEq(arena.bucketWidth(id2), 2);

        Candle[3] memory path = _basePath();
        address alice = _human(1);
        address bob = _human(2);
        address ag = _agent(1);

        // commits at t0: each takes its own round's stake
        _commitAs(id1, alice, path, _salt(1));
        assertEq(points.balanceOf(alice), 950, "round 1 stake is 50, not 70");
        _commitAs(id2, bob, path, _salt(2));
        assertEq(points.balanceOf(bob), 930, "round 2 stake is 70");

        // t0+120: round 1 commit window is closed, round 2's is still open
        vm.warp(t0 + 120);
        bytes32 h = arena.hashPath(path, _salt(3), ag);
        vm.prank(ag);
        vm.expectRevert(Arena.CommitWindowClosed.selector);
        arena.commit(id1, h);
        vm.prank(ag);
        arena.commit(id2, h);
        assertEq(points.balanceOf(ag), 900 - 70);

        // round 1 reveal window is open, round 2's is not yet
        vm.expectRevert(Arena.RevealWindowClosed.selector);
        arena.reveal(id2, bob, path, _salt(2));
        arena.reveal(id1, alice, path, _salt(1));
        assertEq(arena.histogram(id1, Kind.Human, 0, 101), 1, "width 10 puts close1=10 in bucket 101");
        assertEq(arena.histogram(id1, Kind.Human, 0, 105), 0, "width 2 would use bucket 105");
        assertEq(arena.revealCount(id1, Kind.Human), 1);
        assertEq(arena.revealCount(id2, Kind.Human), 0);
        assertEq(arena.revealCount(id2, Kind.Agent), 0);
        _assertEmpty(id2, Kind.Human);
        _assertEmpty(id2, Kind.Agent);

        // t0+160: round 1 reveal window is over, round 2's is open
        vm.warp(t0 + 210);
        vm.expectRevert(Arena.RevealWindowClosed.selector);
        arena.reveal(id1, alice, path, _salt(1)); // already revealed; the window check comes first
        arena.reveal(id2, bob, path, _salt(2));
        arena.reveal(id2, ag, path, _salt(3));

        // round 1 unchanged, in width-10 buckets
        uint256[9] memory e1 = [uint256(101), 102, 99, 98, 101, 97, 99, 100, 96];
        _assertOneEntry(id1, Kind.Human, e1);
        _assertEmpty(id1, Kind.Agent);
        assertEq(arena.revealCount(id1, Kind.Human), 1);
        assertEq(arena.revealCount(id1, Kind.Agent), 0);

        // round 2 in width-2 buckets: floor(v/2) + 100
        uint256[9] memory e2 = [uint256(105), 112, 97, 90, 107, 85, 96, 101, 80];
        _assertOneEntry(id2, Kind.Human, e2);
        _assertOneEntry(id2, Kind.Agent, e2);
        assertEq(arena.revealCount(id2, Kind.Human), 1);
        assertEq(arena.revealCount(id2, Kind.Agent), 1);
    }

    function test_anyoneCanRevealForAnotherAddress() public {
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address alice = _commitHuman(id, 1, path, _salt(1));
        vm.warp(t0 + 100);
        // a third party (the keeper) submits it
        vm.prank(keeper);
        arena.reveal(id, alice, path, _salt(1));
        (, bool revealed,,) = arena.entryOf(id, alice);
        assertTrue(revealed);
        assertEq(arena.revealCount(id, Kind.Human), 1);
        // no points moved because of the relayer
        assertEq(points.balanceOf(keeper), 0);
        assertEq(points.balanceOf(alice), 1000 - STAKE);
    }

    function test_revealWithAnotherAddressesSaltReverts() public {
        // copy attack: bob commits alice's exact hash, then tries to reveal with alice's path and salt
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address alice = _commitHuman(id, 1, path, _salt(1));
        address bob = _human(2);
        bytes32 aliceHash = arena.hashPath(path, _salt(1), alice);
        vm.prank(bob);
        arena.commit(id, aliceHash);
        vm.warp(t0 + 100);
        vm.expectRevert(Arena.HashMismatch.selector);
        arena.reveal(id, bob, path, _salt(1));
        assertEq(arena.revealCount(id, Kind.Human), 0);
        // alice can still reveal her own
        arena.reveal(id, alice, path, _salt(1));
        assertEq(arena.revealCount(id, Kind.Human), 1);
    }

    function test_revealInvalidPathReverts() public {
        uint256 id = _openDefault();
        address who = _human(1);
        Candle[3] memory bad = _basePath();
        bad[1].high = -25; // high below open (10) and close (-20)
        _commitAs(id, who, bad, _salt(1));
        vm.warp(t0 + 100);
        vm.expectRevert(Arena.InvalidPath.selector);
        arena.reveal(id, who, bad, _salt(1));
        assertEq(arena.revealCount(id, Kind.Human), 0);
        assertEq(arena.histogram(id, Kind.Human, 0, 100), 0);
    }

    function test_revealInvalidPathLowAboveOpenReverts() public {
        uint256 id = _openDefault();
        address who = _human(1);
        Candle[3] memory bad = _basePath();
        bad[0].low = 1; // above the implicit open 0
        _commitAs(id, who, bad, _salt(1));
        vm.warp(t0 + 100);
        vm.expectRevert(Arena.InvalidPath.selector);
        arena.reveal(id, who, bad, _salt(1));
    }

    function test_revealOutsideWindowReverts() public {
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address who = _commitHuman(id, 1, path, _salt(1));

        // before the window: commitEnd - 1
        vm.warp(t0 + 99);
        vm.expectRevert(Arena.RevealWindowClosed.selector);
        arena.reveal(id, who, path, _salt(1));

        // at revealEnd: closed again
        vm.warp(t0 + 200);
        vm.expectRevert(Arena.RevealWindowClosed.selector);
        arena.reveal(id, who, path, _salt(1));
        vm.warp(t0 + 5000);
        vm.expectRevert(Arena.RevealWindowClosed.selector);
        arena.reveal(id, who, path, _salt(1));

        assertEq(arena.revealCount(id, Kind.Human), 0);
        assertEq(arena.histogram(id, Kind.Human, 0, 101), 0);
    }

    function test_revealBoundariesAtEachEdge() public {
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address a = _commitHuman(id, 1, path, _salt(1));
        address b = _commitHuman(id, 2, path, _salt(2));

        vm.warp(t0 + 100); // commitEnd: first allowed second
        arena.reveal(id, a, path, _salt(1));
        assertEq(arena.revealCount(id, Kind.Human), 1);

        vm.warp(t0 + 199); // revealEnd - 1: last allowed second
        arena.reveal(id, b, path, _salt(2));
        assertEq(arena.revealCount(id, Kind.Human), 2);
    }

    function test_revealTwiceReverts() public {
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address who = _commitHuman(id, 1, path, _salt(1));
        vm.warp(t0 + 100);
        arena.reveal(id, who, path, _salt(1));
        vm.expectRevert(Arena.AlreadyRevealed.selector);
        arena.reveal(id, who, path, _salt(1));
        // counters did not move a second time
        assertEq(arena.revealCount(id, Kind.Human), 1);
        assertEq(arena.histogram(id, Kind.Human, 0, 100 + 1), 1); // close1 = 10 -> bucket 101 at width 10
    }

    function test_revealIncrementsCountByKind() public {
        uint256 id = _openDefault();
        uint256 id2 = _openDefault(); // opened while its commit window is still in the future
        Candle[3] memory path = _basePath();
        address h1 = _commitHuman(id, 1, path, _salt(1));
        address h2 = _commitHuman(id, 2, path, _salt(2));
        address a1 = _agent(1);
        _commitAs(id, a1, path, _salt(3));
        address a2 = _agent(2);
        _commitAs(id, a2, path, _salt(4));
        address a3 = _agent(3);
        _commitAs(id, a3, path, _salt(5));
        vm.warp(t0 + 100);

        arena.reveal(id, h1, path, _salt(1));
        assertEq(arena.revealCount(id, Kind.Human), 1);
        assertEq(arena.revealCount(id, Kind.Agent), 0);
        arena.reveal(id, a1, path, _salt(3));
        assertEq(arena.revealCount(id, Kind.Human), 1);
        assertEq(arena.revealCount(id, Kind.Agent), 1);
        arena.reveal(id, h2, path, _salt(2));
        arena.reveal(id, a2, path, _salt(4));
        arena.reveal(id, a3, path, _salt(5));
        assertEq(arena.revealCount(id, Kind.Human), 2);
        assertEq(arena.revealCount(id, Kind.Agent), 3);
        assertEq(arena.revealCount(id, Kind.None), 0);
        // a different round has its own counters
        assertEq(arena.revealCount(id2, Kind.Human), 0);
        assertEq(arena.revealCount(id2, Kind.Agent), 0);
    }

    function test_revealKindSnapshotSurvivesReclassify() public {
        uint256 id = _openDefault();
        Candle[3] memory path = _basePath();
        address who = _commitHuman(id, 1, path, _salt(1));

        vm.warp(t0 + 100); // commit window closed everywhere, reveal window open
        assertFalse(arena.anyCommitWindowOpen());
        registry.reclassify(who, Kind.Agent);
        assertEq(uint8(registry.kindOf(who)), uint8(Kind.Agent));

        vm.expectEmit(true, true, false, true, address(arena));
        emit Revealed(id, who, Kind.Human, path);
        arena.reveal(id, who, path, _salt(1));

        assertEq(arena.revealCount(id, Kind.Human), 1);
        assertEq(arena.revealCount(id, Kind.Agent), 0);
        assertEq(uint8(_kindOfEntry(id, who)), uint8(Kind.Human));
        for (uint8 f = 0; f < 9; f++) {
            uint32[201] memory hh = arena.getHistogram(id, Kind.Human, f);
            uint32[201] memory ha = arena.getHistogram(id, Kind.Agent, f);
            uint256 sumH;
            uint256 sumA;
            for (uint256 i = 0; i < 201; i++) {
                sumH += hh[i];
                sumA += ha[i];
            }
            assertEq(sumH, 1, "human histogram has the entry");
            assertEq(sumA, 0, "agent histogram stays empty");
        }
    }

    // ------------------------------------------------------------ histograms

    function test_allNineFieldsLandInTheirOwnBucket() public {
        uint256 id = _openDefault(); // T = 100, width 10
        assertEq(arena.bucketWidth(id), 10);
        Candle[3] memory path = _spreadPath();
        address who = _commitHuman(id, 1, path, _salt(1));
        vm.warp(t0 + 100);
        arena.reveal(id, who, path, _salt(1));

        // field = candle*3 + {0 close, 1 high, 2 low}
        // floor(v/10): 30->3, 45->4, -5->-1, -60->-6, 50->5, -75->-8 (not -7), -20->-2, 20->2, -85->-9 (not -8)
        uint256[9] memory expected = [uint256(103), 104, 99, 94, 105, 92, 98, 102, 91];
        for (uint8 f = 0; f < 9; f++) {
            uint32[201] memory hh = arena.getHistogram(id, Kind.Human, f);
            uint32[201] memory ha = arena.getHistogram(id, Kind.Agent, f);
            for (uint256 i = 0; i < 201; i++) {
                assertEq(hh[i], i == expected[f] ? 1 : 0, "human bucket");
                assertEq(ha[i], 0, "agent bucket");
                assertEq(arena.histogram(id, Kind.Human, f, i), hh[i], "single getter matches array getter");
            }
        }
    }

    function test_histogramAccumulatesAcrossReveals() public {
        uint256 id = _openDefault();
        Candle[3] memory p1 = _spreadPath();
        Candle[3] memory p2 = _spreadPath();
        p2[0].close = 32; // same bucket 103 as p1 for field 0
        p2[0].high = 45;
        address a = _commitHuman(id, 1, p1, _salt(1));
        address b = _commitHuman(id, 2, p2, _salt(2));
        address ag = _agent(1);
        _commitAs(id, ag, p1, _salt(3));
        vm.warp(t0 + 100);
        arena.reveal(id, a, p1, _salt(1));
        arena.reveal(id, b, p2, _salt(2));
        arena.reveal(id, ag, p1, _salt(3));
        assertEq(arena.histogram(id, Kind.Human, 0, 103), 2);
        assertEq(arena.histogram(id, Kind.Agent, 0, 103), 1);
        assertEq(arena.histogram(id, Kind.Human, 8, 91), 2);
        assertEq(arena.histogram(id, Kind.Agent, 8, 91), 1);
    }

    function test_histogramClampsOutOfRange() public {
        uint256 id = _openDefault(); // width 10
        Candle[3] memory path;
        path[0] = _c(type(int32).max, type(int32).max, type(int32).min);
        path[1] = _c(type(int32).min, type(int32).max, type(int32).min);
        path[2] = _c(0, type(int32).max, type(int32).min);
        address who = _commitHuman(id, 1, path, _salt(1));
        vm.warp(t0 + 100);
        arena.reveal(id, who, path, _salt(1));

        // fields: c1 close,high,low ; c2 ... ; c3 ...
        uint256[9] memory expected = [uint256(200), 200, 0, 0, 200, 0, 100, 200, 0];
        for (uint8 f = 0; f < 9; f++) {
            assertEq(arena.histogram(id, Kind.Human, f, expected[f]), 1, "clamped bucket");
        }
        // the clamp must not wrap: no entry anywhere else in an extreme field
        assertEq(arena.histogram(id, Kind.Human, 0, 199), 0);
        assertEq(arena.histogram(id, Kind.Human, 2, 1), 0);
    }

    function test_negativeValueUsesFloorDivision() public {
        RoundParams memory p = _params();
        p.T = 15; // width 2
        uint256 id = _open(p);
        Candle[3] memory path;
        path[0] = _c(0, 0, -15); // low1 = -15: floor(-15/2) = -8 -> bucket 92 (truncation would give 93)
        path[1] = _c(0, 0, 0);
        path[2] = _c(0, 0, 0);
        address who = _commitHuman(id, 1, path, _salt(1));
        vm.warp(t0 + 100);
        arena.reveal(id, who, path, _salt(1));

        assertEq(arena.bucketIndex(-15, 2), 92);
        assertEq(arena.histogram(id, Kind.Human, 2, 92), 1);
        assertEq(arena.histogram(id, Kind.Human, 2, 93), 0);
    }

    // ------------------------------------------------------------ bucketIndex

    function test_bucketIndexKnownValues() public view {
        // zero and small positive values
        assertEq(arena.bucketIndex(0, 1), 100);
        assertEq(arena.bucketIndex(1, 1), 101);
        assertEq(arena.bucketIndex(-1, 1), 99);
        // width 10: positive multiples and just below / above
        assertEq(arena.bucketIndex(9, 10), 100);
        assertEq(arena.bucketIndex(10, 10), 101);
        assertEq(arena.bucketIndex(19, 10), 101);
        assertEq(arena.bucketIndex(20, 10), 102);
        // negative multiples sit exactly on their bucket, one below goes to the next lower
        assertEq(arena.bucketIndex(-10, 10), 99);
        assertEq(arena.bucketIndex(-20, 10), 98);
        assertEq(arena.bucketIndex(-11, 10), 98);
        assertEq(arena.bucketIndex(-19, 10), 98);
        assertEq(arena.bucketIndex(-9, 10), 99);
        // floor, not truncation
        assertEq(arena.bucketIndex(-15, 2), 92);
        assertEq(arena.bucketIndex(-1, 2), 99);
        assertEq(arena.bucketIndex(-2, 2), 99);
        assertEq(arena.bucketIndex(-3, 2), 98);
        // edges of the range: bucket 0 is v <= -100*width, bucket 200 is v >= 100*width
        assertEq(arena.bucketIndex(-1000, 10), 0);
        assertEq(arena.bucketIndex(-990, 10), 1);
        assertEq(arena.bucketIndex(-991, 10), 0);
        assertEq(arena.bucketIndex(-1001, 10), 0);
        assertEq(arena.bucketIndex(999, 10), 199);
        assertEq(arena.bucketIndex(1000, 10), 200);
        assertEq(arena.bucketIndex(1001, 10), 200);
        // int32 extremes
        assertEq(arena.bucketIndex(type(int32).max, 1), 200);
        assertEq(arena.bucketIndex(type(int32).min, 1), 0);
        assertEq(arena.bucketIndex(type(int32).max, 10), 200);
        assertEq(arena.bucketIndex(type(int32).min, 10), 0);
        assertEq(arena.bucketIndex(type(int32).max, type(uint32).max), 100);
        assertEq(arena.bucketIndex(type(int32).min, type(uint32).max), 99);
        // width for T = uint32.max
        assertEq(arena.bucketIndex(type(int32).max, 429496730), 104);
        assertEq(arena.bucketIndex(type(int32).min, 429496730), 95);
    }

    /// @dev Reference floor division built from a non-negative modulus, structurally different
    ///      from the implementation's truncate-then-adjust: floor(v/w) = (v - ((v % w) + w) % w) / w.
    function _refBucket(int32 v, uint32 width) internal pure returns (uint256) {
        int256 vv = v;
        int256 w = int256(uint256(width));
        int256 mod = ((vv % w) + w) % w; // in 0..w-1
        int256 q = (vv - mod) / w; // exact division, equals floor(v/w)
        int256 idx = 100 + q;
        if (idx < 0) idx = 0;
        if (idx > 200) idx = 200;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(idx);
    }

    function testFuzz_bucketIndexMatchesReference(int32 v, uint32 width) public view {
        width = uint32(bound(uint256(width), 1, type(uint32).max));
        uint256 got = arena.bucketIndex(v, width);
        assertLe(got, 200);
        assertEq(got, _refBucket(v, width));
    }

    function test_bucketIndexReferenceAtMaxWidth() public view {
        assertEq(arena.bucketIndex(type(int32).max, 429496730), _refBucket(type(int32).max, 429496730));
        assertEq(arena.bucketIndex(type(int32).min, 429496730), _refBucket(type(int32).min, 429496730));
    }
}
