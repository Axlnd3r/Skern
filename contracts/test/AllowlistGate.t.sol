// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AllowlistGate} from "../src/AllowlistGate.sol";

contract AllowlistGateTest is Test {
    event Allowed(address indexed who, bool allowed);

    AllowlistGate internal gate;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        gate = new AllowlistGate(address(this));
    }

    function test_ownerIsSet() public view {
        assertEq(gate.owner(), address(this));
    }

    function test_constructorRejectsZeroOwner() public {
        vm.expectRevert(AllowlistGate.ZeroAddress.selector);
        new AllowlistGate(address(0));
    }

    function test_defaultIsNotHuman() public view {
        assertFalse(gate.isHuman(alice));
    }

    function test_setAllowedTrueAndFalse() public {
        gate.setAllowed(alice, true);
        assertTrue(gate.isHuman(alice));
        assertFalse(gate.isHuman(bob));

        gate.setAllowed(alice, false);
        assertFalse(gate.isHuman(alice));
    }

    function test_setAllowedEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(gate));
        emit Allowed(alice, true);
        gate.setAllowed(alice, true);

        vm.expectEmit(true, false, false, true, address(gate));
        emit Allowed(alice, false);
        gate.setAllowed(alice, false);
    }

    function test_setAllowedOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(AllowlistGate.NotOwner.selector);
        gate.setAllowed(alice, true);
        assertFalse(gate.isHuman(alice));
    }
}
