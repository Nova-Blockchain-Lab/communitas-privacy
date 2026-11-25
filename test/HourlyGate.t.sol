// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";
import {HourlyGate} from "../src/HourlyGate.sol";

// Real proofs are checked end to end by scripts/prove.mjs (anvil, then the L3).
contract HourlyGateTest is Test {
    HourlyGate gate;

    function setUp() public {
        Semaphore s = new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier())));
        gate = new HourlyGate(s);
    }

    function test_onlyAdminAddsMembers() public {
        uint256[] memory c = new uint256[](1);
        c[0] = 1;
        vm.prank(address(0xBEEF));
        vm.expectRevert(HourlyGate.NotAdmin.selector);
        gate.addMembers(c);
        gate.addMembers(c);
    }

    function test_rejectsScopeFromAnotherHour() public {
        ISemaphore.SemaphoreProof memory p;
        p.scope = gate.scope(gate.epoch() + 1);
        vm.expectRevert(HourlyGate.WrongScope.selector);
        gate.act(p);
    }

    function test_scopeChangesEachHour() public {
        uint256 s0 = gate.scope(gate.epoch());
        vm.warp(block.timestamp + 1 hours);
        assertTrue(gate.scope(gate.epoch()) != s0);
    }
}
