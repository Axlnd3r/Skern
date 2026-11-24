// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Points} from "../src/Points.sol";

contract PointsTest is Test {
    event Minted(address indexed to, uint256 amt);
    event Spent(address indexed from, uint256 amt);
    event MinterSet(address indexed who, bool allowed);
    event SpenderSet(address indexed who, bool allowed);
    event RolesLocked();

    Points internal points;
    address internal minter = address(0x4D1);
    address internal spender = address(0x5E1);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        points = new Points(address(this));
        points.setMinter(minter, true);
        points.setSpender(spender, true);
    }

    // ------------------------------------------------------------ constructor

    function test_ownerIsSet() public view {
        assertEq(points.owner(), address(this));
        assertFalse(points.rolesLocked());
    }

    function test_constructorRejectsZeroOwner() public {
        vm.expectRevert(Points.ZeroAddress.selector);
        new Points(address(0));
    }

    // ------------------------------------------------------------ mint / spend

    function test_onlyMinterMints() public {
        vm.prank(alice);
        vm.expectRevert(Points.NotMinter.selector);
        points.mint(alice, 10);
        assertEq(points.balanceOf(alice), 0);
        assertEq(points.totalSupply(), 0);

        // The owner is not a minter unless granted the role.
        vm.expectRevert(Points.NotMinter.selector);
        points.mint(alice, 10);

        // A spender is not a minter.
        vm.prank(spender);
        vm.expectRevert(Points.NotMinter.selector);
        points.mint(alice, 10);
    }

    function test_mintIncreasesBalanceAndSupplyAndEmits() public {
        vm.expectEmit(true, false, false, true, address(points));
        emit Minted(alice, 70);
        vm.prank(minter);
        points.mint(alice, 70);

        vm.prank(minter);
        points.mint(bob, 5);
        vm.prank(minter);
        points.mint(alice, 1);

        assertEq(points.balanceOf(alice), 71);
        assertEq(points.balanceOf(bob), 5);
        assertEq(points.totalSupply(), 76);
    }

    function test_onlySpenderSpends() public {
        vm.prank(minter);
        points.mint(alice, 50);

        vm.prank(alice);
        vm.expectRevert(Points.NotSpender.selector);
        points.spend(alice, 10);

        vm.prank(minter);
        vm.expectRevert(Points.NotSpender.selector);
        points.spend(alice, 10);

        assertEq(points.balanceOf(alice), 50);
        assertEq(points.totalSupply(), 50);
    }

    function test_spendBurnsBalanceAndSupplyAndEmits() public {
        vm.startPrank(minter);
        points.mint(alice, 50);
        points.mint(bob, 20);
        vm.stopPrank();

        vm.expectEmit(true, false, false, true, address(points));
        emit Spent(alice, 30);
        vm.prank(spender);
        points.spend(alice, 30);

        assertEq(points.balanceOf(alice), 20);
        assertEq(points.balanceOf(bob), 20);
        assertEq(points.totalSupply(), 40);
    }

    function test_spendEntireBalance() public {
        vm.prank(minter);
        points.mint(alice, 50);
        vm.prank(spender);
        points.spend(alice, 50);
        assertEq(points.balanceOf(alice), 0);
        assertEq(points.totalSupply(), 0);
    }

    function test_spendBeyondBalanceReverts() public {
        vm.prank(minter);
        points.mint(alice, 50);

        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(Points.InsufficientBalance.selector, 50, 51));
        points.spend(alice, 51);

        assertEq(points.balanceOf(alice), 50);
        assertEq(points.totalSupply(), 50);
    }

    function test_addressCanHoldBothRoles() public {
        address both = address(0xB07);
        points.setMinter(both, true);
        points.setSpender(both, true);
        vm.startPrank(both);
        points.mint(alice, 10);
        points.spend(alice, 4);
        vm.stopPrank();
        assertEq(points.balanceOf(alice), 6);
    }

    // ------------------------------------------------------------ non-transferable

    function test_pointsNotTransferable() public {
        vm.prank(minter);
        points.mint(alice, 100);

        vm.startPrank(alice);
        vm.expectRevert(Points.NonTransferable.selector);
        points.transfer(bob, 10);
        vm.expectRevert(Points.NonTransferable.selector);
        points.approve(bob, 10);
        vm.expectRevert(Points.NonTransferable.selector);
        points.transferFrom(alice, bob, 10);
        vm.stopPrank();

        // Even the owner, a minter and a spender cannot move points.
        vm.expectRevert(Points.NonTransferable.selector);
        points.transfer(bob, 0);
        vm.prank(minter);
        vm.expectRevert(Points.NonTransferable.selector);
        points.transferFrom(alice, bob, 1);
        vm.prank(spender);
        vm.expectRevert(Points.NonTransferable.selector);
        points.transferFrom(alice, bob, 1);

        assertEq(points.balanceOf(alice), 100);
        assertEq(points.balanceOf(bob), 0);
        assertEq(points.totalSupply(), 100);
    }

    // ------------------------------------------------------------ roles

    function test_setMinterOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(Points.NotOwner.selector);
        points.setMinter(alice, true);
        assertFalse(points.isMinter(alice));
    }

    function test_setSpenderOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(Points.NotOwner.selector);
        points.setSpender(alice, true);
        assertFalse(points.isSpender(alice));
    }

    function test_lockRolesOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(Points.NotOwner.selector);
        points.lockRoles();
        assertFalse(points.rolesLocked());
    }

    function test_setRolesAddAndRevokeBeforeLock() public {
        vm.expectEmit(true, false, false, true, address(points));
        emit MinterSet(alice, true);
        points.setMinter(alice, true);
        assertTrue(points.isMinter(alice));

        vm.expectEmit(true, false, false, true, address(points));
        emit MinterSet(alice, false);
        points.setMinter(alice, false);
        assertFalse(points.isMinter(alice));

        vm.expectEmit(true, false, false, true, address(points));
        emit SpenderSet(alice, true);
        points.setSpender(alice, true);
        assertTrue(points.isSpender(alice));

        vm.expectEmit(true, false, false, true, address(points));
        emit SpenderSet(alice, false);
        points.setSpender(alice, false);
        assertFalse(points.isSpender(alice));

        // A revoked minter can no longer mint.
        vm.prank(minter);
        points.mint(alice, 1);
        points.setMinter(minter, false);
        vm.prank(minter);
        vm.expectRevert(Points.NotMinter.selector);
        points.mint(alice, 1);
    }

    function test_setRolesRejectZeroAddress() public {
        vm.expectRevert(Points.ZeroAddress.selector);
        points.setMinter(address(0), true);
        vm.expectRevert(Points.ZeroAddress.selector);
        points.setSpender(address(0), true);
    }

    function test_lockRolesFreezesRoleChanges() public {
        vm.expectEmit(false, false, false, true, address(points));
        emit RolesLocked();
        points.lockRoles();
        assertTrue(points.rolesLocked());

        vm.expectRevert(Points.RolesAreLocked.selector);
        points.setMinter(alice, true);
        vm.expectRevert(Points.RolesAreLocked.selector);
        points.setMinter(minter, false);
        vm.expectRevert(Points.RolesAreLocked.selector);
        points.setSpender(alice, true);
        vm.expectRevert(Points.RolesAreLocked.selector);
        points.setSpender(spender, false);
        vm.expectRevert(Points.RolesAreLocked.selector);
        points.lockRoles();

        assertFalse(points.isMinter(alice));
        assertFalse(points.isSpender(alice));
        assertTrue(points.isMinter(minter));
        assertTrue(points.isSpender(spender));
    }

    function test_ownerCannotMintToItselfAfterLock() public {
        points.lockRoles();
        vm.expectRevert(Points.NotMinter.selector);
        points.mint(address(this), 1_000_000);
        assertEq(points.totalSupply(), 0);
    }

    function test_existingRolesStillWorkAfterLock() public {
        points.lockRoles();
        vm.prank(minter);
        points.mint(alice, 9);
        vm.prank(spender);
        points.spend(alice, 4);
        assertEq(points.balanceOf(alice), 5);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_supplyEqualsSumOfBalances(uint96 a, uint96 b, uint96 s) public {
        vm.startPrank(minter);
        points.mint(alice, a);
        points.mint(bob, b);
        vm.stopPrank();
        uint256 burn = bound(s, 0, a);
        vm.prank(spender);
        points.spend(alice, burn);
        assertEq(points.balanceOf(alice), uint256(a) - burn);
        assertEq(points.totalSupply(), points.balanceOf(alice) + points.balanceOf(bob));
    }
}
