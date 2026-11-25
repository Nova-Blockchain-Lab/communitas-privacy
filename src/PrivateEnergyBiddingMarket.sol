// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EnergyBiddingMarket} from "market/EnergyBiddingMarket.sol";
import {Bid, EnergyBiddingMarket__AmountCannotBeZero, EnergyBiddingMarket__ValueExceedsUint88, EnergyBiddingMarket__WrongHourProvided, EnergyBiddingMarket__InvalidAddress} from "market/types/MarketTypes.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @notice The COMMUNITAS market with one extra entry point. A bid carries a Semaphore v4 proof that
/// its author is a member of the community group, instead of the author's address. A relayer submits
/// and funds it. Clearing, asks and claims are the unchanged EnergyBiddingMarket code.
/// - The proof's scope is bidScope(hour), so a member gets one nullifier, and so one bid, per market hour.
/// - The proof's message is bidMessage(amount, price, refund), so the relayer cannot change the bid.
/// - The bid is stored with `refund` as its bidder: refunds and claims go there (the relayer in M1,
///   a stealth address in M2).
contract PrivateEnergyBiddingMarket is EnergyBiddingMarket {
    ISemaphore public semaphore;
    uint256 public groupId;

    event PrivateBidPlaced(uint256 indexed hour, uint256 indexed index, uint256 nullifier);

    error PrivateMarket__WrongScope();
    error PrivateMarket__WrongMessage();

    function initializePrivate(address owner, ISemaphore _semaphore, uint256 _groupId) external initializer {
        __Ownable_init(owner);
        semaphore = _semaphore;
        groupId = _groupId;
    }

    function bidScope(uint256 hour) public view returns (uint256) {
        return uint256(keccak256(abi.encode(address(this), groupId, hour)));
    }

    function bidMessage(uint256 amount, uint256 price, address refund) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(amount, price, refund)));
    }

    /// @param hour Market hour (exact hour timestamp in the future), as in placeBid.
    /// @param amount Energy in Watts. Price per Watt is msg.value / amount, as in placeBid.
    /// @param refund Receives refunds and the claimable balance of this bid.
    function placeBidWithProof(
        uint256 hour,
        uint256 amount,
        address refund,
        ISemaphore.SemaphoreProof calldata proof
    ) external payable assertExactHour(hour) isMarketNotCleared(hour) {
        if (amount == 0) revert EnergyBiddingMarket__AmountCannotBeZero();
        if (refund == address(0)) revert EnergyBiddingMarket__InvalidAddress();
        if (hour <= block.timestamp) revert EnergyBiddingMarket__WrongHourProvided(hour);
        uint256 price = msg.value / amount;
        if (amount > type(uint88).max) revert EnergyBiddingMarket__ValueExceedsUint88(amount);
        if (price > type(uint88).max) revert EnergyBiddingMarket__ValueExceedsUint88(price);
        if (proof.scope != bidScope(hour)) revert PrivateMarket__WrongScope();
        if (proof.message != bidMessage(amount, price, refund)) revert PrivateMarket__WrongMessage();

        semaphore.validateProof(groupId, proof); // reverts on a bad proof or a reused nullifier

        uint256 index = totalBidsByHour[hour];
        // amount and price were checked against type(uint88).max above
        // forge-lint: disable-next-line(unsafe-typecast)
        bidsByHour[hour][index] =
            Bid({bidder: refund, amount: uint88(amount), settled: false, price: uint88(price), canceled: false});
        totalBidsByHour[hour] = index + 1;
        emit BidPlaced(refund, hour, amount, price);
        emit PrivateBidPlaced(hour, index, proof.nullifier);

        uint256 excess = msg.value - price * amount;
        if (excess > 0) _transferETH(msg.sender, excess);
    }
}
