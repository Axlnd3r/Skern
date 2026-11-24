// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Points} from "../src/Points.sol";
import {Registry, Kind} from "../src/Registry.sol";
import {AllowlistGate} from "../src/AllowlistGate.sol";
import {IHumanGate} from "../src/interfaces/IHumanGate.sol";
import {IArenaState} from "../src/interfaces/IArenaState.sol";

contract MockArena is IArenaState {
    bool public open;

    function setOpen(bool v) external {
        open = v;
    }

    function anyCommitWindowOpen() external view returns (bool) {
        return open;
    }
}

contract RegistryTest is Test {
    event Registered(address indexed who, Kind kind, string metadataURI);
    event Reclassified(address indexed who, Kind oldKind, Kind newKind);
    event GateChanged(IHumanGate gate);
    event ArenaSet(IArenaState arena);

    Points internal points;
    AllowlistGate internal gate;
    Registry internal registry;
    MockArena internal arena;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA201);

    function setUp() public {
        points = new Points(address(this));
        gate = new AllowlistGate(address(this));
        registry = new Registry(points, gate, address(this));
        arena = new MockArena();
        points.setMinter(address(registry), true);
        points.setSpender(address(registry), true);
        gate.setAllowed(alice, true);
    }

    function _wireArena() internal {
        registry.setArena(arena);
    }

    // ------------------------------------------------------------ constructor

    function test_constants() public view {
        assertEq(registry.STARTER_GRANT(), 1000);
        assertEq(registry.AGENT_BOND(), 100);
        assertEq(registry.owner(), address(this));
        assertEq(address(registry.points()), address(points));
        assertEq(address(registry.gate()), address(gate));
        assertEq(address(registry.arena()), address(0));
    }

    function test_constructorRejectsZeroArgs() public {
        vm.expectRevert(Registry.ZeroAddress.selector);
        new Registry(Points(address(0)), gate, address(this));
        vm.expectRevert(Registry.ZeroAddress.selector);
        new Registry(points, IHumanGate(address(0)), address(this));
        vm.expectRevert(Registry.ZeroAddress.selector);
        new Registry(points, gate, address(0));
    }

    // ------------------------------------------------------------ registerHuman

    function test_registerHumanRequiresGate() public {
        vm.prank(bob); // not on the allowlist
        vm.expectRevert(Registry.NotHuman.selector);
        registry.registerHuman();
        assertEq(uint8(registry.kindOf(bob)), uint8(Kind.None));
        assertEq(points.balanceOf(bob), 0);

        vm.prank(alice);
        registry.registerHuman();
        assertEq(uint8(registry.kindOf(alice)), uint8(Kind.Human));
    }

    function test_registerGrantsStarterPoints() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit Registered(alice, Kind.Human, "");
        vm.prank(alice);
        registry.registerHuman();

        assertEq(points.balanceOf(alice), 1000);
        assertEq(points.totalSupply(), 1000);
        assertEq(registry.metadataURI(alice), "");
    }

    // ------------------------------------------------------------ registerAgent

    function test_registerAgentTakesBondAndStoresURI() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit Registered(bob, Kind.Agent, "ipfs://agent-bob");
        vm.prank(bob);
        registry.registerAgent("ipfs://agent-bob");

        assertEq(uint8(registry.kindOf(bob)), uint8(Kind.Agent));
        assertEq(registry.metadataURI(bob), "ipfs://agent-bob");
        // Grant of 1000 minted first, then the 100 bond burned.
        assertEq(points.balanceOf(bob), 900);
        assertEq(points.totalSupply(), 900);
    }

    function test_agentDoesNotNeedGate() public {
        assertFalse(gate.isHuman(carol));
        vm.prank(carol);
        registry.registerAgent("x");
        assertEq(uint8(registry.kindOf(carol)), uint8(Kind.Agent));
    }

    function test_registerAgentRevertsWithoutSpenderRole() public {
        points.setSpender(address(registry), false);
        vm.prank(bob);
        vm.expectRevert(Points.NotSpender.selector);
        registry.registerAgent("x");
        // The whole call reverted, so the registration did not stick.
        assertEq(uint8(registry.kindOf(bob)), uint8(Kind.None));
        assertEq(points.balanceOf(bob), 0);
    }

    // ------------------------------------------------------------ double registration

    function test_cannotRegisterTwice() public {
        // human twice
        vm.startPrank(alice);
        registry.registerHuman();
        vm.expectRevert(Registry.AlreadyRegistered.selector);
        registry.registerHuman();
        // human then agent
        vm.expectRevert(Registry.AlreadyRegistered.selector);
        registry.registerAgent("x");
        vm.stopPrank();
        assertEq(points.balanceOf(alice), 1000);

        // agent twice
        vm.startPrank(bob);
        registry.registerAgent("a");
        vm.expectRevert(Registry.AlreadyRegistered.selector);
        registry.registerAgent("b");
        // agent then human (bob is also allowlisted)
        vm.stopPrank();
        gate.setAllowed(bob, true);
        vm.prank(bob);
        vm.expectRevert(Registry.AlreadyRegistered.selector);
        registry.registerHuman();

        assertEq(registry.metadataURI(bob), "a");
        assertEq(uint8(registry.kindOf(bob)), uint8(Kind.Agent));
        assertEq(points.balanceOf(bob), 900);
    }

    // ------------------------------------------------------------ gate

    function test_setGateOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(Registry.NotOwner.selector);
        registry.setGate(IHumanGate(address(1)));
        assertEq(address(registry.gate()), address(gate));
    }

    function test_setGateRejectsZero() public {
        vm.expectRevert(Registry.ZeroAddress.selector);
        registry.setGate(IHumanGate(address(0)));
    }

    function test_setGateSwapsAndEmits() public {
        AllowlistGate other = new AllowlistGate(address(this));
        other.setAllowed(carol, true);

        vm.expectEmit(false, false, false, true, address(registry));
        emit GateChanged(other);
        registry.setGate(other);
        assertEq(address(registry.gate()), address(other));

        // alice was allowed by the old gate only, carol by the new gate only.
        vm.prank(alice);
        vm.expectRevert(Registry.NotHuman.selector);
        registry.registerHuman();
        vm.prank(carol);
        registry.registerHuman();
        assertEq(uint8(registry.kindOf(carol)), uint8(Kind.Human));
    }

    // ------------------------------------------------------------ arena (set-once)

    function test_setArenaOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(Registry.NotOwner.selector);
        registry.setArena(arena);
        assertEq(address(registry.arena()), address(0));
    }

    function test_setArenaRejectsZero() public {
        vm.expectRevert(Registry.ZeroAddress.selector);
        registry.setArena(IArenaState(address(0)));
    }

    function test_setArenaIsSetOnce() public {
        vm.expectEmit(false, false, false, true, address(registry));
        emit ArenaSet(arena);
        registry.setArena(arena);
        assertEq(address(registry.arena()), address(arena));

        MockArena other = new MockArena();
        vm.expectRevert(Registry.ArenaAlreadySet.selector);
        registry.setArena(other);
        // Re-setting the same address also reverts.
        vm.expectRevert(Registry.ArenaAlreadySet.selector);
        registry.setArena(arena);
        assertEq(address(registry.arena()), address(arena));
    }

    // ------------------------------------------------------------ reclassify

    function _registerAliceHumanBobAgent() internal {
        vm.prank(alice);
        registry.registerHuman();
        vm.prank(bob);
        registry.registerAgent("a");
    }

    function test_reclassifyRevertsBeforeArenaSet() public {
        _registerAliceHumanBobAgent();
        vm.expectRevert(Registry.ArenaNotSet.selector);
        registry.reclassify(alice, Kind.Agent);
        assertEq(uint8(registry.kindOf(alice)), uint8(Kind.Human));
    }

    function test_reclassifyBlockedDuringCommitWindow() public {
        _registerAliceHumanBobAgent();
        _wireArena();
        arena.setOpen(true);

        vm.expectRevert(Registry.CommitWindowOpen.selector);
        registry.reclassify(alice, Kind.Agent);
        assertEq(uint8(registry.kindOf(alice)), uint8(Kind.Human));

        arena.setOpen(false);
        registry.reclassify(alice, Kind.Agent);
        assertEq(uint8(registry.kindOf(alice)), uint8(Kind.Agent));
    }

    function test_reclassifyEmitsEvent() public {
        _registerAliceHumanBobAgent();
        _wireArena();

        vm.expectEmit(true, false, false, true, address(registry));
        emit Reclassified(alice, Kind.Human, Kind.Agent);
        registry.reclassify(alice, Kind.Agent);

        vm.expectEmit(true, false, false, true, address(registry));
        emit Reclassified(bob, Kind.Agent, Kind.Human);
        registry.reclassify(bob, Kind.Human);

        assertEq(uint8(registry.kindOf(alice)), uint8(Kind.Agent));
        assertEq(uint8(registry.kindOf(bob)), uint8(Kind.Human));
    }

    function test_reclassifyDoesNotChangeBalancesOrURI() public {
        _registerAliceHumanBobAgent();
        _wireArena();
        uint256 supply = points.totalSupply();
        registry.reclassify(bob, Kind.Human);
        assertEq(points.balanceOf(bob), 900);
        assertEq(points.balanceOf(alice), 1000);
        assertEq(points.totalSupply(), supply);
        assertEq(registry.metadataURI(bob), "a");
    }

    function test_reclassifyOnlyOwner() public {
        _registerAliceHumanBobAgent();
        _wireArena();
        vm.prank(alice);
        vm.expectRevert(Registry.NotOwner.selector);
        registry.reclassify(alice, Kind.Agent);
        assertEq(uint8(registry.kindOf(alice)), uint8(Kind.Human));
    }

    function test_reclassifyToNoneReverts() public {
        _registerAliceHumanBobAgent();
        _wireArena();
        vm.expectRevert(Registry.InvalidKind.selector);
        registry.reclassify(alice, Kind.None);
        assertEq(uint8(registry.kindOf(alice)), uint8(Kind.Human));
    }

    function test_reclassifyUnregisteredReverts() public {
        _wireArena();
        vm.expectRevert(Registry.NotRegistered.selector);
        registry.reclassify(carol, Kind.Agent);
        vm.expectRevert(Registry.NotRegistered.selector);
        registry.reclassify(carol, Kind.Human);
        assertEq(uint8(registry.kindOf(carol)), uint8(Kind.None));
    }

    function test_reclassifySameKindReverts() public {
        _registerAliceHumanBobAgent();
        _wireArena();
        vm.expectRevert(Registry.SameKind.selector);
        registry.reclassify(alice, Kind.Human);
        vm.expectRevert(Registry.SameKind.selector);
        registry.reclassify(bob, Kind.Agent);
    }
}
