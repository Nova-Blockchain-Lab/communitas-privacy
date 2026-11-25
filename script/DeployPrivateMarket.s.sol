// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PrivateEnergyBiddingMarket} from "../src/PrivateEnergyBiddingMarket.sol";

/// Deploys a fresh PrivateEnergyBiddingMarket proxy and a new Semaphore group for it. The deployer is the
/// market owner, the group admin (the admission service adds members) and a whitelisted seller (demo only).
/// Env: DEPLOYER_PRIVATE_KEY; SEMAPHORE (optional, reuse an existing Semaphore; deploys one if unset).
contract DeployPrivateMarket is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        vm.startBroadcast(key);
        address semaphore = vm.envOr("SEMAPHORE", address(0));
        if (semaphore == address(0)) {
            semaphore = address(new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier()))));
        }
        uint256 groupId = ISemaphore(semaphore).createGroup(deployer);
        PrivateEnergyBiddingMarket impl = new PrivateEnergyBiddingMarket();
        PrivateEnergyBiddingMarket market = PrivateEnergyBiddingMarket(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(impl.initializePrivate, (deployer, ISemaphore(semaphore), groupId))
                )
            )
        );
        market.whitelistSeller(deployer, true);
        vm.stopBroadcast();
        console.log("Semaphore", semaphore);
        console.log("groupId", groupId);
        console.log("PrivateEnergyBiddingMarket implementation", address(impl));
        console.log("PrivateEnergyBiddingMarket proxy", address(market));
    }
}
