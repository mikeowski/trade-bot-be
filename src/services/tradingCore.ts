import { TechnicalIndicators } from './indicatorService';

export interface Trade {
  time: number;
  type: 'buy' | 'sell';
  price: number;
  quantity: number;
  balance: number;
  profit: number;
  profitPercentage: number;
}

export interface Position {
  inPosition: boolean;
  entryPrice: number;
  quantity: number;
  side: 'long' | 'short';
}

export interface IndicatorValues {
  rsi: number;
  macd: {
    value: number;
    signal: number;
    histogram: number;
  };
  price: number;
  sma?: number;
  ema?: number;
  bb?: {
    upper: number;
    middle: number;
    lower: number;
  };
}

export interface TradeMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  totalProfit: number;
  maxDrawdown: number;
  averageProfit: number;
  averageLoss: number;
  sharpeRatio: number;
  totalWinAmount: number;
  totalLossAmount: number;
}

export class TradingCore {
  protected initialBalance: number;
  protected currentBalance: number;
  protected trades: any[];
  protected equity: number[];
  protected drawdowns: number[];
  protected position: {
    inPosition: boolean;
    entryPrice: number;
    quantity: number;
    side: 'long' | 'short';
  };

  constructor(initialBalance: number) {
    this.initialBalance = initialBalance;
    this.currentBalance = initialBalance;
    this.trades = [];
    this.equity = [initialBalance];
    this.drawdowns = [0];
    this.position = {
      inPosition: false,
      entryPrice: 0,
      quantity: 0,
      side: 'long'
    };
  }

  protected executeEntry(
    timestamp: number,
    price: number,
    quantity: number
  ): void {
    if (this.position.inPosition) {
      throw new Error('Already in position');
    }

    this.position = {
      inPosition: true,
      entryPrice: price,
      quantity,
      side: 'long'
    };
  }

  protected executeExit(timestamp: number, price: number): void {
    if (!this.position.inPosition) {
      throw new Error('Not in position');
    }

    const profit = (price - this.position.entryPrice) * this.position.quantity;
    this.currentBalance += profit;

    this.trades.push({
      entryTime: timestamp,
      exitTime: timestamp,
      entryPrice: this.position.entryPrice,
      exitPrice: price,
      quantity: this.position.quantity,
      profit,
      profitPercentage:
        (profit / (this.position.entryPrice * this.position.quantity)) * 100,
      type: this.position.side
    });

    this.position = {
      inPosition: false,
      entryPrice: 0,
      quantity: 0,
      side: 'long'
    };
  }

  protected getMetrics(): TradeMetrics {
    const winningTrades = this.trades.filter((t) => t.profit > 0);
    const losingTrades = this.trades.filter((t) => t.profit < 0);
    const totalWinAmount = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLossAmount = Math.abs(
      losingTrades.reduce((sum, t) => sum + t.profit, 0)
    );

    const winRate = (winningTrades.length / this.trades.length) * 100;
    const profitFactor =
      totalLossAmount === 0 ? 0 : totalWinAmount / totalLossAmount;
    const totalProfit = this.currentBalance - this.initialBalance;

    // Calculate max drawdown
    let maxDrawdown = 0;
    let peak = this.initialBalance;
    let runningBalance = this.initialBalance;

    this.trades.forEach((trade) => {
      runningBalance += trade.profit;
      if (runningBalance > peak) {
        peak = runningBalance;
      }
      const drawdown = ((peak - runningBalance) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    });

    // Calculate Sharpe ratio
    const returns = this.trades.map((t) => t.profitPercentage);
    const averageReturn =
      returns.length > 0
        ? returns.reduce((a, b) => a + b, 0) / returns.length
        : 0;
    const variance =
      returns.length > 1
        ? returns.reduce((a, b) => a + Math.pow(b - averageReturn, 2), 0) /
          (returns.length - 1)
        : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio =
      stdDev === 0 ? 0 : (averageReturn / stdDev) * Math.sqrt(252); // Annualized

    return {
      totalTrades: this.trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate,
      profitFactor,
      totalProfit,
      maxDrawdown,
      averageProfit:
        winningTrades.length > 0 ? totalWinAmount / winningTrades.length : 0,
      averageLoss:
        losingTrades.length > 0 ? totalLossAmount / losingTrades.length : 0,
      sharpeRatio,
      totalWinAmount,
      totalLossAmount
    };
  }

  protected getPosition() {
    return this.position;
  }

  protected getCurrentBalance() {
    return this.currentBalance;
  }

  protected getTrades() {
    return this.trades;
  }

  protected getEquityCurve() {
    return this.equity;
  }

  protected getDrawdowns() {
    return this.drawdowns;
  }
}
