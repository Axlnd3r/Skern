// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Points} from "../src/Points.sol";
import {AllowlistGate} from "../src/AllowlistGate.sol";
import {Registry} from "../src/Registry.sol";
import {Arena} from "../src/Arena.sol";
import {GapMarket} from "../src/GapMarket.sol";

/// @title Deploy
/// @notice Deploys and wires the whole Consensus Path contract set. Base Sepolia (84532) and a local
///         chain (31337) only: points only, no real money.
/// @dev Usage (testnet key from `.env`, never committed):
///        forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
///      Inside a forge script `msg.sender` in `run()` is NOT the broadcast key, so `run()` derives the
///      owner from `PRIVATE_KEY` and passes it to `deploy`, which holds all the wiring. The test calls
///      the same `deploy`, so the wiring exists exactly once.
///
///      Privileged calls and how they are handled (`grep onlyOwner src/`):
///        Points.setMinter   : Registry (registration grant), Arena (claim and void refunds), GapMarket (payouts)
///        Points.setSpender  : Registry (agent bond), Arena (entry stake), GapMarket (bets)
///        Points.lockRoles   : called LAST, one-way
///        Registry.setArena  : set-once, called with the real Arena
///        Arena.setKeeper    : set-once, called here only when a keeper address is given
///        Registry.setGate / Registry.reclassify / AllowlistGate.setAllowed : operational, stay with the owner
///      GapMarket has no owner and no admin function.
contract Deploy is Script {
    error WrongChain(uint256 chainId);

    uint256 internal constant BASE_SEPOLIA = 84532;
    uint256 internal constant LOCAL = 31337;

    Points public points;
    AllowlistGate public gate;
    Registry public registry;
    Arena public arena;
    GapMarket public market;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(pk);
        // Optional. `Arena.setKeeper` is set-once, so a wrong value cannot be fixed without a redeploy;
        // when it is unset the owner calls `setKeeper` later.
        address keeper = vm.envOr("KEEPER_ADDRESS", address(0));

        vm.startBroadcast(pk);
        deploy(owner, keeper);
        vm.stopBroadcast();

        console2.log("owner      ", owner);
        console2.log("keeper     ", keeper);
        console2.log("Points     ", address(points));
        console2.log("AllowlistGate", address(gate));
        console2.log("Registry   ", address(registry));
        console2.log("Arena      ", address(arena));
        console2.log("GapMarket  ", address(market));
        if (keeper == address(0)) console2.log("keeper not set: owner must call Arena.setKeeper");
    }

    /// @dev Every call below must be made by `owner` (the broadcaster in a script, a prank in a test),
    ///      otherwise the owner-only wiring reverts.
    function deploy(address owner, address keeper) public {
        // forge-lint: disable-next-line(environment-read-across-mutation)
        uint256 chainId = block.chainid;
        if (chainId != BASE_SEPOLIA && chainId != LOCAL) revert WrongChain(chainId);

        points = new Points(owner);
        gate = new AllowlistGate(owner);
        registry = new Registry(points, gate, owner);
        arena = new Arena(points, registry, owner);
        registry.setArena(arena);
        market = new GapMarket(arena);

        points.setMinter(address(registry), true);
        points.setSpender(address(registry), true);
        points.setMinter(address(arena), true);
        points.setSpender(address(arena), true);
        points.setMinter(address(market), true);
        points.setSpender(address(market), true);

        if (keeper != address(0)) arena.setKeeper(keeper);

        // Last: after this no role can be granted or revoked any more.
        points.lockRoles();
    }
}
