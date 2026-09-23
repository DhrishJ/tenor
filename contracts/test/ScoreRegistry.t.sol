// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {RiskParams} from "../src/RiskParams.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract ScoreRegistryTest is Test {
    ScoreRegistry reg;

    address owner = makeAddr("owner");
    uint256 attestorKey = 0xA11CE;
    address attestor;
    address wallet = makeAddr("wallet");
    address market = makeAddr("market");

    bytes32 constant MODEL = keccak256("v5-xgb-cal");
    uint64 constant T0 = 1_790_000_000;

    function setUp() public {
        vm.warp(T0);
        attestor = vm.addr(attestorKey);
        reg = new ScoreRegistry(owner, attestor);
        vm.prank(owner);
        reg.setMarket(market, true);
    }

    // ------------------------------------------------------------ helpers

    function _att(uint16 score, uint256 nonce) internal view returns (ScoreRegistry.Attestation memory) {
        return ScoreRegistry.Attestation({
            wallet: wallet,
            score: score,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 days),
            deadline: uint64(block.timestamp + 15 minutes),
            nonce: nonce,
            modelVersion: MODEL
        });
    }

    function _sign(uint256 key, ScoreRegistry.Attestation memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, reg.hashAttestation(a));
        return abi.encodePacked(r, s, v);
    }

    function _submit(ScoreRegistry.Attestation memory a) internal {
        reg.submitAttestation(a, _sign(attestorKey, a));
    }

    /// Signs first, then arms expectRevert, so the expectation applies to
    /// submitAttestation and not to the hashAttestation call used for signing.
    function _submitExpectRevert(ScoreRegistry.Attestation memory a, bytes memory err) internal {
        bytes memory sig = _sign(attestorKey, a);
        vm.expectRevert(err);
        reg.submitAttestation(a, sig);
    }

    // ------------------------------------------- hand-built EIP-712 digest

    /// Builds the EIP-712 digest from the spec, without calling any registry
    /// helper, so this tests the contract rather than our helper agreeing with
    /// itself:
    ///   domainSeparator = keccak256(abi.encode(
    ///       keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    ///       keccak256("Tenor ScoreRegistry"), keccak256("1"), chainid, registry))
    ///   structHash = keccak256(abi.encode(TYPEHASH, wallet, score, issuedAt,
    ///       expiresAt, deadline, nonce, modelVersion))
    ///   digest = keccak256("\x19\x01" || domainSeparator || structHash)
    function test_handBuiltSignature_accepted() public {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Tenor ScoreRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(reg)
            )
        );
        bytes32 typehash = keccak256(
            "ScoreAttestation(address wallet,uint16 score,uint64 issuedAt,uint64 expiresAt,uint64 deadline,uint256 nonce,bytes32 modelVersion)"
        );
        ScoreRegistry.Attestation memory a = _att(780, 0);
        bytes32 structHash = keccak256(
            abi.encode(typehash, a.wallet, a.score, a.issuedAt, a.expiresAt, a.deadline, a.nonce, a.modelVersion)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));

        assertEq(reg.domainSeparator(), domain, "domain separator");
        assertEq(reg.hashAttestation(a), digest, "digest");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, digest);
        reg.submitAttestation(a, abi.encodePacked(r, s, v));

        (uint16 score,,, bool stale) = reg.getScore(wallet);
        assertEq(score, 780);
        assertFalse(stale);
    }

    // ------------------------------------------------------ submit: success

    function test_submit_storesAndEmits() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        vm.expectEmit(address(reg));
        emit ScoreRegistry.AttestationSubmitted(wallet, 700, a.issuedAt, a.expiresAt, 0, MODEL, 1);
        _submit(a);

        (uint16 score, uint64 issuedAt, uint64 expiresAt, bool stale) = reg.getScore(wallet);
        assertEq(score, 700);
        assertEq(issuedAt, a.issuedAt);
        assertEq(expiresAt, a.expiresAt);
        assertFalse(stale);
        assertEq(reg.nonces(wallet), 1);
        (RiskParams.Tier tier, uint16 s) = reg.effectiveTier(wallet);
        assertEq(uint256(tier), uint256(RiskParams.Tier.B));
        assertEq(s, 700);
    }

    function test_submit_permissionlessRelay() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        bytes memory sig = _sign(attestorKey, a);
        vm.prank(makeAddr("relayer"));
        reg.submitAttestation(a, sig);
        (uint16 score,,,) = reg.getScore(wallet);
        assertEq(score, 700);
    }

    function test_submit_newerReplacesOlder() public {
        _submit(_att(700, 0));
        vm.warp(block.timestamp + 1 hours);
        _submit(_att(500, 1));
        (uint16 score,,,) = reg.getScore(wallet);
        assertEq(score, 500);
    }

    // ------------------------------------------------------ submit: reverts

    function test_revert_wrongSigner() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        bytes memory sig = _sign(0xBAD, a);
        vm.expectRevert(ScoreRegistry.InvalidSigner.selector);
        reg.submitAttestation(a, sig);
    }

    function test_revert_tamperedScore() public {
        ScoreRegistry.Attestation memory a = _att(500, 0);
        bytes memory sig = _sign(attestorKey, a);
        a.score = 850;
        vm.expectRevert(ScoreRegistry.InvalidSigner.selector);
        reg.submitAttestation(a, sig);
    }

    function test_revert_tamperedWallet() public {
        ScoreRegistry.Attestation memory a = _att(800, 0);
        bytes memory sig = _sign(attestorKey, a);
        a.wallet = makeAddr("thief");
        vm.expectRevert(ScoreRegistry.InvalidSigner.selector);
        reg.submitAttestation(a, sig);
    }

    function test_revert_malformedSignature() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        vm.expectRevert(ScoreRegistry.InvalidSigner.selector);
        reg.submitAttestation(a, hex"1234");
    }

    /// A signature with s in the upper half of the curve order is the
    /// malleable twin of a valid one; OpenZeppelin ECDSA rejects it.
    function test_revert_malleableSignature() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, reg.hashAttestation(a));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(n - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        // The twin really is a valid signature by the attestor under raw
        // ecrecover, so the revert below comes from the high-s check alone.
        assertEq(ecrecover(reg.hashAttestation(a), vFlip, r, sHigh), attestor);
        vm.expectRevert(ScoreRegistry.InvalidSigner.selector);
        reg.submitAttestation(a, abi.encodePacked(r, sHigh, vFlip));
    }

    function test_revert_wrongChainId() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        bytes memory sig = _sign(attestorKey, a); // signed for the current chain
        vm.chainId(block.chainid + 1); // same contract, forked chain
        vm.expectRevert(ScoreRegistry.InvalidSigner.selector);
        reg.submitAttestation(a, sig);
    }

    function test_domainSeparator_tracksChainId() public {
        bytes32 before = reg.domainSeparator();
        vm.chainId(10143 + 7);
        assertTrue(reg.domainSeparator() != before);
    }

    function test_revert_wrongVerifyingContract() public {
        ScoreRegistry other = new ScoreRegistry(owner, attestor);
        ScoreRegistry.Attestation memory a = _att(700, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorKey, other.hashAttestation(a));
        vm.expectRevert(ScoreRegistry.InvalidSigner.selector);
        reg.submitAttestation(a, abi.encodePacked(r, s, v));
    }

    function test_revert_replayedNonce() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        bytes memory sig = _sign(attestorKey, a);
        reg.submitAttestation(a, sig);
        vm.expectRevert(abi.encodeWithSelector(ScoreRegistry.InvalidNonce.selector, 1, 0));
        reg.submitAttestation(a, sig);
    }

    function test_revert_futureNonce() public {
        _submitExpectRevert(_att(700, 5), abi.encodeWithSelector(ScoreRegistry.InvalidNonce.selector, 0, 5));
    }

    function test_revert_deadlinePassed() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        bytes memory sig = _sign(attestorKey, a);
        vm.warp(a.deadline + 1);
        vm.expectRevert(ScoreRegistry.DeadlinePassed.selector);
        reg.submitAttestation(a, sig);
    }

    function test_revert_expired() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        a.deadline = a.expiresAt + 1 days; // isolate the expiry check
        bytes memory sig = _sign(attestorKey, a);
        vm.warp(a.expiresAt);
        vm.expectRevert(ScoreRegistry.AttestationExpired.selector);
        reg.submitAttestation(a, sig);
    }

    function test_revert_expiresAtInPast() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        a.issuedAt = uint64(block.timestamp - 2 hours);
        a.expiresAt = uint64(block.timestamp - 1);
        _submitExpectRevert(a, abi.encodeWithSelector(ScoreRegistry.AttestationExpired.selector));
    }

    function test_revert_issuedInFuture() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        a.issuedAt = uint64(block.timestamp + 61);
        _submitExpectRevert(a, abi.encodeWithSelector(ScoreRegistry.IssuedInFuture.selector));
    }

    function test_clockSkewTolerated() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        a.issuedAt = uint64(block.timestamp + 60);
        _submit(a);
    }

    function test_revert_ttlTooLong() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        a.expiresAt = a.issuedAt + 2 days + 1;
        _submitExpectRevert(a, abi.encodeWithSelector(ScoreRegistry.TtlTooLong.selector));
    }

    function test_maxTtlAccepted() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        a.expiresAt = a.issuedAt + 2 days;
        _submit(a);
    }

    function test_revert_scoreBelowRange() public {
        _submitExpectRevert(_att(299, 0), abi.encodeWithSelector(RiskParams.ScoreOutOfRange.selector, uint16(299)));
    }

    function test_revert_scoreAboveRange() public {
        _submitExpectRevert(_att(851, 0), abi.encodeWithSelector(RiskParams.ScoreOutOfRange.selector, uint16(851)));
    }

    function test_revert_notNewer() public {
        _submit(_att(700, 0));
        // Same issuedAt, next nonce: a rollback to an equally old score.
        _submitExpectRevert(_att(800, 1), abi.encodeWithSelector(ScoreRegistry.NotNewer.selector));
    }

    function test_revert_zeroWallet() public {
        ScoreRegistry.Attestation memory a = _att(700, 0);
        a.wallet = address(0);
        _submitExpectRevert(a, abi.encodeWithSelector(ScoreRegistry.ZeroAddress.selector));
    }

    function test_revert_paused() public {
        vm.prank(owner);
        reg.pause();
        ScoreRegistry.Attestation memory a = _att(700, 0);
        bytes memory sig = _sign(attestorKey, a);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        reg.submitAttestation(a, sig);
    }

    // ----------------------------------------------------------- staleness

    function test_stale_whenAbsent() public view {
        (uint16 score,,, bool stale) = reg.getScore(wallet);
        assertEq(score, 0);
        assertTrue(stale);
        (RiskParams.Tier tier,) = reg.effectiveTier(wallet);
        assertEq(uint256(tier), uint256(RiskParams.Tier.FLOOR));
    }

    function test_stale_afterExpiry_returnsNumberFlaggedStale() public {
        ScoreRegistry.Attestation memory a = _att(800, 0);
        _submit(a);
        vm.warp(a.expiresAt);
        (uint16 score,,, bool stale) = reg.getScore(wallet);
        assertEq(score, 800); // the number is still visible...
        assertTrue(stale); // ...but never presented as fresh
        (RiskParams.Tier tier, uint16 s) = reg.effectiveTier(wallet);
        assertEq(uint256(tier), uint256(RiskParams.Tier.FLOOR));
        assertEq(s, 0);
    }

    function test_stale_afterAttestorRotation() public {
        _submit(_att(800, 0));
        vm.prank(owner);
        reg.setAttestor(makeAddr("newAttestor"));
        (,,, bool stale) = reg.getScore(wallet);
        assertTrue(stale);
    }

    function test_revert_oldAttestorAfterRotation() public {
        vm.prank(owner);
        reg.setAttestor(makeAddr("newAttestor"));
        _submitExpectRevert(_att(800, 0), abi.encodeWithSelector(ScoreRegistry.InvalidSigner.selector));
    }

    // ------------------------------------------ liquidation feedback (O2/O3)

    function test_recordLiquidation_invalidatesCurrentScore() public {
        _submit(_att(800, 0));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(market);
        reg.recordLiquidation(wallet, 0);

        (uint16 score,,, bool stale) = reg.getScore(wallet);
        assertEq(score, 800);
        assertTrue(stale, "a Tenor liquidation must invalidate the score immediately");
        ScoreRegistry.LiquidationRecord memory r = reg.getLiquidationRecord(wallet);
        assertEq(r.liquidationCount, 1);
        assertEq(r.lastLiquidatedAt, block.timestamp);
        assertEq(r.shortfallCount, 0);
        assertEq(r.totalShortfall, 0);
    }

    /// The O3 exploit: an attestation signed before the liquidation, still
    /// inside its submit window, must not restore the old terms.
    function test_revert_attestationIssuedBeforeLiquidation() public {
        ScoreRegistry.Attestation memory a = _att(820, 0);
        bytes memory sig = _sign(attestorKey, a);
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(market);
        reg.recordLiquidation(wallet, 0);
        vm.expectRevert(ScoreRegistry.IssuedBeforeLiquidation.selector);
        reg.submitAttestation(a, sig);
    }

    /// Same-second edge: issuedAt == lastLiquidatedAt is rejected too.
    function test_revert_attestationIssuedSameSecondAsLiquidation() public {
        vm.prank(market);
        reg.recordLiquidation(wallet, 0);
        _submitExpectRevert(_att(820, 0), abi.encodeWithSelector(ScoreRegistry.IssuedBeforeLiquidation.selector));
    }

    function test_attestationAfterLiquidation_accepted() public {
        vm.prank(market);
        reg.recordLiquidation(wallet, 0);
        vm.warp(block.timestamp + 1);
        _submit(_att(520, 0));
        (uint16 score,,, bool stale) = reg.getScore(wallet);
        assertEq(score, 520);
        assertFalse(stale);
    }

    function test_recordLiquidation_withShortfall_readableExternally() public {
        vm.prank(market);
        vm.expectEmit(address(reg));
        emit ScoreRegistry.LiquidationRecorded(wallet, market, 123e18, 1, 1, 123e18, uint64(block.timestamp));
        reg.recordLiquidation(wallet, 123e18);
        vm.prank(market);
        reg.recordLiquidation(wallet, 0);
        vm.prank(market);
        reg.recordLiquidation(wallet, 7e18);

        ScoreRegistry.LiquidationRecord memory r = reg.getLiquidationRecord(wallet);
        assertEq(r.liquidationCount, 3);
        assertEq(r.shortfallCount, 2);
        assertEq(r.totalShortfall, 130e18);
    }

    function test_recordLiquidation_worksWhilePaused() public {
        vm.prank(owner);
        reg.pause();
        vm.prank(market);
        reg.recordLiquidation(wallet, 1);
        assertEq(reg.getLiquidationRecord(wallet).liquidationCount, 1);
    }

    function test_revert_recordLiquidation_notMarket() public {
        vm.expectRevert(ScoreRegistry.NotMarket.selector);
        reg.recordLiquidation(wallet, 0);
    }

    function test_revert_recordLiquidation_deauthorizedMarket() public {
        vm.prank(owner);
        reg.setMarket(market, false);
        vm.prank(market);
        vm.expectRevert(ScoreRegistry.NotMarket.selector);
        reg.recordLiquidation(wallet, 0);
    }

    // ---------------------------------------------------------------- admin

    function test_constructor_revertsZeroAttestor() public {
        vm.expectRevert(ScoreRegistry.ZeroAddress.selector);
        new ScoreRegistry(owner, address(0));
    }

    function test_setAttestor_bumpsEpochAndEmits() public {
        address next = makeAddr("next");
        vm.expectEmit(address(reg));
        emit ScoreRegistry.AttestorRotated(attestor, next, 2);
        vm.prank(owner);
        reg.setAttestor(next);
        assertEq(reg.attestor(), next);
        assertEq(reg.attestorEpoch(), 2);
    }

    function test_revert_setAttestor_zero() public {
        vm.prank(owner);
        vm.expectRevert(ScoreRegistry.ZeroAddress.selector);
        reg.setAttestor(address(0));
    }

    function test_revert_setAttestor_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reg.setAttestor(makeAddr("x"));
    }

    function test_revert_setMarket_zero() public {
        vm.prank(owner);
        vm.expectRevert(ScoreRegistry.ZeroAddress.selector);
        reg.setMarket(address(0), true);
    }

    function test_revert_setMarket_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reg.setMarket(makeAddr("m"), true);
    }

    function test_revert_pause_notOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reg.pause();
    }

    function test_unpause_restoresSubmission() public {
        vm.startPrank(owner);
        reg.pause();
        reg.unpause();
        vm.stopPrank();
        _submit(_att(700, 0));
    }

    function test_revert_unpause_notOwner() public {
        vm.prank(owner);
        reg.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        reg.unpause();
    }

    function test_twoStepOwnership() public {
        address next = makeAddr("nextOwner");
        vm.prank(owner);
        reg.transferOwnership(next);
        assertEq(reg.owner(), owner, "not transferred until accepted");
        vm.prank(next);
        reg.acceptOwnership();
        assertEq(reg.owner(), next);
    }
}
