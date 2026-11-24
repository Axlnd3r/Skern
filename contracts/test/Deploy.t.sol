// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Points} from "../src/Points.sol";
import {Registry, Kind} from "../src/Registry.sol";
import {Candle} from "../src/ScoreLib.sol";
import {Arena, RoundParams} from "../src/Arena.sol";
import {GapMarket, Side} from "../src/GapMarket.sol";

/// @dev Runs the exact `deploy(owner, keeper)` of the script, with every call made by `owner` (the same
///      role the broadcaster plays in `forge script`).
contract DeployTest is Test, Deploy {
    address internal owner = address(0x0BB1E);
    address internal keeper = address(0x4EE9E4);
    address internal stranger = address(0x57A9);

    function setUp() public {
        vm.warp(1_000_000);
        vm.startPrank(owner);
        deploy(owner, keeper);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ roles

    function test_rolesAreLocked() public view {
        assertTrue(points.rolesLocked());
    }

    function test_exactRoleSet() public view {
        address[3] memory yes = [address(registry), address(arena), address(market)];
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(points.isMinter(yes[i]), "minter");
            assertTrue(points.isSpender(yes[i]), "spender");
        }
        // Points has no role enumeration, so the negatives define the exact set.
        address[8] memory no =
            [owner, address(this), keeper, stranger, address(points), address(gate), address(0), address(0xdead)];
        for (uint256 i = 0; i < no.length; i++) {
            assertFalse(points.isMinter(no[i]), "unexpected minter");
            assertFalse(points.isSpender(no[i]), "unexpected spender");
        }
    }

    function test_ownerCannotChangeRolesAfterLock() public {
        vm.startPrank(owner);
        vm.expectRevert(Points.RolesAreLocked.selector);
        points.setMinter(owner, true);
        vm.expectRevert(Points.RolesAreLocked.selector);
        points.setSpender(owner, true);
        vm.expectRevert(Points.RolesAreLocked.selector);
        points.setMinter(address(registry), false);
        vm.expectRevert(Points.RolesAreLocked.selector);
        points.lockRoles();
        vm.stopPrank();
        assertFalse(points.isMinter(owner));
        assertFalse(points.isSpender(owner));
        assertTrue(points.isMinter(address(registry)));
    }

    // ------------------------------------------------------------ wiring

    function test_wiring() public view {
        assertEq(address(registry.arena()), address(arena));
        assertEq(address(arena.registry()), address(registry));
        assertEq(address(registry.points()), address(points));
        assertEq(address(arena.points()), address(points));
        assertEq(address(market.points()), address(arena.points()));
        assertEq(address(market.arena()), address(arena));
        assertEq(address(registry.gate()), address(gate));
    }

    function test_ownersAreTheOwnerNotTheDeployerContract() public view {
        assertEq(points.owner(), owner);
        assertEq(gate.owner(), owner);
        assertEq(registry.owner(), owner);
        assertEq(arena.owner(), owner);
        assertTrue(owner != address(this));
    }

    function test_keeperIsSet() public view {
        assertEq(arena.keeper(), keeper);
    }

    function test_noKeeperLeavesSetKeeperToOwner() public {
        vm.startPrank(owner);
        deploy(owner, address(0));
        vm.stopPrank();
        assertEq(arena.keeper(), address(0));
        vm.prank(owner);
        arena.setKeeper(keeper);
        assertEq(arena.keeper(), keeper);
    }

    /// @dev The footgun the script avoids: if the caller is not `owner`, the owner-only wiring reverts.
    function test_deployRevertsWhenCallerIsNotOwner() public {
        vm.expectRevert(Points.NotOwner.selector);
        this.deploy(owner, keeper);
    }

    // ------------------------------------------------------------ chain guard

    function test_chainGuardRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(WrongChain.selector, 1));
        this.deploy(owner, keeper);
        vm.chainId(8453); // Base mainnet must be rejected too
        vm.expectRevert(abi.encodeWithSelector(WrongChain.selector, 8453));
        this.deploy(owner, keeper);
    }

    function test_chainGuardAcceptsBaseSepoliaAndLocal() public {
        vm.chainId(84532);
        vm.startPrank(owner);
        deploy(owner, keeper);
        vm.stopPrank();
        assertTrue(points.rolesLocked());
        vm.chainId(31337);
        vm.startPrank(owner);
        deploy(owner, keeper);
        vm.stopPrank();
        assertTrue(points.rolesLocked());
    }

    // ------------------------------------------------------------ smoke: the deployed set works end to end

    function _path() internal pure returns (Candle[3] memory p) {
        p[0] = Candle(10, 12, -2);
        p[1] = Candle(20, 22, 8);
        p[2] = Candle(30, 32, 18);
    }

    function _commitReveal(uint256 id, address who) internal {
        Candle[3] memory p = _path();
        bytes32 salt = keccak256(abi.encode("salt", id, who));
        bytes32 h = arena.hashPath(p, salt, who);
        vm.prank(who);
        arena.commit(id, h);
    }

    function test_smokeFlow() public {
        uint256 t0 = block.timestamp;
        address[3] memory hs = [address(0x1001), address(0x1002), address(0x1003)];
        address[3] memory ags = [address(0x2001), address(0x2002), address(0x2003)];

        // register: humans via the allowlist, agents with a bond
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(owner);
            gate.setAllowed(hs[i], true);
            vm.prank(hs[i]);
            registry.registerHuman();
            vm.prank(ags[i]);
            registry.registerAgent("ipfs://agent");
        }
        assertEq(points.balanceOf(hs[0]), registry.STARTER_GRANT());
        assertEq(points.balanceOf(ags[0]), registry.STARTER_GRANT() - registry.AGENT_BOND());
        assertEq(uint8(registry.kindOf(hs[0])), uint8(Kind.Human));
        assertEq(uint8(registry.kindOf(ags[0])), uint8(Kind.Agent));

        // the keeper (and nobody else) opens a round
        RoundParams memory rp = RoundParams({
            ticker: bytes32("AAPL"),
            p0: 19_000,
            T: 20,
            commitEnd: uint64(t0 + 100),
            revealEnd: uint64(t0 + 200),
            marketEnd: uint64(t0 + 300),
            candleSec: 60,
            settleDeadline: uint64(t0 + 1480),
            entryStake: 10
        });
        vm.prank(stranger);
        vm.expectRevert(Arena.NotKeeper.selector);
        arena.openRound(rp);
        vm.prank(keeper);
        uint256 id = arena.openRound(rp);

        for (uint256 i = 0; i < 3; i++) {
            _commitReveal(id, hs[i]);
            _commitReveal(id, ags[i]);
        }
        assertEq(points.balanceOf(hs[0]), 990); // entry stake burned through Arena's spender role

        vm.warp(t0 + 100);
        Candle[3] memory p = _path();
        for (uint256 i = 0; i < 3; i++) {
            arena.reveal(id, hs[i], p, keccak256(abi.encode("salt", id, hs[i])));
            arena.reveal(id, ags[i], p, keccak256(abi.encode("salt", id, ags[i])));
        }
        assertEq(arena.revealCount(id, Kind.Human), 3);
        assertEq(arena.revealCount(id, Kind.Agent), 3);

        // market opens (quorum + frozen consensus) and takes a bet through GapMarket's spender role
        vm.warp(t0 + 200);
        arena.freezeAll(id);
        vm.prank(hs[0]);
        market.bet(id, Side.Human, 50);
        vm.prank(ags[0]);
        market.bet(id, Side.Agent, 50);
        assertEq(points.balanceOf(hs[0]), 940);

        // settle: the keeper posts the candles (Arena), then both claim (minter roles of Arena and GapMarket)
        vm.warp(t0 + 480);
        vm.prank(keeper);
        arena.postCandles(id, p, keccak256("source"));
        assertTrue(arena.settled(id));
        // Both sides submitted the same path, so the scores are equal: tie, everyone is refunded.
        assertEq(market.status(id), 3);
        vm.prank(hs[0]);
        market.claim(id);
        assertEq(points.balanceOf(hs[0]), 990);
        vm.prank(hs[0]);
        arena.claim(id);
        // stake 10 back plus reward (100 - 29 baseline) * REWARD_PER_POINT = 71 (Task 2 vectors, T = 20)
        assertEq(points.balanceOf(hs[0]), 990 + 10 + 71);
    }
}
