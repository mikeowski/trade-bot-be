interface RiskParameters {
  maxPositionSize: number;
  maxRiskPerTrade: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
}

interface PositionSize {
  units: number;
  totalValue: number;
  riskAmount: number;
}

export class RiskManagementService {
  private riskParams: RiskParameters;

  constructor(params: RiskParameters) {
    this.riskParams = params;
  }

  calculatePositionSize(
    currentPrice: number,
    accountBalance: number
  ): PositionSize {
    const maxPositionValue =
      accountBalance * (this.riskParams.maxPositionSize / 100);
    const riskAmount = accountBalance * (this.riskParams.maxRiskPerTrade / 100);
    const units = maxPositionValue / currentPrice;

    return {
      units: Math.floor(units * 1e8) / 1e8, // Round to 8 decimal places
      totalValue: maxPositionValue,
      riskAmount
    };
  }

  calculateStopLoss(
    entryPrice: number,
    positionType: 'long' | 'short'
  ): number {
    const stopLossMultiplier = this.riskParams.stopLossPercentage / 100;
    return positionType === 'long'
      ? entryPrice * (1 - stopLossMultiplier)
      : entryPrice * (1 + stopLossMultiplier);
  }

  calculateTakeProfit(
    entryPrice: number,
    positionType: 'long' | 'short'
  ): number {
    const takeProfitMultiplier = this.riskParams.takeProfitPercentage / 100;
    return positionType === 'long'
      ? entryPrice * (1 + takeProfitMultiplier)
      : entryPrice * (1 - takeProfitMultiplier);
  }

  validateTrade(
    price: number,
    size: number,
    accountBalance: number
  ): { valid: boolean; reason?: string } {
    if (
      price * size >
      accountBalance * (this.riskParams.maxPositionSize / 100)
    ) {
      return {
        valid: false,
        reason: 'Position size exceeds maximum allowed'
      };
    }
    return { valid: true };
  }
}
