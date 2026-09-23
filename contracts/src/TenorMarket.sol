// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {RiskParams} from "./RiskParams.sol";
import {ScoreRegistry} from "./ScoreRegistry.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title TenorMarket
/// @notice One collateral asset, one borrowable asset. A wallet's ChainScore
/// tier sets how much collateral it must lock (max LTV) and when it can be
/// liquidated (liquidation threshold). Every borrower pays the same rate.
///
/// Accounting, in brief (CONTRACTS.md has the full version):
///  - Lenders hold ERC-4626 shares of the debt asset.
///    totalAssets = cash + totalDebt - reserves.
///  - Debt is stored as scaled debt against one global borrow index (RAY, 1e27):
///    debt = ceil(scaledDebt * borrowIndex / RAY). The index grows with
///    simple interest over each interval between interactions:
///      index' = index * (1 + ratePerYear * dt / 365 days).
///  - A RESERVE_FACTOR share of each interval's interest is booked to
///    `reserves`, the protocol's claim on the pool. Reserves are not
///    withdrawable in v1.
///  - Bad debt (debt left over when a liquidation exhausts a position's
///    collateral) is written off `totalDebt`. Reserves absorb it first; any
///    remainder lowers totalAssets, and therefore the share price
///    (socialization). Both amounts are tracked and emitted: bad debt never
///    disappears silently.
///
/// A position is priced at its wallet's current effective tier on every action
/// that adds risk (borrow, collateral withdrawal), and must then satisfy that
/// tier's LTV, per-wallet cap and per-tier cap. Repaying or adding collateral
/// never moves a position to worse terms. Liquidation uses the liquidation
/// threshold of the tier the position was last priced at, so a score expiring
/// overnight does not make a healthy position instantly liquidatable.
contract TenorMarket is ERC4626, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 internal constant RAY = 1e27;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    struct Position {
        uint256 collateral;
        uint256 scaledDebt;
        RiskParams.Tier tier;
        uint16 score; // 0 when priced as unscored / stale
    }

    IERC20 public immutable collateralAsset;
    ScoreRegistry public immutable registry;
    IPriceOracle public immutable oracle;
    uint256 public immutable maxPriceAge;

    uint256 public borrowIndex = RAY;
    uint256 public lastAccrual;
    uint256 public totalScaledDebt;
    uint256 public reserves;

    uint256 public globalDebtCap;
    uint256[5] public tierDebtCap;
    uint256[5] public scaledDebtByTier;

    uint256 public totalCollateral;

    // Cumulative bad-debt accounting:
    // totalBadDebt == totalReserveDrawn + totalSocializedLoss (always).
    uint256 public totalBadDebt;
    uint256 public totalReserveDrawn;
    uint256 public totalSocializedLoss;

    mapping(address wallet => Position) internal _positions;

    event InterestAccrued(uint256 borrowIndex, uint256 interest, uint256 toReserves);
    event CollateralDeposited(address indexed wallet, uint256 amount);
    event CollateralWithdrawn(address indexed wallet, uint256 amount);
    event Retiered(address indexed wallet, RiskParams.Tier fromTier, RiskParams.Tier toTier, uint16 score);
    /// @dev Carries the terms in force, so a Tenor outcome can be tied back to
    /// the score and tier it was priced under.
    event Borrowed(
        address indexed wallet,
        uint256 amount,
        uint256 debtAfter,
        uint16 score,
        RiskParams.Tier tier,
        uint256 maxLtvBps,
        uint256 liqThresholdBps,
        uint256 collateralPriceWad
    );
    event Repaid(address indexed payer, address indexed wallet, uint256 amount, uint256 debtAfter);
    event Liquidated(
        address indexed wallet,
        address indexed liquidator,
        uint256 repaid,
        uint256 collateralSeized,
        uint256 shortfall,
        uint16 score,
        RiskParams.Tier tier,
        uint256 liqThresholdBps,
        uint256 collateralPriceWad
    );
    event BadDebtRealized(address indexed wallet, uint256 amount, uint256 fromReserves, uint256 socialized);
    event CapsSet(uint256 globalDebtCap, uint256[5] tierDebtCap);

    error ZeroAmount();
    error InvalidConfig();
    error StalePrice(address asset);
    error InvalidPrice(address asset);
    error InsufficientCollateral();
    error ExceedsMaxLtv();
    error ExceedsWalletCap();
    error ExceedsTierCap();
    error ExceedsGlobalCap();
    error InsufficientLiquidity();
    error NoDebt();
    error NotLiquidatable();

    constructor(
        address owner_,
        IERC20Metadata debtAsset_,
        IERC20Metadata collateralAsset_,
        ScoreRegistry registry_,
        IPriceOracle oracle_,
        uint256 maxPriceAge_,
        uint256 globalDebtCap_
    )
        ERC20("Tenor Lender Share", "tnLP")
        ERC4626(debtAsset_)
        Ownable(owner_)
    {
        RiskParams.validate();
        if (address(debtAsset_) == address(collateralAsset_)) revert InvalidConfig();
        // Both assets are assumed to have 18 decimals; enforce rather than
        // silently mis-scale.
        if (debtAsset_.decimals() != 18 || collateralAsset_.decimals() != 18) revert InvalidConfig();
        if (address(registry_) == address(0) || address(oracle_) == address(0) || maxPriceAge_ == 0) {
            revert InvalidConfig();
        }
        collateralAsset = collateralAsset_;
        registry = registry_;
        oracle = oracle_;
        maxPriceAge = maxPriceAge_;
        lastAccrual = block.timestamp;
        globalDebtCap = globalDebtCap_;
        for (uint256 i = 0; i < RiskParams.TIER_COUNT; i++) {
            tierDebtCap[i] = globalDebtCap_;
        }
    }

    // ================================================================ lenders

    /// @dev Virtual-share offset against first-depositor inflation attacks.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @notice cash + totalDebt - reserves, including interest accrued up to now.
    function totalAssets() public view override returns (uint256) {
        (uint256 index, uint256 res) = _previewAccrual();
        return _cash() + _debtFromScaled(totalScaledDebt, index) - res;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return paused() ? 0 : super.maxMint(receiver);
    }

    /// @dev Lenders can only withdraw idle cash, never cash that is lent out.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), _cash());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(_cash(), Math.Rounding.Floor));
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        _accrue();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        _accrue();
        return super.mint(shares, receiver);
    }

    /// @notice Works while paused.
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        _accrue();
        return super.withdraw(assets, receiver, owner_);
    }

    /// @notice Works while paused.
    function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
        _accrue();
        return super.redeem(shares, receiver, owner_);
    }

    // ============================================================== borrowers

    /// @notice Works while paused.
    function depositCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _positions[msg.sender].collateral += amount;
        totalCollateral += amount;
        emit CollateralDeposited(msg.sender, amount);
        collateralAsset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Works while paused. With open debt, the position is re-priced at
    /// the wallet's current tier and must still satisfy it after the withdrawal
    /// (this needs a fresh price). With no debt, always allowed.
    function withdrawCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        Position storage p = _positions[msg.sender];
        if (amount > p.collateral) revert InsufficientCollateral();
        p.collateral -= amount;
        totalCollateral -= amount;
        if (p.scaledDebt > 0) {
            _retier(msg.sender, p);
            _enforceTerms(p);
        }
        emit CollateralWithdrawn(msg.sender, amount);
        collateralAsset.safeTransfer(msg.sender, amount);
    }

    /// @notice Borrow the debt asset. Priced at the wallet's effective tier: a
    /// fresh score's tier, otherwise FLOOR. An absent or stale score never
    /// prices better than FLOOR.
    function borrow(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        if (amount > _cash()) revert InsufficientLiquidity();

        Position storage p = _positions[msg.sender];
        _retier(msg.sender, p);

        uint256 scaledAdd = amount.mulDiv(RAY, borrowIndex, Math.Rounding.Ceil);
        p.scaledDebt += scaledAdd;
        totalScaledDebt += scaledAdd;
        scaledDebtByTier[uint256(p.tier)] += scaledAdd;

        if (_debtFromScaled(totalScaledDebt, borrowIndex) > globalDebtCap) revert ExceedsGlobalCap();
        uint256 collateralPrice = _enforceTerms(p);

        emit Borrowed(
            msg.sender,
            amount,
            _debtFromScaled(p.scaledDebt, borrowIndex),
            p.score,
            p.tier,
            RiskParams.tierToMaxLtv(p.tier),
            RiskParams.tierToLiquidationThreshold(p.tier),
            collateralPrice
        );
        IERC20(asset()).safeTransfer(msg.sender, amount);
    }

    /// @notice Repay `amount` of `wallet`'s debt (anyone may repay for anyone).
    /// Pass type(uint256).max to repay in full. Works while paused.
    function repay(address wallet, uint256 amount) external nonReentrant returns (uint256 paid) {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        Position storage p = _positions[wallet];
        uint256 debt = _debtFromScaled(p.scaledDebt, borrowIndex);
        if (debt == 0) revert NoDebt();

        paid = _reduceDebt(p, debt, amount);
        emit Repaid(msg.sender, wallet, paid, _debtFromScaled(p.scaledDebt, borrowIndex));
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), paid);
    }

    /// @notice Liquidate an unhealthy position: the liquidator repays up to
    /// `maxRepay` of its debt and receives collateral worth the repaid amount
    /// plus LIQUIDATION_BONUS_BPS, at oracle prices. No close factor; the
    /// repay is capped so the seized collateral never exceeds what is there.
    ///
    /// Every liquidation is recorded in the ScoreRegistry, which immediately
    /// invalidates the wallet's score. If the liquidation takes all of the
    /// collateral and debt remains, that remainder is bad debt: written off,
    /// absorbed by reserves first, then socialized to lenders, and recorded as
    /// the wallet's shortfall.
    function liquidate(address wallet, uint256 maxRepay)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 repaid, uint256 seized)
    {
        if (maxRepay == 0) revert ZeroAmount();
        _accrue();
        Position storage p = _positions[wallet];
        uint256 debt = _debtFromScaled(p.scaledDebt, borrowIndex);
        if (debt == 0) revert NoDebt();

        (uint256 collPrice, uint256 debtPrice) = _prices();
        uint256 collValue = p.collateral.mulDiv(collPrice, WAD);
        uint256 debtValue = debt.mulDiv(debtPrice, WAD, Math.Rounding.Ceil);
        uint256 ltBps = RiskParams.tierToLiquidationThreshold(p.tier);
        // Healthy while debtValue <= collValue * LT.
        if (debtValue * BPS <= collValue * ltBps) revert NotLiquidatable();

        // The largest repay the collateral can pay for, bonus included.
        uint256 repayCap = collValue.mulDiv(BPS * WAD, (BPS + RiskParams.LIQUIDATION_BONUS_BPS) * debtPrice);
        repaid = Math.min(Math.min(maxRepay, debt), repayCap);

        if (repaid == repayCap) {
            // The collateral is used up. This includes repayCap == 0: collateral
            // worth less than one wei of debt. That position could never be
            // liquidated otherwise, and its debt would sit in totalAssets as a
            // phantom claim. Seizing it realizes the whole debt as bad debt below.
            seized = p.collateral;
        } else {
            // repaid < repayCap <= collateral value / (1 + bonus), so this is
            // strictly below p.collateral; the checked subtraction below would
            // revert if that ever failed.
            seized = repaid.mulDiv((BPS + RiskParams.LIQUIDATION_BONUS_BPS) * debtPrice, BPS * collPrice);
        }

        if (repaid > 0) _reduceDebt(p, debt, repaid);
        p.collateral -= seized;
        totalCollateral -= seized;

        uint256 shortfall = 0;
        if (p.collateral == 0 && p.scaledDebt > 0) {
            shortfall = _realizeBadDebt(wallet, p);
        }

        emit Liquidated(wallet, msg.sender, repaid, seized, shortfall, p.score, p.tier, ltBps, collPrice);

        // Interactions. The registry is a trusted contract set at deployment.
        registry.recordLiquidation(wallet, shortfall);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), repaid);
        collateralAsset.safeTransfer(msg.sender, seized);
    }

    // ================================================================== admin

    function setCaps(uint256 globalDebtCap_, uint256[5] calldata tierDebtCap_) external onlyOwner {
        globalDebtCap = globalDebtCap_;
        tierDebtCap = tierDebtCap_;
        emit CapsSet(globalDebtCap_, tierDebtCap_);
    }

    /// @notice Pause blocks lender deposits, borrowing and liquidation. Repay,
    /// adding collateral, lender withdrawals and (health-checked) collateral
    /// withdrawals keep working, so a pause never traps anyone. Liquidation is
    /// blocked because the usual reason to pause is a bad price.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ================================================================== views

    function getPosition(address wallet)
        external
        view
        returns (uint256 collateral, uint256 debt, RiskParams.Tier tier, uint16 score)
    {
        Position memory p = _positions[wallet];
        (uint256 index,) = _previewAccrual();
        return (p.collateral, _debtFromScaled(p.scaledDebt, index), p.tier, p.score);
    }

    /// @notice A position's debt in scaled (index-free) units.
    function scaledDebtOf(address wallet) external view returns (uint256) {
        return _positions[wallet].scaledDebt;
    }

    function debtOf(address wallet) public view returns (uint256) {
        (uint256 index,) = _previewAccrual();
        return _debtFromScaled(_positions[wallet].scaledDebt, index);
    }

    function totalDebt() public view returns (uint256) {
        (uint256 index,) = _previewAccrual();
        return _debtFromScaled(totalScaledDebt, index);
    }

    function tierDebt(RiskParams.Tier tier) public view returns (uint256) {
        (uint256 index,) = _previewAccrual();
        return _debtFromScaled(scaledDebtByTier[uint256(tier)], index);
    }

    /// @notice (collateral value * liquidation threshold) / debt value, in WAD,
    /// using the tier the position was last priced at. Below 1e18 means
    /// liquidatable. type(uint256).max with no debt. Reverts on a stale price.
    function healthFactor(address wallet) external view returns (uint256) {
        Position memory p = _positions[wallet];
        (uint256 index,) = _previewAccrual();
        uint256 debt = _debtFromScaled(p.scaledDebt, index);
        if (debt == 0) return type(uint256).max;
        (uint256 collPrice, uint256 debtPrice) = _prices();
        uint256 collValue = p.collateral.mulDiv(collPrice, WAD);
        uint256 debtValue = debt.mulDiv(debtPrice, WAD, Math.Rounding.Ceil);
        return collValue.mulDiv(RiskParams.tierToLiquidationThreshold(p.tier) * WAD, BPS * debtValue);
    }

    /// @notice The largest amount `wallet` can borrow right now, at its current
    /// effective tier: the tightest of its max LTV, its per-wallet cap, the
    /// tier's cap, the global cap and idle cash. Stored debt rounds up against
    /// the borrower, so the result keeps a margin of (index / RAY + 2) wei;
    /// borrow(maxBorrow(wallet)) always succeeds while prices are fresh and the
    /// market is not paused. Reverts on a stale price.
    function maxBorrow(address wallet) external view returns (uint256) {
        Position memory p = _positions[wallet];
        (uint256 index,) = _previewAccrual();
        (RiskParams.Tier tier,) = registry.effectiveTier(wallet);
        uint256 debt = _debtFromScaled(p.scaledDebt, index);
        (uint256 collPrice, uint256 debtPrice) = _prices();

        uint256 ltvLimit =
            p.collateral.mulDiv(collPrice * RiskParams.tierToMaxLtv(tier), BPS * debtPrice);
        uint256 walletLimit = Math.min(ltvLimit, RiskParams.tierToWalletCap(tier));
        uint256 room = _sub0(walletLimit, debt);

        uint256 bucketDebt = _debtFromScaled(scaledDebtByTier[uint256(tier)], index);
        if (p.tier != tier) bucketDebt += debt;
        room = Math.min(room, _sub0(tierDebtCap[uint256(tier)], bucketDebt));
        room = Math.min(room, _sub0(globalDebtCap, _debtFromScaled(totalScaledDebt, index)));
        room = Math.min(room, _cash());

        return _sub0(room, index / RAY + 2);
    }

    /// @notice Current annual borrow rate in bps (the same for every wallet).
    function borrowRateBps() external view returns (uint256) {
        return RiskParams.borrowRateBps(_utilization(_debtFromScaled(totalScaledDebt, borrowIndex), reserves));
    }

    // =============================================================== internal

    function _cash() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function _sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _debtFromScaled(uint256 scaled, uint256 index) internal pure returns (uint256) {
        return scaled.mulDiv(index, RAY, Math.Rounding.Ceil);
    }

    function _utilization(uint256 debt, uint256 res) internal view returns (uint256) {
        uint256 supplied = _cash() + debt - res;
        return supplied == 0 ? 0 : debt.mulDiv(WAD, supplied);
    }

    /// @dev Interest over [lastAccrual, now] at the rate implied by utilization
    /// at the start of the interval. Simple interest within an interval;
    /// compounding happens between intervals (each interaction).
    function _previewAccrual() internal view returns (uint256 index, uint256 res) {
        index = borrowIndex;
        res = reserves;
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0 || totalScaledDebt == 0) return (index, res);

        uint256 debtBefore = _debtFromScaled(totalScaledDebt, index);
        uint256 rateBps = RiskParams.borrowRateBps(_utilization(debtBefore, res));
        uint256 growth = index.mulDiv(rateBps * dt, BPS * SECONDS_PER_YEAR);
        index += growth;
        uint256 interest = _debtFromScaled(totalScaledDebt, index) - debtBefore;
        res += interest.mulDiv(RiskParams.RESERVE_FACTOR_BPS, BPS);
    }

    function _accrue() internal {
        if (block.timestamp == lastAccrual) return;
        (uint256 index, uint256 res) = _previewAccrual();
        uint256 interest = _debtFromScaled(totalScaledDebt, index) - _debtFromScaled(totalScaledDebt, borrowIndex);
        uint256 toReserves = res - reserves;
        borrowIndex = index;
        reserves = res;
        lastAccrual = block.timestamp;
        if (interest > 0) emit InterestAccrued(index, interest, toReserves);
    }

    function _prices() internal view returns (uint256 collPrice, uint256 debtPrice) {
        collPrice = _price(address(collateralAsset));
        debtPrice = _price(asset());
    }

    function _price(address a) internal view returns (uint256 priceWad) {
        uint256 updatedAt;
        (priceWad, updatedAt) = oracle.getPrice(a);
        if (priceWad == 0) revert InvalidPrice(a);
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxPriceAge) revert StalePrice(a);
    }

    /// @dev Move the position to the wallet's current effective tier.
    function _retier(address wallet, Position storage p) internal {
        (RiskParams.Tier tier, uint16 score) = registry.effectiveTier(wallet);
        if (tier != p.tier) {
            scaledDebtByTier[uint256(p.tier)] -= p.scaledDebt;
            scaledDebtByTier[uint256(tier)] += p.scaledDebt;
            emit Retiered(wallet, p.tier, tier, score);
            p.tier = tier;
        }
        p.score = score;
    }

    /// @dev Checks a position against its (current) tier's max LTV, per-wallet
    /// cap and per-tier cap. Returns the collateral price used.
    function _enforceTerms(Position storage p) internal view returns (uint256 collPrice) {
        uint256 debt = _debtFromScaled(p.scaledDebt, borrowIndex);
        uint256 debtPrice;
        (collPrice, debtPrice) = _prices();
        uint256 collValue = p.collateral.mulDiv(collPrice, WAD);
        uint256 debtValue = debt.mulDiv(debtPrice, WAD, Math.Rounding.Ceil);
        if (debtValue * BPS > collValue * RiskParams.tierToMaxLtv(p.tier)) revert ExceedsMaxLtv();
        if (debt > RiskParams.tierToWalletCap(p.tier)) revert ExceedsWalletCap();
        if (_debtFromScaled(scaledDebtByTier[uint256(p.tier)], borrowIndex) > tierDebtCap[uint256(p.tier)]) {
            revert ExceedsTierCap();
        }
    }

    /// @dev Reduce a position's debt by up to `amount`; returns what is owed
    /// for it. Paying the full debt clears the position exactly; partial
    /// payments round the scaled reduction down (in the pool's favour).
    function _reduceDebt(Position storage p, uint256 debt, uint256 amount) internal returns (uint256 paid) {
        uint256 scaledSub;
        if (amount >= debt) {
            scaledSub = p.scaledDebt;
            paid = debt;
        } else {
            scaledSub = amount.mulDiv(RAY, borrowIndex);
            if (scaledSub == 0) revert ZeroAmount();
            paid = amount;
        }
        p.scaledDebt -= scaledSub;
        totalScaledDebt -= scaledSub;
        scaledDebtByTier[uint256(p.tier)] -= scaledSub;
    }

    /// @dev Write off a collateral-less position's remaining debt. Reserves
    /// absorb it first; the rest lowers totalAssets (the share price).
    function _realizeBadDebt(address wallet, Position storage p) internal returns (uint256 amount) {
        amount = _debtFromScaled(p.scaledDebt, borrowIndex);
        totalScaledDebt -= p.scaledDebt;
        scaledDebtByTier[uint256(p.tier)] -= p.scaledDebt;
        p.scaledDebt = 0;

        uint256 fromReserves = Math.min(amount, reserves);
        reserves -= fromReserves;
        uint256 socialized = amount - fromReserves;

        totalBadDebt += amount;
        totalReserveDrawn += fromReserves;
        totalSocializedLoss += socialized;
        emit BadDebtRealized(wallet, amount, fromReserves, socialized);
    }
}
