// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @notice One Semaphore group of households. A member can act at most once per hourly epoch,
/// without revealing which member it is: the scope is bound to the epoch, so the nullifier is too.
contract HourlyGate {
    ISemaphore public immutable semaphore;
    uint256 public immutable groupId;
    address public immutable admin;

    event Acted(uint256 indexed epoch, uint256 nullifier, uint256 message);

    error NotAdmin();
    error WrongScope();

    constructor(ISemaphore _semaphore) {
        semaphore = _semaphore;
        admin = msg.sender;
        groupId = _semaphore.createGroup(); // this contract becomes the group admin
    }

    function addMembers(uint256[] calldata identityCommitments) external {
        if (msg.sender != admin) revert NotAdmin();
        semaphore.addMembers(groupId, identityCommitments);
    }

    function epoch() public view returns (uint256) {
        return block.timestamp / 1 hours;
    }

    function scope(uint256 e) public view returns (uint256) {
        return uint256(keccak256(abi.encode(groupId, e)));
    }

    /// @param proof Semaphore v4 proof whose scope is scope(epoch()). `message` carries the action,
    /// for a bid a commitment to its price and quantity.
    function act(ISemaphore.SemaphoreProof calldata proof) external {
        uint256 e = epoch();
        if (proof.scope != scope(e)) revert WrongScope();
        semaphore.validateProof(groupId, proof); // reverts on a reused nullifier or a bad proof
        emit Acted(e, proof.nullifier, proof.message);
    }
}
