/** Read-only access to the deployed ScoreRegistry. */
import { parseAbi, type Address, type PublicClient } from 'viem'
import type { LiquidationRecord } from './policy.js'

export const registryAbi = parseAbi([
  'function nonces(address wallet) view returns (uint256)',
  'function attestor() view returns (address)',
  'function getScore(address wallet) view returns (uint16 score, uint64 issuedAt, uint64 expiresAt, bool isStale)',
  'function getLiquidationRecord(address wallet) view returns ((uint64 lastLiquidatedAt, uint32 liquidationCount, uint32 shortfallCount, uint256 totalShortfall))',
  'function effectiveTier(address wallet) view returns (uint8 tier, uint16 score)',
  'function submitAttestation((address wallet, uint16 score, uint64 issuedAt, uint64 expiresAt, uint64 deadline, uint256 nonce, bytes32 modelVersion) a, bytes signature)',
  // Custom errors, so reverts decode to names (ScoreRegistry.sol, RiskParams.sol).
  'error ZeroAddress()',
  'error InvalidSigner()',
  'error InvalidNonce(uint256 expected, uint256 provided)',
  'error DeadlinePassed()',
  'error AttestationExpired()',
  'error IssuedInFuture()',
  'error TtlTooLong()',
  'error NotNewer()',
  'error IssuedBeforeLiquidation()',
  'error NotMarket()',
  'error ScoreOutOfRange(uint16 score)',
  'error EnforcedPause()',
  'function hashAttestation((address wallet, uint16 score, uint64 issuedAt, uint64 expiresAt, uint64 deadline, uint256 nonce, bytes32 modelVersion) a) view returns (bytes32)',
])

export interface OnChainScore {
  score: number
  issuedAt: number
  expiresAt: number
  isStale: boolean
}

export interface RegistryReader {
  nonce(wallet: Address): Promise<bigint>
  attestor(): Promise<Address>
  liquidationRecord(wallet: Address): Promise<LiquidationRecord>
  onChainScore(wallet: Address): Promise<OnChainScore>
}

export class ViemRegistryReader implements RegistryReader {
  constructor(
    private readonly client: PublicClient,
    private readonly address: Address,
  ) {}

  nonce(wallet: Address) {
    return this.client.readContract({ address: this.address, abi: registryAbi, functionName: 'nonces', args: [wallet] })
  }

  attestor() {
    return this.client.readContract({ address: this.address, abi: registryAbi, functionName: 'attestor' })
  }

  async liquidationRecord(wallet: Address): Promise<LiquidationRecord> {
    const r = await this.client.readContract({
      address: this.address,
      abi: registryAbi,
      functionName: 'getLiquidationRecord',
      args: [wallet],
    })
    return {
      lastLiquidatedAt: Number(r.lastLiquidatedAt),
      liquidationCount: r.liquidationCount,
      shortfallCount: r.shortfallCount,
      totalShortfall: r.totalShortfall,
    }
  }

  async onChainScore(wallet: Address): Promise<OnChainScore> {
    const [score, issuedAt, expiresAt, isStale] = await this.client.readContract({
      address: this.address,
      abi: registryAbi,
      functionName: 'getScore',
      args: [wallet],
    })
    return { score, issuedAt: Number(issuedAt), expiresAt: Number(expiresAt), isStale }
  }
}
