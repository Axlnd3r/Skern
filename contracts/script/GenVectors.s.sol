// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Candle, ScoreLib} from "../src/ScoreLib.sol";

/// @notice Writes `test/vectors/score.json`: pred/real/T cases with the Solidity score.
/// `shared/score.test.ts` replays every case against `shared/score.ts`.
/// Deterministic: hand-picked cases plus a fixed-seed keccak PRNG, no timestamps.
/// Run from `contracts/`: `forge script script/GenVectors.s.sol`.
contract GenVectors is Script {
    int32 internal constant MAX = type(int32).max;
    int32 internal constant MIN = type(int32).min;

    string internal body;
    uint256 internal count;

    function run() external {
        _handPicked();
        _random();
        string memory out = string.concat("{\"vectors\":[\n", body, "\n]}\n");
        vm.writeFile("test/vectors/score.json", out);
    }

    // ------------------------------------------------------------ hand-picked

    function _handPicked() internal {
        Candle[3] memory real = _p([int32(10), 12, -2, 20, 22, 8, 30, 32, 18]);
        Candle[3] memory zeros = _p([int32(0), 0, 0, 0, 0, 0, 0, 0, 0]);

        _add("perfect", real, real, 20);
        _add("flat baseline", zeros, real, 20);
        _add("all zeros, T=1", zeros, zeros, 1);
        _add("perfect, T=1", real, real, 1);
        _add("perfect, T=uint32.max", real, real, type(uint32).max);
        _add("flat baseline, T=1", zeros, real, 1);
        _add("flat baseline, T=uint32.max", zeros, real, type(uint32).max);

        // negative values
        Candle[3] memory neg = _p([int32(-10), 0, -12, -25, -10, -30, -5, 0, -30]);
        Candle[3] memory negPred = _p([int32(-8), 1, -9, -30, -8, -31, -10, -2, -32]);
        _add("negative path", negPred, neg, 15);
        _add("negative vs positive", neg, real, 20);
        _add("positive vs negative", real, neg, 7);

        // direction term in isolation (T = uint32.max forces C = R = 10000)
        uint32 big = type(uint32).max;
        Candle[3] memory flatReal = _p([int32(0), 2, -2, 10, 10, 0, 20, 21, 10]);
        Candle[3] memory flatPred = _p([int32(0), 1, -1, 10, 10, 0, 20, 21, 10]);
        Candle[3] memory upPred = _p([int32(1), 1, 0, 10, 10, 0, 20, 21, 10]);
        _add("both flat", flatPred, flatReal, big);
        _add("pred up, real flat", upPred, flatReal, big);
        _add("pred flat, real up", flatReal, upPred, big);
        _add(
            "opposite direction",
            _p([int32(-5), 0, -5, 10, 10, -5, 15, 16, 10]),
            _p([int32(5), 6, 0, 10, 10, 5, 15, 16, 10]),
            big
        );

        // rounding boundaries of C and R
        _add(
            "dc equals T",
            _p([int32(30), 30, 0, 30, 30, 30, 30, 30, 30]),
            _p([int32(10), 12, 0, 20, 22, 8, 30, 32, 18]),
            20
        );
        _add("dc one below T, T=3", _p([int32(2), 2, 0, 2, 2, 2, 2, 2, 2]), _p([int32(0), 0, 0, 0, 0, 0, 0, 0, 0]), 3);
        _add("range error far past clamp", _p([int32(0), 1000, -1000, 0, 1000, -1000, 0, 1000, -1000]), zeros, 5);
        _add("T=1 one bp high error", _withHigh(real, 13), real, 1);

        // extremes (int32 min/max: int32 arithmetic would overflow)
        _add("max vs min, T=1", _fill(MAX), _fill(MIN), 1);
        _add("min vs max, T=uint32.max", _fill(MIN), _fill(MAX), big);
        _add("max vs min, T=uint32.max", _fill(MAX), _fill(MIN), big);
        _add("max vs zero, T=uint32.max", _fill(MAX), zeros, big);
        Candle[3] memory alt = _p([MAX, MAX, 0, MIN, MAX, MIN, MAX, MAX, MIN]);
        _add("alternating extremes identical, T=1", alt, alt, 1);
        _add("alternating extremes vs zeros, T=1", alt, zeros, 1);
        _add("alternating extremes vs zeros, T=uint32.max", alt, zeros, big);

        // invalid paths (isValid false); score is still defined
        _add("invalid pred: high below close", _p([int32(10), 8, 0, 20, 22, 8, 30, 32, 18]), real, 20);
        _add("invalid pred: low above open", _p([int32(10), 12, 5, 20, 22, 8, 30, 32, 18]), real, 20);
        // each isValid clause in isolation (all other candles valid)
        _add("invalid pred: low above close (down candle)", _p([int32(-10), 0, -5, 20, 22, -10, 30, 32, 18]), real, 20);
        _add(
            "invalid pred: high below open (down candle)", _p([int32(-10), -1, -10, 20, 22, -10, 30, 32, 18]), real, 20
        );
        _add("invalid pred: candle 3 low above close", _p([int32(10), 12, -2, 20, 22, 8, 5, 20, 10]), real, 20);
        _add("invalid pred: candle 3 high below open", _p([int32(10), 12, -2, 20, 22, 8, 5, 19, 0]), real, 20);
        _add("invalid pred: candle 3 high below close", _p([int32(10), 12, -2, 20, 22, 8, 30, 29, 18]), real, 20);
        _add(
            "valid pred: down candle, wicks at open and close",
            _p([int32(-10), 0, -10, 20, 22, -10, 30, 32, 18]),
            real,
            20
        );
        _add("invalid real: candle 3 low above open", real, _p([int32(10), 12, -2, 20, 22, 8, 30, 32, 25]), 20);
    }

    // ----------------------------------------------------------------- random

    function _random() internal {
        for (uint256 i = 0; i < 48; i++) {
            bytes32 seed = keccak256(abi.encode("consensus-path/score-vectors", i));
            int256 scale = int256(uint256(1) << (3 + 5 * (i % 6))); // 8 .. 2^28
            Candle[3] memory real = _randPath(seed, scale);
            Candle[3] memory pred;
            if (i % 2 == 0) {
                pred = _randPath(keccak256(abi.encode(seed, "pred")), scale);
            } else {
                pred = _perturb(keccak256(abi.encode(seed, "noise")), real, scale / 8 + 1);
            }
            if (i % 7 == 3) pred[1].high = pred[1].low - 1; // make some paths invalid
            uint256 r = uint256(keccak256(abi.encode(seed, "T")));
            uint32 T = i % 11 == 0 ? type(uint32).max : uint32(r % (uint256(scale) * 2)) + 1;
            _add(string.concat("random ", vm.toString(i)), pred, real, T);
        }
    }

    /// @dev Valid path with closes in [-scale, scale] and wicks up to `scale`.
    function _randPath(bytes32 seed, int256 scale) internal pure returns (Candle[3] memory p) {
        int256 open = 0;
        for (uint256 i = 0; i < 3; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            int256 close = int256(r % uint256(2 * scale + 1)) - scale;
            int256 up = int256((r >> 64) % uint256(scale + 1));
            int256 down = int256((r >> 128) % uint256(scale + 1));
            p[i] = _mk(open, close, up, down);
            open = close;
        }
    }

    /// @dev Valid path whose closes are `real` closes plus noise in [-noise, noise].
    function _perturb(bytes32 seed, Candle[3] memory real, int256 noise) internal pure returns (Candle[3] memory p) {
        int256 open = 0;
        for (uint256 i = 0; i < 3; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            int256 close = int256(real[i].close) + int256(r % uint256(2 * noise + 1)) - noise;
            int256 up = int256((r >> 64) % uint256(noise + 1));
            int256 down = int256((r >> 128) % uint256(noise + 1));
            p[i] = _mk(open, close, up, down);
            open = close;
        }
    }

    function _mk(int256 open, int256 close, int256 up, int256 down) internal pure returns (Candle memory) {
        int256 hi = (open > close ? open : close) + up;
        int256 lo = (open < close ? open : close) - down;
        return Candle(int32(close), int32(hi), int32(lo));
    }

    // ---------------------------------------------------------------- helpers

    function _p(int32[9] memory v) internal pure returns (Candle[3] memory p) {
        p[0] = Candle(v[0], v[1], v[2]);
        p[1] = Candle(v[3], v[4], v[5]);
        p[2] = Candle(v[6], v[7], v[8]);
    }

    function _fill(int32 v) internal pure returns (Candle[3] memory p) {
        p[0] = Candle(v, v, v);
        p[1] = Candle(v, v, v);
        p[2] = Candle(v, v, v);
    }

    function _withHigh(Candle[3] memory src, int32 high0) internal pure returns (Candle[3] memory p) {
        // Copy field by field: `p[i] = src[i]` between memory structs copies a reference,
        // so the write below would also mutate `src`.
        for (uint256 i = 0; i < 3; i++) {
            p[i] = Candle(src[i].close, src[i].high, src[i].low);
        }
        p[0].high = high0;
    }

    function _add(string memory name, Candle[3] memory pred, Candle[3] memory real, uint32 T) internal {
        string memory row = string.concat(
            "{\"name\":\"",
            name,
            "\",\"T\":",
            vm.toString(uint256(T)),
            ",\"pred\":",
            _path(pred),
            ",\"real\":",
            _path(real),
            ",\"predValid\":",
            ScoreLib.isValid(pred) ? "true" : "false",
            ",\"realValid\":",
            ScoreLib.isValid(real) ? "true" : "false",
            ",\"score\":",
            vm.toString(uint256(ScoreLib.score(pred, real, T))),
            "}"
        );
        body = count == 0 ? string.concat("  ", row) : string.concat(body, ",\n  ", row);
        count++;
    }

    function _path(Candle[3] memory p) internal pure returns (string memory) {
        return string.concat("[", _candle(p[0]), ",", _candle(p[1]), ",", _candle(p[2]), "]");
    }

    function _candle(Candle memory c) internal pure returns (string memory) {
        return string.concat(
            "{\"close\":",
            vm.toString(int256(c.close)),
            ",\"high\":",
            vm.toString(int256(c.high)),
            ",\"low\":",
            vm.toString(int256(c.low)),
            "}"
        );
    }
}
