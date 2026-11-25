// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AskInput} from "market/types/MarketTypes.sol";
import {PrivateEnergyBiddingMarket} from "../src/PrivateEnergyBiddingMarket.sol";

/// Accepts every zk proof, so these tests exercise the market and Semaphore's group, root and nullifier
/// checks without generating proofs. Real proofs are checked end to end by scripts/market-demo.mjs.
contract AcceptAllVerifier is ISemaphoreVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[4] calldata, uint256)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

contract PrivateEnergyBiddingMarketTest is Test {
    Semaphore semaphore;
    PrivateEnergyBiddingMarket market;
    uint256 groupId;
    address relayer = address(0xBE1A1);
    address seller = address(0x5E11);
    uint256 hour;

    function setUp() public {
        vm.warp(1_790_000_000);
        semaphore = new Semaphore(new AcceptAllVerifier());
        groupId = semaphore.createGroup(address(this)); // this test is the admission service
        semaphore.addMember(groupId, 111);
        semaphore.addMember(groupId, 222);
        PrivateEnergyBiddingMarket impl = new PrivateEnergyBiddingMarket();
        market = PrivateEnergyBiddingMarket(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(impl.initializePrivate, (address(this), semaphore, groupId))
                )
            )
        );
        market.whitelistSeller(seller, true);
        hour = market.getCurrentHourTimestamp() + 1 hours;
        vm.deal(relayer, 10 ether);
    }

    function _proof(uint256 nullifier, uint256 h, uint256 amount, uint256 price, address refund)
        internal
        view
        returns (ISemaphore.SemaphoreProof memory p)
    {
        p.merkleTreeDepth = 1;
        p.merkleTreeRoot = semaphore.getMerkleTreeRoot(groupId);
        p.nullifier = nullifier;
        p.scope = market.bidScope(h);
        p.message = market.bidMessage(amount, price, refund);
    }

    function _bid(uint256 nullifier, uint256 amount, uint256 price) internal {
        // build the proof first: vm.prank applies to the next external call, and _proof makes view calls
        ISemaphore.SemaphoreProof memory p = _proof(nullifier, hour, amount, price, relayer);
        vm.prank(relayer);
        market.placeBidWithProof{value: amount * price}(hour, amount, relayer, p);
    }

    function test_bidIsStoredUnderTheRefundAddress() public {
        address refund = address(0xCAFE);
        uint256 before = relayer.balance;
        ISemaphore.SemaphoreProof memory p = _proof(1, hour, 1000, 7, refund);
        vm.prank(relayer);
        market.placeBidWithProof{value: 1000 * 7 + 3}(hour, 1000, refund, p);
        (address bidder, uint88 amount,, uint88 price,) = market.bidsByHour(hour, 0);
        assertEq(bidder, refund);
        assertEq(amount, 1000);
        assertEq(price, 7);
        assertEq(before - relayer.balance, 7000); // the 3 wei excess went back to the relayer
    }

    function test_oneBidPerMemberPerHour() public {
        _bid(1, 1000, 7);
        ISemaphore.SemaphoreProof memory p = _proof(1, hour, 500, 9, relayer);
        vm.prank(relayer);
        vm.expectRevert(ISemaphore.Semaphore__YouAreUsingTheSameNullifierTwice.selector);
        market.placeBidWithProof{value: 4500}(hour, 500, relayer, p);
        _bid(2, 500, 9); // another member, same hour
        assertEq(market.totalBidsByHour(hour), 2);
    }

    function test_rejectsProofForAnotherHour() public {
        ISemaphore.SemaphoreProof memory p = _proof(1, hour + 1 hours, 1000, 7, relayer);
        vm.prank(relayer);
        vm.expectRevert(PrivateEnergyBiddingMarket.PrivateMarket__WrongScope.selector);
        market.placeBidWithProof{value: 7000}(hour, 1000, relayer, p);
    }

    function test_relayerCannotChangeTheBid() public {
        ISemaphore.SemaphoreProof memory p = _proof(1, hour, 1000, 7, relayer);
        vm.startPrank(relayer);
        vm.expectRevert(PrivateEnergyBiddingMarket.PrivateMarket__WrongMessage.selector);
        market.placeBidWithProof{value: 14000}(hour, 2000, relayer, p); // other amount
        vm.expectRevert(PrivateEnergyBiddingMarket.PrivateMarket__WrongMessage.selector);
        market.placeBidWithProof{value: 14000}(hour, 1000, relayer, p); // other price
        vm.expectRevert(PrivateEnergyBiddingMarket.PrivateMarket__WrongMessage.selector);
        market.placeBidWithProof{value: 7000}(hour, 1000, address(0xBAD), p); // other refund
        vm.stopPrank();
    }

    function test_rejectsRootOfAnotherGroup() public {
        ISemaphore.SemaphoreProof memory p = _proof(1, hour, 1000, 7, relayer);
        p.merkleTreeRoot = 12345;
        vm.prank(relayer);
        vm.expectRevert(ISemaphore.Semaphore__MerkleTreeRootIsNotPartOfTheGroup.selector);
        market.placeBidWithProof{value: 7000}(hour, 1000, relayer, p);
    }

    function test_privateBidsClearWithTheUnchangedMarket() public {
        _bid(1, 1000, 10);
        _bid(2, 1000, 6);
        vm.warp(hour + 1 hours);
        AskInput[] memory asks = new AskInput[](1);
        asks[0] = AskInput({receiver: seller, amount: 1500});
        uint256[] memory sorted = new uint256[](2);
        sorted[0] = 0;
        sorted[1] = 1;
        vm.prank(seller);
        market.placeAsksAndClearMarket(hour, asks, sorted);

        // 1500 W of 2000 W clear at the marginal price 6: the relayer paid 16000, sellers get 9000.
        assertEq(market.clearingPricePerHour(hour), 6);
        assertEq(market.claimableBalance(seller), 9000);
        assertEq(market.claimableBalance(relayer), 16000 - 9000);
    }
}
