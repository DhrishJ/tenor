// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title RiskParams
/// @notice Pure mapping from a ChainScore score to Tenor's borrowing terms.
///
/// Tenor uses a liquidation-risk score to set a liquidation-risk parameter. The
/// score ranks how likely a wallet is to run a position into liquidation, and
/// Tenor gives lower-risk wallets a thinner collateral buffer. We assume that
/// ranking, measured on Aave and Compound, carries over to Tenor's LTVs. Tenor's
/// own liquidation records (ScoreRegistry.recordLiquidation) are what test it.
///
/// Every number below is a risk-appetite POLICY PLACEHOLDER. None of it is
/// calibrated: the model's performance has not been reproduced (INVENTORY.md
/// section 7), so it supports ordering the tiers, not sizing the gaps between
/// them.
///
/// The score changes how much collateral a wallet must lock, not what it pays.
/// All borrowers pay one utilization-based rate. In a collateralized market the
/// rate compensates lenders for expected loss, and the LTV controls how much
/// loss is possible. A normal liquidation repays the lender in full, so the
/// score acts on the LTV, and the small residual gap risk is priced uniformly
/// through the reserve factor.
library RiskParams {
    /// @dev FLOOR covers unscored wallets, stale scores, and scores below D.
    /// A wallet can always decline to submit a score, so a low score can never
    /// be priced worse than no score; otherwise low scorers would hide.
    enum Tier {
        FLOOR,
        D,
        C,
        B,
        A
    }

    uint256 internal constant TIER_COUNT = 5;

    uint16 internal constant MIN_SCORE = 300;
    uint16 internal constant MAX_SCORE = 850;

    /// @dev Tier boundaries are ChainScore's published grade cutoffs
    /// (model_meta.json grade_cutoffs, commit a519058): A >= 774, B >= 643,
    /// C >= 578, D >= 452. Grade F (< 452) maps to FLOOR.
    uint16 internal constant D_MIN = 452;
    uint16 internal constant C_MIN = 578;
    uint16 internal constant B_MIN = 643;
    uint16 internal constant A_MIN = 774;

    uint256 internal constant BPS = 10_000;

    /// @dev Fixed liquidation bonus paid to liquidators out of seized collateral.
    uint256 internal constant LIQUIDATION_BONUS_BPS = 500;

    /// @dev Each tier's liquidation threshold sits this far above its max LTV.
    uint256 internal constant LT_BUFFER_BPS = 500;

    // Single borrow-rate curve: rate = BASE + SLOPE * utilization.
    // At 0% utilization 2% APR, at 100% utilization 12% APR. Placeholder.
    uint256 internal constant BASE_RATE_BPS = 200;
    uint256 internal constant SLOPE_BPS = 1_000;

    /// @dev Share of accrued interest set aside in the reserve, which absorbs
    /// bad debt before lenders do. Placeholder.
    uint256 internal constant RESERVE_FACTOR_BPS = 1_000;

    uint256 internal constant WAD = 1e18;

    error ScoreOutOfRange(uint16 score);
    error InvalidRiskParams(uint256 tier);

    function scoreToTier(uint16 score) internal pure returns (Tier) {
        if (score < MIN_SCORE || score > MAX_SCORE) revert ScoreOutOfRange(score);
        if (score >= A_MIN) return Tier.A;
        if (score >= B_MIN) return Tier.B;
        if (score >= C_MIN) return Tier.C;
        if (score >= D_MIN) return Tier.D;
        return Tier.FLOOR;
    }

    /// @notice Maximum debt / collateral value a borrow may reach, in bps.
    function tierToMaxLtv(Tier tier) internal pure returns (uint256) {
        if (tier == Tier.A) return 8_000;
        if (tier == Tier.B) return 7_500;
        if (tier == Tier.C) return 7_000;
        if (tier == Tier.D) return 6_500;
        return 6_000;
    }

    /// @notice Debt / collateral value at which a position becomes liquidatable, in bps.
    function tierToLiquidationThreshold(Tier tier) internal pure returns (uint256) {
        return tierToMaxLtv(tier) + LT_BUFFER_BPS;
    }

    /// @notice Per-wallet debt cap for a tier, in debt-asset units (18 decimals).
    function tierToWalletCap(Tier tier) internal pure returns (uint256) {
        if (tier == Tier.A) return 20_000e18;
        if (tier == Tier.B) return 10_000e18;
        if (tier == Tier.C) return 5_000e18;
        if (tier == Tier.D) return 2_500e18;
        return 1_000e18;
    }

    /// @notice Annual borrow rate in bps for a utilization in WAD (1e18 = 100%).
    /// The same for every tier (see the contract comment).
    function borrowRateBps(uint256 utilizationWad) internal pure returns (uint256) {
        if (utilizationWad > WAD) utilizationWad = WAD;
        return BASE_RATE_BPS + (SLOPE_BPS * utilizationWad) / WAD;
    }

    /// @notice Checks the constraints every tier must satisfy. Solidity has no
    /// compile-time assertion, so TenorMarket's constructor calls this and a
    /// deployment with broken parameters reverts. Tests call it too. Keep it:
    /// it stops a future edit from breaking these rules silently.
    ///
    ///  1. maxLtv < 100%: every loan is overcollateralized.
    ///  2. liquidationThreshold > maxLtv: a fresh borrow at max LTV is not
    ///     instantly liquidatable.
    ///  3. liquidationThreshold * (1 + bonus) <= 100%: at the trigger, the
    ///     collateral covers the repaid debt plus the bonus, so liquidating is
    ///     always profitable. (With an 8% bonus, a 94% threshold gives 1.015,
    ///     and nobody would liquidate.)
    ///  4. Terms never get worse as the tier rises.
    function validate() internal pure {
        uint256 prevLtv = 0;
        uint256 prevCap = 0;
        for (uint256 i = 0; i < TIER_COUNT; i++) {
            Tier t = Tier(i);
            uint256 ltv = tierToMaxLtv(t);
            uint256 lt = tierToLiquidationThreshold(t);
            uint256 cap = tierToWalletCap(t);
            if (ltv >= BPS) revert InvalidRiskParams(i);
            if (lt <= ltv) revert InvalidRiskParams(i);
            if (lt * (BPS + LIQUIDATION_BONUS_BPS) > BPS * BPS) revert InvalidRiskParams(i);
            if (i > 0 && (ltv < prevLtv || cap < prevCap)) revert InvalidRiskParams(i);
            prevLtv = ltv;
            prevCap = cap;
        }
    }
}
