/**
 * EIP-712 signing. The domain must match the deployed ScoreRegistry exactly:
 * name and version from deployments/<chainId>.json (written by the deploy
 * script from the contract's constructor), chainId, and verifyingContract.
 *
 * The key is read from the environment by config.ts and held only inside the
 * viem account. It is never logged, returned, or passed to the frontend.
 */
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

export interface Attestation {
  wallet: Address
  score: number
  issuedAt: bigint
  expiresAt: bigint
  deadline: bigint
  nonce: bigint
  modelVersion: Hex
}

export interface Eip712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

/** Field order and types copied from ScoreRegistry.ATTESTATION_TYPEHASH. */
export const attestationTypes = {
  ScoreAttestation: [
    { name: 'wallet', type: 'address' },
    { name: 'score', type: 'uint16' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'modelVersion', type: 'bytes32' },
  ],
} as const

export function modelVersionHash(version: string): Hex {
  return keccak256(toHex(version))
}

export class AttestationSigner {
  private readonly account: PrivateKeyAccount

  constructor(
    privateKey: Hex,
    private readonly domain: Eip712Domain,
  ) {
    this.account = privateKeyToAccount(privateKey)
  }

  get address(): Address {
    return this.account.address
  }

  sign(a: Attestation): Promise<Hex> {
    return this.account.signTypedData({
      domain: this.domain,
      types: attestationTypes,
      primaryType: 'ScoreAttestation',
      message: a,
    })
  }
}
