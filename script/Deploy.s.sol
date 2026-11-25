// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";
import {HourlyGate} from "../src/HourlyGate.sol";

contract DeployScript is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        SemaphoreVerifier verifier = new SemaphoreVerifier();
        Semaphore semaphore = new Semaphore(ISemaphoreVerifier(address(verifier)));
        HourlyGate gate = new HourlyGate(semaphore);
        vm.stopBroadcast();
        console.log("SemaphoreVerifier", address(verifier));
        console.log("Semaphore", address(semaphore));
        console.log("HourlyGate", address(gate));
        console.log("groupId", gate.groupId());
    }
}
