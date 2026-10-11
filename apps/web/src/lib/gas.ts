import type { Abi, Address, Hex, PublicClient, TransactionReceipt } from 'viem'

/**
 * Gas limit with headroom over the estimate. Observed on Monad testnet
 * (2026-10-11): a withdrawCollateral sent with the plain estimate reverted
 * with "out of gas" in its final token transfer (debug_traceTransaction,
 * tx 0x54b1d2d8…). Why the estimate fell short is not established. Monad
 * charges the gas limit, so the headroom costs a little more MON; that is
 * the trade. (Note: Monad receipts report gasUsed = gas limit for every
 * transaction, so a receipt alone can't show an out-of-gas failure.)
 */
export async function bufferedGas(
  client: PublicClient,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  account: Address,
): Promise<bigint> {
  const estimate = await client.estimateContractGas({ ...call, account } as never)
  return (estimate * 130n) / 100n + 30_000n
}

/** A mined-but-reverted transaction is a failure, never a success. */
export function assertSuccess(receipt: TransactionReceipt, hash: Hex) {
  if (receipt.status !== 'success') {
    throw new Error(`Transaction reverted on-chain (${hash.slice(0, 12)}…). Nothing changed; you can try again.`)
  }
}
