import { getLivePrice } from './priceService';

interface Position {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  side: 'long' | 'short';
  stopLoss: number;
  takeProfit: number;
  unrealizedPnL: number;
  unrealizedPnLPercentage: number;
  value: number;
  timestamp: number;
}

interface Portfolio {
  totalBalance: number;
  availableBalance: number;
  positions: Map<string, Position>;
  totalPnL: number;
  totalPnLPercentage: number;
  exposure: number;
  marginUsage: number;
}

interface RiskParameters {
  maxPositionSize: number; // Maximum size for any single position
  maxTotalExposure: number; // Maximum total exposure as percentage of portfolio
  riskPerTrade: number; // Risk per trade as percentage of portfolio
  maxDrawdown: number; // Maximum allowed drawdown
  stopLossPercentage: number; // Default stop loss percentage
  takeProfitPercentage: number; // Default take profit percentage
}

export class PortfolioManager {
  private portfolio: Portfolio;
  private riskParams: RiskParameters;
  private symbolsInfo: Map<string, { minQty: number; tickSize: number }>;

  constructor(initialBalance: number, riskParams: RiskParameters) {
    this.portfolio = {
      totalBalance: initialBalance,
      availableBalance: initialBalance,
      positions: new Map(),
      totalPnL: 0,
      totalPnLPercentage: 0,
      exposure: 0,
      marginUsage: 0
    };
    this.riskParams = riskParams;
    this.symbolsInfo = new Map();
  }

  // Position Management
  async openPosition(
    symbol: string,
    side: 'long' | 'short',
    price: number,
    stopLoss: number,
    takeProfit: number
  ): Promise<Position | null> {
    // Check if we can open a new position based on risk parameters
    if (!this.canOpenPosition(symbol, price)) {
      return null;
    }

    // Calculate position size based on risk management rules
    const quantity = this.calculatePositionSize(
      price,
      stopLoss,
      this.portfolio.totalBalance
    );

    if (quantity <= 0) return null;

    const position: Position = {
      symbol,
      entryPrice: price,
      currentPrice: price,
      quantity,
      side,
      stopLoss,
      takeProfit,
      unrealizedPnL: 0,
      unrealizedPnLPercentage: 0,
      value: price * quantity,
      timestamp: Date.now()
    };

    this.portfolio.positions.set(symbol, position);
    this.updatePortfolioMetrics();

    return position;
  }

  async closePosition(symbol: string): Promise<boolean> {
    const position = this.portfolio.positions.get(symbol);
    if (!position) return false;

    // Update portfolio balance with realized PnL
    this.portfolio.totalBalance += position.unrealizedPnL;
    this.portfolio.availableBalance += position.value + position.unrealizedPnL;
    this.portfolio.positions.delete(symbol);
    this.updatePortfolioMetrics();

    return true;
  }

  // Risk Management
  private calculatePositionSize(
    entryPrice: number,
    stopLoss: number,
    portfolioValue: number
  ): number {
    const riskAmount = portfolioValue * (this.riskParams.riskPerTrade / 100);
    const stopLossDistance = Math.abs(entryPrice - stopLoss);
    const positionSize = riskAmount / stopLossDistance;

    // Apply position size limits
    const maxPositionByRisk =
      portfolioValue * (this.riskParams.maxPositionSize / 100);
    const limitedPositionSize = Math.min(positionSize, maxPositionByRisk);

    // Round to symbol's minimum quantity
    return this.roundToMinQty(limitedPositionSize);
  }

  private canOpenPosition(symbol: string, price: number): boolean {
    // Check total exposure
    const currentExposure = this.calculateTotalExposure();
    if (currentExposure >= this.riskParams.maxTotalExposure) {
      return false;
    }

    // Check drawdown
    if (this.calculateDrawdown() >= this.riskParams.maxDrawdown) {
      return false;
    }

    // Check available balance
    const estimatedPositionValue = this.calculateEstimatedPositionValue(price);
    return this.portfolio.availableBalance >= estimatedPositionValue;
  }

  // Portfolio Metrics
  async updatePortfolioMetrics(): Promise<void> {
    let totalValue = this.portfolio.availableBalance;
    let totalPnL = 0;

    for (const [symbol, position] of this.portfolio.positions) {
      const currentPrice = await getLivePrice(symbol);
      position.currentPrice = parseFloat(currentPrice.price);

      // Update position metrics
      position.unrealizedPnL = this.calculateUnrealizedPnL(position);
      position.unrealizedPnLPercentage =
        (position.unrealizedPnL / position.value) * 100;
      position.value = position.currentPrice * position.quantity;

      totalValue += position.value;
      totalPnL += position.unrealizedPnL;
    }

    this.portfolio.totalBalance = totalValue;
    this.portfolio.totalPnL = totalPnL;
    this.portfolio.totalPnLPercentage =
      (totalPnL / this.portfolio.totalBalance) * 100;
    this.portfolio.exposure = this.calculateTotalExposure();
    this.portfolio.marginUsage =
      ((totalValue - this.portfolio.availableBalance) / totalValue) * 100;
  }

  private calculateUnrealizedPnL(position: Position): number {
    const multiplier = position.side === 'long' ? 1 : -1;
    return (
      (position.currentPrice - position.entryPrice) *
      position.quantity *
      multiplier
    );
  }

  private calculateTotalExposure(): number {
    let totalExposure = 0;
    for (const position of this.portfolio.positions.values()) {
      totalExposure += (position.value / this.portfolio.totalBalance) * 100;
    }
    return totalExposure;
  }

  private calculateDrawdown(): number {
    const peak = Math.max(this.portfolio.totalBalance, this.getHighWaterMark());
    return ((peak - this.portfolio.totalBalance) / peak) * 100;
  }

  // Helper Methods
  private roundToMinQty(quantity: number): number {
    // Round to the minimum quantity allowed by the exchange
    return Math.floor(quantity * 1e8) / 1e8;
  }

  private calculateEstimatedPositionValue(price: number): number {
    return (
      price *
      this.calculatePositionSize(
        price,
        price * (1 - this.riskParams.stopLossPercentage / 100),
        this.portfolio.totalBalance
      )
    );
  }

  private getHighWaterMark(): number {
    // Implement high water mark tracking
    return this.portfolio.totalBalance;
  }

  // Getters
  getPortfolio(): Portfolio {
    return this.portfolio;
  }

  getPosition(symbol: string): Position | undefined {
    return this.portfolio.positions.get(symbol);
  }

  getAllPositions(): Position[] {
    return Array.from(this.portfolio.positions.values());
  }

  getAvailableBalance(): number {
    return this.portfolio.availableBalance;
  }

  getTotalBalance(): number {
    return this.portfolio.totalBalance;
  }

  // Risk Parameter Management
  updateRiskParameters(params: Partial<RiskParameters>): void {
    this.riskParams = { ...this.riskParams, ...params };
  }

  getRiskParameters(): RiskParameters {
    return this.riskParams;
  }
}
