// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {RiskParams} from "./RiskParams.sol";

/// @title ScoreRegistry
/// @notice Stores ChainScore scores that an authorized attestor has signed
/// (EIP-712), and Tenor's own liquidation history for each wallet.
///
/// Two sources, labelled separately:
///  - ChainScore supplies a score: an off-chain model output, signed by the
///    attestor.
///  - Tenor policy is enforced here: a Tenor liquidation immediately
///    invalidates the wallet's current score, and any attestation issued at or
///    before that liquidation is rejected. The penalty therefore does not rely
///    on off-chain code.
///
/// A Tenor liquidation is the same kind of event ChainScore predicts. The
/// registry records it, and TenorMarket's events record the terms it happened
/// under, so future model versions can learn from Monad-native outcomes.
contract ScoreRegistry is EIP712, Ownable2Step, Pausable {
    /// @dev Scores are valid for at most this long after issuedAt.
    uint64 public constant MAX_TTL = 2 days;

    /// @dev Tolerated clock difference between the attestor and the chain.
    uint64 public constant MAX_CLOCK_SKEW = 60;

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "ScoreAttestation(address wallet,uint16 score,uint64 issuedAt,uint64 expiresAt,uint64 deadline,uint256 nonce,bytes32 modelVersion)"
    );

    struct Attestation {
        address wallet;
        uint16 score;
        /// @dev When the underlying data was scored, not when it was signed.
        uint64 issuedAt;
        uint64 expiresAt;
        /// @dev Submit-by time for this signature.
        uint64 deadline;
        uint256 nonce;
        bytes32 modelVersion;
    }

    struct ScoreRecord {
        uint16 score;
        uint64 issuedAt;
        uint64 expiresAt;
        uint32 attestorEpoch;
    }

    struct LiquidationRecord {
        uint64 lastLiquidatedAt;
        uint32 liquidationCount;
        uint32 shortfallCount;
        uint256 totalShortfall;
    }

    address public attestor;
    /// @dev Bumped on every attestor rotation; scores from older epochs are stale.
    uint32 public attestorEpoch;

    mapping(address wallet => ScoreRecord) internal _scores;
    mapping(address wallet => LiquidationRecord) internal _liquidations;
    mapping(address wallet => uint256) public nonces;
    mapping(address market => bool) public isMarket;

    event AttestationSubmitted(
        address indexed wallet,
        uint16 score,
        uint64 issuedAt,
        uint64 expiresAt,
        uint256 nonce,
        bytes32 modelVersion,
        uint32 attestorEpoch
    );
    event AttestorRotated(address indexed previousAttestor, address indexed newAttestor, uint32 epoch);
    event MarketSet(address indexed market, bool authorized);
    event LiquidationRecorded(
        address indexed wallet,
        address indexed market,
        uint256 shortfall,
        uint32 liquidationCount,
        uint32 shortfallCount,
        uint256 totalShortfall,
        uint64 timestamp
    );

    error ZeroAddress();
    error InvalidSigner();
    error InvalidNonce(uint256 expected, uint256 provided);
    error DeadlinePassed();
    error AttestationExpired();
    error IssuedInFuture();
    error TtlTooLong();
    error NotNewer();
    error IssuedBeforeLiquidation();
    error NotMarket();

    constructor(address owner_, address attestor_) EIP712("Tenor ScoreRegistry", "1") Ownable(owner_) {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        attestorEpoch = 1;
        emit AttestorRotated(address(0), attestor_, 1);
    }

    // ------------------------------------------------------------------ writes

    /// @notice Store a signed score. Permissionless: the signature binds the
    /// wallet, so anyone may relay it.
    /// @dev chainId and verifyingContract are bound through the EIP-712 domain
    /// separator. OpenZeppelin's EIP712 rebuilds it whenever block.chainid
    /// differs from the deployment chain, so a signature cannot be replayed on
    /// a fork.
    function submitAttestation(Attestation calldata a, bytes calldata signature) external whenNotPaused {
        if (a.wallet == address(0)) revert ZeroAddress();
        if (a.nonce != nonces[a.wallet]) revert InvalidNonce(nonces[a.wallet], a.nonce);
        if (block.timestamp > a.deadline) revert DeadlinePassed();
        if (block.timestamp >= a.expiresAt) revert AttestationExpired();
        if (a.issuedAt > block.timestamp + MAX_CLOCK_SKEW) revert IssuedInFuture();
        if (a.expiresAt > a.issuedAt + MAX_TTL) revert TtlTooLong();
        RiskParams.scoreToTier(a.score); // reverts ScoreOutOfRange outside 300..850

        ScoreRecord storage current = _scores[a.wallet];
        if (a.issuedAt <= current.issuedAt) revert NotNewer();
        if (a.issuedAt <= _liquidations[a.wallet].lastLiquidatedAt) revert IssuedBeforeLiquidation();

        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(_structHash(a)), signature);
        if (err != ECDSA.RecoverError.NoError || signer != attestor) revert InvalidSigner();

        nonces[a.wallet] = a.nonce + 1;
        _scores[a.wallet] = ScoreRecord({
            score: a.score, issuedAt: a.issuedAt, expiresAt: a.expiresAt, attestorEpoch: attestorEpoch
        });

        emit AttestationSubmitted(a.wallet, a.score, a.issuedAt, a.expiresAt, a.nonce, a.modelVersion, attestorEpoch);
    }

    /// @notice Record a Tenor liquidation against a wallet. Called by an
    /// authorized market on every liquidation, with any bad debt left over.
    /// @dev Deliberately not blocked by pause: liquidation history must never
    /// be lost.
    function recordLiquidation(address wallet, uint256 shortfall) external {
        if (!isMarket[msg.sender]) revert NotMarket();
        LiquidationRecord storage r = _liquidations[wallet];
        r.lastLiquidatedAt = SafeCast.toUint64(block.timestamp);
        r.liquidationCount += 1;
        if (shortfall > 0) {
            r.shortfallCount += 1;
            r.totalShortfall += shortfall;
        }
        emit LiquidationRecorded(
            wallet, msg.sender, shortfall, r.liquidationCount, r.shortfallCount, r.totalShortfall, r.lastLiquidatedAt
        );
    }

    // ------------------------------------------------------------------- admin

    /// @notice Rotate the attestor key. Every score signed under the previous
    /// key becomes stale immediately.
    function setAttestor(address newAttestor) external onlyOwner {
        if (newAttestor == address(0)) revert ZeroAddress();
        emit AttestorRotated(attestor, newAttestor, attestorEpoch + 1);
        attestor = newAttestor;
        attestorEpoch += 1;
    }

    function setMarket(address market, bool authorized) external onlyOwner {
        if (market == address(0)) revert ZeroAddress();
        isMarket[market] = authorized;
        emit MarketSet(market, authorized);
    }

    /// @notice Pause blocks new attestations only. Reads and liquidation
    /// records keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------- reads

    /// @notice The wallet's stored score and whether it is stale. Consumers
    /// must handle `isStale`; this never returns an outdated number as fresh.
    /// A score is stale if it is missing, expired, signed under a rotated
    /// attestor key, or issued at or before the wallet's last Tenor liquidation.
    function getScore(address wallet)
        external
        view
        returns (uint16 score, uint64 issuedAt, uint64 expiresAt, bool isStale)
    {
        ScoreRecord memory r = _scores[wallet];
        return (r.score, r.issuedAt, r.expiresAt, _isStale(wallet, r));
    }

    /// @notice The tier the wallet is priced at right now: its score's tier if
    /// the score is fresh, otherwise FLOOR.
    function effectiveTier(address wallet) external view returns (RiskParams.Tier tier, uint16 score) {
        ScoreRecord memory r = _scores[wallet];
        if (_isStale(wallet, r)) return (RiskParams.Tier.FLOOR, 0);
        return (RiskParams.scoreToTier(r.score), r.score);
    }

    function getLiquidationRecord(address wallet) external view returns (LiquidationRecord memory) {
        return _liquidations[wallet];
    }

    function hashAttestation(Attestation calldata a) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(a));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _isStale(address wallet, ScoreRecord memory r) internal view returns (bool) {
        return r.score == 0 || block.timestamp >= r.expiresAt || r.attestorEpoch != attestorEpoch
            || r.issuedAt <= _liquidations[wallet].lastLiquidatedAt;
    }

    function _structHash(Attestation calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH, a.wallet, a.score, a.issuedAt, a.expiresAt, a.deadline, a.nonce, a.modelVersion
            )
        );
    }
}
