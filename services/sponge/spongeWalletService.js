/**
 * Sponge Wallet Service (paysponge.com)
 *
 * Transfers USDC on Base network from the AI agent's funded wallet
 * to a destination Coinbase address. Acts as the on-chain "green light"
 * proving agentic spending authorization before the Wise payout fires.
 *
 * API: https://api.wallet.paysponge.com
 * Docs: https://docs.paysponge.com
 */

const SPONGE_API_BASE = 'https://api.wallet.paysponge.com';
const SPONGE_VERSION  = '0.2.1';

class SpongeWalletService {
  constructor() {
    this.apiKey             = process.env.SPONGE_API_KEY;
    this.destinationAddress = process.env.SPONGE_COINBASE_DESTINATION_ADDRESS;
  }

  /**
   * Transfer USDC on Base to the configured Coinbase destination address.
   *
   * @param {Object} params
   * @param {number} params.amountUSD   - USD amount (1 USDC = 1 USD)
   * @param {string} params.upiId       - Target UPI ID, used in memo for audit trail
   * @param {string} params.transferId  - Our internal pending transfer ID for traceability
   * @returns {Promise<{ txHash: string, amount: number, destination: string }>}
   */
  async transferUSDC({ amountUSD, upiId, transferId }) {
    if (!this.apiKey) {
      throw new Error('SPONGE_API_KEY not configured');
    }
    if (!this.destinationAddress) {
      throw new Error('SPONGE_COINBASE_DESTINATION_ADDRESS not configured');
    }

    const amount = Number(amountUSD.toFixed(2));
    const memo   = `Vitta Agent Auth | UPI: ${upiId} | ref: ${transferId}`;

    console.log('[SpongeWallet] ▶ Initiating USDC transfer');
    console.log(`[SpongeWallet]   Amount: ${amount} USDC`);
    console.log(`[SpongeWallet]   Destination: ${this.destinationAddress}`);
    console.log(`[SpongeWallet]   Memo: ${memo}`);

    const response = await fetch(`${SPONGE_API_BASE}/api/v1/wallets/transfer`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${this.apiKey}`,
        'Content-Type':   'application/json',
        'Sponge-Version': SPONGE_VERSION,
      },
      body: JSON.stringify({
        amount,
        token:       'USDC',
        chain:       'base',
        destination: this.destinationAddress,
        memo,
      }),
      signal: AbortSignal.timeout(30000),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Sponge API returned non-JSON response (status ${response.status})`);
    }

    if (!response.ok) {
      console.error('[SpongeWallet] ✗ API error:', data);
      throw new Error(`Sponge API error ${response.status}: ${data.message || data.error || response.statusText}`);
    }

    const txHash = data.txHash || data.tx_hash || data.transaction_hash;

    if (!txHash) {
      console.error('[SpongeWallet] ✗ No txHash in response:', data);
      throw new Error('Sponge transfer succeeded but no txHash returned');
    }

    console.log(`[SpongeWallet] ✓ USDC transferred | txHash=${txHash}`);

    return {
      txHash,
      amount,
      token:       'USDC',
      chain:       'base',
      destination: this.destinationAddress,
      memo,
    };
  }

  isConfigured() {
    return !!(this.apiKey && this.destinationAddress);
  }
}

module.exports = new SpongeWalletService();
