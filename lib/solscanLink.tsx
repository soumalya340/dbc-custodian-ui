export function solscanLink(sig: string, network: 'devnet' | 'mainnet'): string {
    const cluster = network === 'devnet' ? '?cluster=devnet' : '';
    return `https://solscan.io/tx/${sig}${cluster}`;
  }
  