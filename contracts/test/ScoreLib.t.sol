// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Candle, ScoreLib} from "../src/ScoreLib.sol";

/// @dev External wrapper so `vm.expectRevert` works on the library's internal functions.
contract ScoreLibHarness {
    function isValid(Candle[3] memory p) external pure returns (bool) {
        return ScoreLib.isValid(p);
    }

    function closeTerm(uint256 absDc, uint256 t) external pure returns (uint256) {
        return ScoreLib.closeTerm(absDc, t);
    }

    function score(Candle[3] memory pred, Candle[3] memory real, uint32 t) external pure returns (uint8) {
        return ScoreLib.score(pred, real, t);
    }
}

contract ScoreLibTest is Test {
    ScoreLibHarness internal h;

    function setUp() public {
        h = new ScoreLibHarness();
    }

    // ---------------------------------------------------------------- helpers

    function _c(int32 close, int32 high, int32 low) internal pure returns (Candle memory) {
        return Candle(close, high, low);
    }

    function _path(Candle memory a, Candle memory b, Candle memory c) internal pure returns (Candle[3] memory p) {
        p[0] = a;
        p[1] = b;
        p[2] = c;
    }

    /// @dev Reference real path from the plan: close=[10,20,30] high=[12,22,32] low=[-2,8,18].
    function _real() internal pure returns (Candle[3] memory) {
        return _path(_c(10, 12, -2), _c(20, 22, 8), _c(30, 32, 18));
    }

    function _flat() internal pure returns (Candle[3] memory) {
        return _path(_c(0, 0, 0), _c(0, 0, 0), _c(0, 0, 0));
    }

    function _fromSeeds(bytes32 a, bytes32 b, bytes32 c) internal pure returns (Candle[3] memory p) {
        bytes32[3] memory s = [a, b, c];
        for (uint256 i = 0; i < 3; i++) {
            uint256 x = uint256(s[i]);
            p[i] = Candle(int32(uint32(x)), int32(uint32(x >> 32)), int32(uint32(x >> 64)));
        }
    }

    function _maxPath() internal pure returns (Candle[3] memory) {
        int32 m = type(int32).max;
        return _path(_c(m, m, m), _c(m, m, m), _c(m, m, m));
    }

    function _minPath() internal pure returns (Candle[3] memory) {
        int32 n = type(int32).min;
        return _path(_c(n, n, n), _c(n, n, n), _c(n, n, n));
    }

    // ------------------------------------------------------------- pinned vectors

    function test_perfectPathScores100() public view {
        assertEq(h.score(_real(), _real(), 20), 100);
    }

    function test_flatBaselineScores29() public view {
        // per-candle s = 53000, 20000, 15000 (sum 88000 -> 88000*100/300000 = 29)
        assertEq(h.score(_flat(), _real(), 20), 29);
    }

    // ------------------------------------------------- direction term in isolation
    // T = uint32.max forces C = R = 10000 for tiny differences, so only D varies.

    function test_bothFlatDirectionIsMatch() public view {
        // candle 1: both flat (open 0, close 0), different highs/lows. Wrong D (0) would give 90.
        Candle[3] memory real = _path(_c(0, 2, -2), _c(10, 10, 0), _c(20, 21, 10));
        Candle[3] memory pred = _path(_c(0, 1, -1), _c(10, 10, 0), _c(20, 21, 10));
        assertEq(h.score(pred, real, type(uint32).max), 100);
    }

    function test_oneFlatDirectionIsHalf() public view {
        // candle 1: real flat, pred up. D = 5000, s = 85000; others 100000 -> 285000*100/300000 = 95.
        Candle[3] memory real = _path(_c(0, 1, -1), _c(10, 10, 0), _c(20, 21, 10));
        Candle[3] memory pred = _path(_c(1, 1, 0), _c(10, 10, 0), _c(20, 21, 10));
        assertEq(h.score(pred, real, type(uint32).max), 95);
        // symmetric: pred flat, real up
        assertEq(h.score(real, pred, type(uint32).max), 95);
    }

    function test_oppositeDirectionIsZero() public view {
        // candle 1: real up, pred down. D = 0, s = 70000 -> 270000*100/300000 = 90.
        Candle[3] memory real = _path(_c(5, 6, 0), _c(10, 10, 5), _c(15, 16, 10));
        Candle[3] memory pred = _path(_c(-5, 0, -5), _c(10, 10, -5), _c(15, 16, 10));
        assertEq(h.score(pred, real, type(uint32).max), 90);
    }

    function test_sameNonFlatDirectionIsMatch() public view {
        // both down in candle 1, both up elsewhere
        Candle[3] memory real = _path(_c(-5, 0, -6), _c(10, 10, -5), _c(15, 16, 10));
        Candle[3] memory pred = _path(_c(-4, 0, -6), _c(10, 10, -4), _c(15, 16, 10));
        assertEq(h.score(pred, real, type(uint32).max), 100);
    }

    // ------------------------------------------------------------- closeTerm

    function test_closeTermKnownValues() public view {
        assertEq(h.closeTerm(0, 20), 10000);
        assertEq(h.closeTerm(20, 20), 0);
        assertEq(h.closeTerm(40, 20), 0); // clamped
        assertEq(h.closeTerm(1, 3), 10000 - 3333);
        // 2147483647 * 10000 / 4294967295 = 4999 (floor) -> 5001
        assertEq(h.closeTerm(2147483647, type(uint32).max), 5001);
        // absDc far past the clamp must return 0, not panic on absDc * 10000
        assertEq(h.closeTerm(type(uint256).max, 1), 0);
        assertEq(h.closeTerm(type(uint256).max, type(uint32).max), 0);
        assertEq(h.closeTerm(type(uint256).max, type(uint256).max), 0);
        assertEq(h.closeTerm(type(uint256).max / 10000 + 1, 1), 0);
    }

    /// @dev Full uint256 range for absDc: never reverts, stays in 0..10000, and is 0 once absDc >= T.
    function testFuzz_closeTermFullRangeAbsDc(uint256 absDc, uint256 t) public view {
        t = bound(t, 1, type(uint32).max);
        uint256 c = h.closeTerm(absDc, t);
        assertLe(c, 10000);
        if (absDc >= t) {
            assertEq(c, 0);
        } else {
            assertEq(c, 10000 - absDc * 10000 / t);
        }
    }

    function testFuzz_closeTermIsMonotone(uint256 a, uint256 b, uint256 t) public view {
        a = bound(a, 0, 1 << 33);
        b = bound(b, 0, 1 << 33);
        t = bound(t, 1, type(uint32).max);
        (uint256 lo, uint256 hi) = a <= b ? (a, b) : (b, a);
        uint256 cLo = h.closeTerm(lo, t);
        uint256 cHi = h.closeTerm(hi, t);
        assertGe(cLo, cHi);
        assertLe(cLo, 10000);
    }

    // ----------------------------------------------------------------- extremes

    function test_extremeAlternatingIdenticalPathScores100() public view {
        // closes max, min, max: close-open spans the whole int32 range (overflows in int32 arithmetic)
        int32 m = type(int32).max;
        int32 n = type(int32).min;
        Candle[3] memory p = _path(_c(m, m, 0), _c(n, m, n), _c(m, m, n));
        assertTrue(h.isValid(p));
        assertEq(h.score(p, p, 1), 100);
        assertEq(h.score(p, p, type(uint32).max), 100);
    }

    function test_extremeMaxVsMinScores20() public view {
        // dc = 2^32 - 1 on every candle -> C = R = 0. Direction: candle 1 opposite (0),
        // candles 2 and 3 both flat (10000 each) -> sum 60000 -> 20.
        assertEq(h.score(_maxPath(), _minPath(), 1), 20);
        assertEq(h.score(_minPath(), _maxPath(), 1), 20);
        // 2*T must not overflow for T = uint32.max
        assertEq(h.score(_maxPath(), _minPath(), type(uint32).max), 20);
    }

    function test_extremeTOneOffByOne() public view {
        // T = 1: R loses half when |dh|+|dl| = 1 (1*10000/2 = 5000).
        // Candle 1: pred high off by one -> s1 = 5*10000 + 2*5000 + 3*10000 = 90000;
        // others 100000 -> 290000*100/300000 = 96.
        Candle[3] memory pred = _real();
        pred[0].high = 13;
        assertEq(h.score(pred, _real(), 1), 96);
    }

    function test_tOneOneBpHighErrorScores96() public view {
        // Inputs written out in full (not via a helper that could alias `real`):
        // pred is the reference path with candle 1 high 13 instead of 12; T = 1.
        Candle[3] memory real = _path(_c(10, 12, -2), _c(20, 22, 8), _c(30, 32, 18));
        Candle[3] memory pred = _path(_c(10, 13, -2), _c(20, 22, 8), _c(30, 32, 18));
        assertEq(h.score(pred, real, 1), 96);
        assertEq(real[0].high, 12); // real untouched
        // |dh| + |dl| = 1 -> R = 10000 - 1*10000/2 = 5000 -> s1 = 50000 + 10000 + 30000 = 90000
        assertEq(h.score(real, real, 1), 100);
    }

    // ------------------------------------------------------------------ isValid

    function test_isValidAcceptsReferencePath() public view {
        assertTrue(h.isValid(_real()));
        assertTrue(h.isValid(_flat()));
    }

    function test_isValidRejectsHighBelowClose() public view {
        // candle 1: open 0, close 10, high 8 (>= open but < close)
        assertFalse(h.isValid(_path(_c(10, 8, 0), _c(20, 22, 8), _c(30, 32, 18))));
        assertTrue(h.isValid(_path(_c(10, 10, 0), _c(20, 22, 8), _c(30, 32, 18))));
        // candle 2: open 10 (prev close), close 20, high 15
        assertFalse(h.isValid(_path(_c(10, 12, -2), _c(20, 15, 8), _c(30, 32, 18))));
        // candle 1 down: high below open (open 0, close -10, high -1). Candle 2 opens at -10, so
        // its low -10 is valid and ONLY candle 1 can make this path invalid.
        assertFalse(h.isValid(_path(_c(-10, -1, -10), _c(20, 22, -10), _c(30, 32, 18))));
        assertTrue(h.isValid(_path(_c(-10, 0, -10), _c(20, 22, -10), _c(30, 32, 18))));
    }

    function test_isValidRejectsLowAboveOpen() public view {
        // candle 1: open 0, close 10, low 5 (<= close but > open)
        assertFalse(h.isValid(_path(_c(10, 12, 5), _c(20, 22, 8), _c(30, 32, 18))));
        assertTrue(h.isValid(_path(_c(10, 12, 0), _c(20, 22, 8), _c(30, 32, 18))));
        // candle 3: open 20 (prev close), close 30, low 25
        assertFalse(h.isValid(_path(_c(10, 12, -2), _c(20, 22, 8), _c(30, 32, 25))));
        // candle 1 down: low above close (open 0, close -10, low -5). Candle 2 opens at -10 (low -10 is
        // valid), so ONLY candle 1 can make this path invalid.
        assertFalse(h.isValid(_path(_c(-10, 0, -5), _c(20, 22, -10), _c(30, 32, 18))));
    }

    /// @dev Each isValid clause in isolation: the path violates exactly one of
    /// low<=open, low<=close, high>=open, high>=close (every other candle is valid),
    /// so removing that single clause from isValid makes exactly one of these fail.
    function test_isValidEachClauseIsolated() public view {
        // low > open only: up candle (open 0, close 10), low 5 is <= close
        assertFalse(h.isValid(_path(_c(10, 12, 5), _c(20, 22, 8), _c(30, 32, 18))), "low>open");
        // low > close only: down candle (open 0, close -10), low -5 is <= open
        assertFalse(h.isValid(_path(_c(-10, 0, -5), _c(20, 22, -10), _c(30, 32, 18))), "low>close");
        // high < open only: down candle (open 0, close -10), high -1 is >= close
        assertFalse(h.isValid(_path(_c(-10, -1, -10), _c(20, 22, -10), _c(30, 32, 18))), "high<open");
        // high < close only: up candle (open 0, close 10), high 8 is >= open
        assertFalse(h.isValid(_path(_c(10, 8, 0), _c(20, 22, 8), _c(30, 32, 18))), "high<close");
        // same four violations in the last candle (open = previous close, not 0)
        assertFalse(h.isValid(_path(_c(10, 12, -2), _c(20, 22, 8), _c(30, 32, 25))), "c3 low>open");
        assertFalse(h.isValid(_path(_c(10, 12, -2), _c(20, 22, 8), _c(5, 20, 10))), "c3 low>close");
        assertFalse(h.isValid(_path(_c(10, 12, -2), _c(20, 22, 8), _c(5, 19, 0))), "c3 high<open");
        assertFalse(h.isValid(_path(_c(10, 12, -2), _c(20, 22, 8), _c(30, 29, 18))), "c3 high<close");
        // boundaries are inclusive: low == open == close and high == open == close are valid
        assertTrue(h.isValid(_path(_c(10, 10, 0), _c(20, 20, 10), _c(5, 20, 5))));
    }

    // ------------------------------------------------------------------- reverts

    function test_TZeroReverts() public {
        vm.expectRevert(ScoreLib.ZeroT.selector);
        h.score(_real(), _real(), 0);
    }

    function test_closeTermTZeroReverts() public {
        vm.expectRevert(ScoreLib.ZeroT.selector);
        h.closeTerm(5, 0);
    }

    // ------------------------------------------------------------ vector parity

    /// @dev Fails if `test/vectors/score.json` is stale relative to ScoreLib (rerun `forge script script/GenVectors.s.sol`).
    /// The TypeScript side replays the same file, so this closes the parity loop from the Solidity side.
    function test_vectorsMatchScoreLib() public view {
        string memory json = vm.readFile("test/vectors/score.json");
        uint256 n = 0;
        while (vm.keyExistsJson(json, string.concat(".vectors[", vm.toString(n), "]"))) {
            string memory k = string.concat(".vectors[", vm.toString(n), "]");
            Candle[3] memory pred = _readPath(json, string.concat(k, ".pred"));
            Candle[3] memory real = _readPath(json, string.concat(k, ".real"));
            uint32 t = uint32(vm.parseJsonUint(json, string.concat(k, ".T")));
            assertEq(uint256(h.score(pred, real, t)), vm.parseJsonUint(json, string.concat(k, ".score")), k);
            assertEq(h.isValid(pred), vm.parseJsonBool(json, string.concat(k, ".predValid")), k);
            assertEq(h.isValid(real), vm.parseJsonBool(json, string.concat(k, ".realValid")), k);
            n++;
        }
        assertGe(n, 20);
    }

    function _readPath(string memory json, string memory k) internal pure returns (Candle[3] memory p) {
        for (uint256 i = 0; i < 3; i++) {
            string memory c = string.concat(k, "[", vm.toString(i), "]");
            p[i] = Candle(
                int32(vm.parseJsonInt(json, string.concat(c, ".close"))),
                int32(vm.parseJsonInt(json, string.concat(c, ".high"))),
                int32(vm.parseJsonInt(json, string.concat(c, ".low")))
            );
        }
    }

    // --------------------------------------------------------------------- fuzz

    function testFuzz_scoreNeverExceeds100(bytes32 a, bytes32 b, bytes32 c, bytes32 d, bytes32 e, bytes32 f, uint32 t)
        public
        view
    {
        t = uint32(bound(t, 1, type(uint32).max));
        uint8 s = h.score(_fromSeeds(a, b, c), _fromSeeds(d, e, f), t);
        assertLe(s, 100);
    }

    function testFuzz_identicalPathScores100(bytes32 a, bytes32 b, bytes32 c, uint32 t) public view {
        t = uint32(bound(t, 1, type(uint32).max));
        Candle[3] memory p = _fromSeeds(a, b, c);
        assertEq(h.score(p, p, t), 100);
    }
}
