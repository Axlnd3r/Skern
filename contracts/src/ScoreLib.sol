// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One candle of a path, in int32 basis points relative to P0.
/// The open is implicit: open_1 = 0 (P0), open_i = close_(i-1).
struct Candle {
    int32 close;
    int32 high;
    int32 low;
}

/// @title ScoreLib
/// @notice Pure integer scoring of a predicted 3-candle path against a real one.
/// The operation order is pinned and mirrored by `shared/score.ts`; do not reorder.
/// Per candle: C (close term), R (range term), D (direction term), each in 0..10000,
/// s = 5*C + 2*R + 3*D, score = floor(sum(s) * 100 / 300000).
library ScoreLib {
    /// @dev The normalisation scale T (bp) must be positive.
    error ZeroT();

    uint256 internal constant ONE = 10000;

    /// @notice True iff every candle satisfies low <= min(open, close) and high >= max(open, close).
    function isValid(Candle[3] memory p) internal pure returns (bool) {
        int256 open = 0;
        for (uint256 i = 0; i < 3; i++) {
            int256 close = p[i].close;
            int256 high = p[i].high;
            int256 low = p[i].low;
            if (low > open || low > close) return false;
            if (high < open || high < close) return false;
            open = close;
        }
        return true;
    }

    /// @notice C = 10000 - min(10000, absDc * 10000 / T), in 0..10000. Returns 0 for any absDc >= T.
    function closeTerm(uint256 absDc, uint256 T) internal pure returns (uint256) {
        if (T == 0) revert ZeroT();
        return _closeTerm(absDc, T);
    }

    /// @notice Integer score 0..100 of `pred` against `real`, normalised by T bp.
    function score(Candle[3] memory pred, Candle[3] memory real, uint32 T) internal pure returns (uint8) {
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (T == 0) revert ZeroT(); // checked once, before the loop
        uint256 sum = 0;
        int256 pOpen = 0;
        int256 rOpen = 0;
        for (uint256 i = 0; i < 3; i++) {
            sum += _candleScore(pred[i], real[i], pOpen, rOpen, uint256(T));
            pOpen = pred[i].close;
            rOpen = real[i].close;
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(sum * 100 / 300000); // sum <= 3 * 100000, so the result is <= 100
    }

    /// @dev s = 5*C + 2*R + 3*D for one candle. All differences are taken in int256.
    function _candleScore(Candle memory p, Candle memory r, int256 pOpen, int256 rOpen, uint256 T)
        private
        pure
        returns (uint256)
    {
        uint256 c = _closeTerm(_abs(int256(p.close) - int256(r.close)), T);
        uint256 range = _abs(int256(p.high) - int256(r.high)) + _abs(int256(p.low) - int256(r.low));
        uint256 rr = _complement(range * ONE / (2 * T));
        uint256 d = _direction(int256(p.close) - pOpen, int256(r.close) - rOpen);
        return 5 * c + 2 * rr + 3 * d;
    }

    /// @dev D: 10000 if both signs are equal (both flat counts), 5000 if exactly one is flat, else 0.
    function _direction(int256 pMove, int256 rMove) private pure returns (uint256) {
        int256 ps = pMove > 0 ? int256(1) : (pMove < 0 ? int256(-1) : int256(0));
        int256 rs = rMove > 0 ? int256(1) : (rMove < 0 ? int256(-1) : int256(0));
        if (ps == rs) return ONE;
        if (ps == 0 || rs == 0) return ONE / 2;
        return 0;
    }

    /// @dev 10000 - min(10000, x).
    function _complement(uint256 x) private pure returns (uint256) {
        return x >= ONE ? 0 : ONE - x;
    }

    /// @dev T is known to be non-zero here (checked by every external entry point).
    /// absDc >= T already clamps to 0, so return before multiplying: that keeps
    /// absDc * ONE from overflowing for huge absDc. For absDc < T the result is unchanged.
    function _closeTerm(uint256 absDc, uint256 T) private pure returns (uint256) {
        if (absDc >= T) return 0;
        return ONE - absDc * ONE / T;
    }

    /// @dev |x| for an int256 whose magnitude is below 2^33, so negation never overflows.
    function _abs(int256 x) private pure returns (uint256) {
        // forge-lint: disable-start(unsafe-typecast)
        return x >= 0 ? uint256(x) : uint256(-x);
        // forge-lint: disable-end
    }
}
