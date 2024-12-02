import { TradingCore } from './tradingCore';
import { TechnicalIndicators, KlineData } from './indicatorService';
import { BacktestResult, Trade } from './strategyService';

interface DebugData {
  indicatorValues: Array<{
    time: number;
    [key: string]: any;
  }>;
  conditions: {
    entry: boolean[];
    exit: boolean[];
  };
}

export interface BacktestingResult extends BacktestResult {
  debug?: DebugData;
}

export class BacktestingService extends TradingCore {
  constructor(initialBalance: number = 10000) {
    super(initialBalance);
  }

  async runBacktest(
    historicalData: {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }[],
    strategy: {
      indicators: { [key: string]: any };
      entryConditions: any[];
      exitConditions: any[];
      riskManagement: {
        stopLoss: number;
        takeProfit: number;
        maxPositionSize: number;
      };
    }
  ): Promise<BacktestingResult> {
    if (historicalData.length < 50) {
      throw new Error('Insufficient historical data for backtesting');
    }

    // Reset state for new backtest
    this.currentBalance = this.initialBalance;
    this.trades = [];
    this.equity = [this.initialBalance];
    this.drawdowns = [0];
    this.position = {
      inPosition: false,
      entryPrice: 0,
      quantity: 0,
      side: 'long'
    };

    // Convert historical data to KlineData format
    const klines: KlineData[] = historicalData.map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      closeTime: candle.time
    }));

    // Validate and calculate indicators
    try {
      TechnicalIndicators.validateKlineData(klines, 50);
      const indicatorValues = this.calculateIndicatorSeries(
        historicalData.map((d) => d.close),
        strategy.indicators
      );

      const debugData: DebugData = {
        indicatorValues: [],
        conditions: {
          entry: [],
          exit: []
        }
      };

      // Run simulation
      for (let i = 50; i < historicalData.length; i++) {
        const candle = historicalData[i];
        const context = this.createIndicatorContext(i, indicatorValues, candle);

        // Store debug data
        debugData.indicatorValues.push({
          time: candle.time,
          ...context
        });

        // Check for exit conditions first if in position
        if (this.position.inPosition) {
          const stopLossPrice =
            this.position.entryPrice *
            (1 - strategy.riskManagement.stopLoss / 100);
          const takeProfitPrice =
            this.position.entryPrice *
            (1 + strategy.riskManagement.takeProfit / 100);

          const shouldExit =
            candle.low <= stopLossPrice ||
            candle.high >= takeProfitPrice ||
            this.checkExitConditions(strategy.exitConditions, context);

          debugData.conditions.exit.push(shouldExit);

          if (shouldExit) {
            const exitPrice =
              candle.low <= stopLossPrice
                ? stopLossPrice
                : candle.high >= takeProfitPrice
                ? takeProfitPrice
                : candle.close;

            this.executeExit(candle.time, exitPrice);
          }
        }
        // Check for entry conditions if not in position
        else {
          const shouldEnter = this.checkEntryConditions(
            strategy.entryConditions,
            context
          );
          debugData.conditions.entry.push(shouldEnter);

          if (shouldEnter) {
            // Calculate position size based on risk
            const stopLossPrice =
              candle.close * (1 - strategy.riskManagement.stopLoss / 100);
            const riskPerTrade = this.currentBalance * 0.01; // Risk 1% per trade
            const riskPerUnit = candle.close - stopLossPrice;
            const quantity = Math.min(
              riskPerTrade / riskPerUnit,
              (this.currentBalance * strategy.riskManagement.maxPositionSize) /
                100 /
                candle.close
            );

            if (quantity > 0) {
              this.executeEntry(candle.time, candle.close, quantity);
            }
          }
        }

        // Update equity curve and drawdown after each candle
        this.updateEquity(candle.close);
      }

      const metrics = this.calculateMetrics(this.trades);
      const result: BacktestingResult = {
        trades: this.trades,
        metrics,
        equity: this.equity,
        drawdowns: this.drawdowns,
        finalBalance: this.currentBalance,
        debug: debugData
      };

      return result;
    } catch (error) {
      console.error('Backtest error:', error);
      throw error;
    }
  }

  private calculateSharpeRatio(): number {
    if (this.trades.length < 2) return 0;

    const returns = this.trades.map((t) => t.profitPercentage);
    const averageReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, b) => a + Math.pow(b - averageReturn, 2), 0) /
      (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    return stdDev === 0 ? 0 : (averageReturn / stdDev) * Math.sqrt(252); // Annualized
  }

  private calculateIndicatorSeries(
    prices: number[],
    indicators: { [key: string]: any }
  ): { [key: string]: number[][] } {
    const results: { [key: string]: number[][] } = {};

    // Convert prices array to KlineData array
    const klines: KlineData[] = prices.map((price, index) => ({
      time: index,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      closeTime: index
    }));

    for (const [name, config] of Object.entries(indicators)) {
      try {
        switch (config.type.toLowerCase()) {
          case 'rsi':
            results[name] = TechnicalIndicators.calculateRSI(
              klines,
              config.params?.period || 14
            ).map((r) => [r.value]);
            break;

          case 'macd':
            results[name] = TechnicalIndicators.calculateMACD(
              klines,
              config.params?.fastPeriod || 12,
              config.params?.slowPeriod || 26,
              config.params?.signalPeriod || 9
            ).map((m) => m.value);
            break;

          case 'bb':
            const bb = TechnicalIndicators.calculateBollingerBands(
              klines,
              config.params?.period || 20,
              config.params?.stdDev || 2
            );
            results[name] = prices.map((_, i) => [
              bb.upper[i],
              bb.middle[i],
              bb.lower[i]
            ]);
            break;

          case 'sma':
            results[name] = TechnicalIndicators.calculateSMA(
              klines,
              config.params?.period || 20
            ).map((v) => [typeof v.value === 'number' ? v.value : v.value[0]]);
            break;

          case 'ema':
            results[name] = TechnicalIndicators.calculateEMA(
              klines,
              config.params?.period || 20
            ).map((v) => [typeof v.value === 'number' ? v.value : v.value[0]]);
            break;

          default:
            throw new Error(`Unknown indicator type: ${config.type}`);
        }
      } catch (error) {
        console.error(`Error calculating ${name}:`, error);
        throw new Error(
          `Failed to calculate ${name} indicator: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    }

    return results;
  }

  private createIndicatorContext(
    index: number,
    indicators: { [key: string]: number[][] },
    candle: any
  ): any {
    const context: any = {
      price: candle.close,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume
    };

    for (const [name, values] of Object.entries(indicators)) {
      if (values[index]) {
        // Handle single value indicators
        if (Array.isArray(values[index]) && values[index].length === 1) {
          context[name] = values[index][0];
        }
        // Handle multi-value indicators (like MACD)
        else if (Array.isArray(values[index])) {
          context[name] = values[index];
          // Add individual components for easier access
          if (name === 'macd') {
            context.macd_value = values[index][0];
            context.macd_signal = values[index][1];
            context.macd_histogram = values[index][2];
          }
          // Add Bollinger Bands components
          else if (name === 'bb') {
            context.bb_upper = values[index][0];
            context.bb_middle = values[index][1];
            context.bb_lower = values[index][2];
          }
        }

        // Add previous values for crossover checks
        if (index > 0 && values[index - 1]) {
          const prevValue = values[index - 1];
          context[`prev_${name}`] =
            Array.isArray(prevValue) && prevValue.length === 1
              ? prevValue[0]
              : prevValue;
        }
      }
    }

    return context;
  }

  private checkEntryConditions(conditions: any[], context: any): boolean {
    try {
      return conditions.every((condition) => {
        const value = this.getIndicatorValue(condition.indicator, context);
        const targetValue = condition.targetIndicator
          ? this.getIndicatorValue(condition.targetIndicator, context)
          : Number(condition.value);

        if (value === undefined || targetValue === undefined) {
          console.log(`Warning: Undefined value for indicator check:`, {
            condition,
            value,
            targetValue
          });
          return false;
        }

        return this.evaluateCondition(
          condition.comparison,
          value,
          targetValue,
          context,
          condition.indicator
        );
      });
    } catch (error) {
      console.error('Error in entry conditions:', error);
      return false;
    }
  }

  private checkExitConditions(conditions: any[], context: any): boolean {
    try {
      return conditions.some((condition) => {
        const value = this.getIndicatorValue(condition.indicator, context);
        const targetValue = condition.targetIndicator
          ? this.getIndicatorValue(condition.targetIndicator, context)
          : Number(condition.value);

        if (value === undefined || targetValue === undefined) {
          console.log(`Warning: Undefined value for indicator check:`, {
            condition,
            value,
            targetValue
          });
          return false;
        }

        return this.evaluateCondition(
          condition.comparison,
          value,
          targetValue,
          context,
          condition.indicator
        );
      });
    } catch (error) {
      console.error('Error in exit conditions:', error);
      return false;
    }
  }

  private getIndicatorValue(
    indicator: string,
    context: any
  ): number | undefined {
    // Handle special cases for multi-value indicators
    if (indicator.includes('_')) {
      return context[indicator];
    }
    return context[indicator];
  }

  private evaluateCondition(
    comparison: string,
    value: number,
    targetValue: number,
    context: any,
    indicator: string
  ): boolean {
    switch (comparison) {
      case 'above':
        return value > targetValue;
      case 'below':
        return value < targetValue;
      case 'crosses_above': {
        const prevValue = context[`prev_${indicator}`];
        return (
          prevValue !== undefined &&
          prevValue <= targetValue &&
          value > targetValue
        );
      }
      case 'crosses_below': {
        const prevValue = context[`prev_${indicator}`];
        return (
          prevValue !== undefined &&
          prevValue >= targetValue &&
          value < targetValue
        );
      }
      default:
        return false;
    }
  }

  private updateEquity(currentPrice: number): void {
    const currentEquity = this.position.inPosition
      ? this.currentBalance +
        this.position.quantity * (currentPrice - this.position.entryPrice)
      : this.currentBalance;

    this.equity.push(currentEquity);

    // Calculate drawdown
    const peak = Math.max(...this.equity);
    const drawdown = ((peak - currentEquity) / peak) * 100;
    this.drawdowns.push(drawdown);
  }

  private calculateMetrics(trades: Trade[]): BacktestResult['metrics'] {
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        profitFactor: 0,
        totalProfit: 0,
        maxDrawdown: 0,
        averageProfit: 0,
        averageLoss: 0,
        sharpeRatio: 0
      };
    }

    const winningTrades = trades.filter((t) => t.profit > 0);
    const losingTrades = trades.filter((t) => t.profit < 0);

    const totalProfit = trades.reduce((sum, t) => sum + t.profit, 0);
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const grossLoss = Math.abs(
      losingTrades.reduce((sum, t) => sum + t.profit, 0)
    );

    // Calculate drawdown
    let maxDrawdown = 0;
    let peak = 0;
    let runningProfit = 0;

    trades.forEach((trade) => {
      runningProfit += trade.profit;
      if (runningProfit > peak) {
        peak = runningProfit;
      }
      const drawdown = peak > 0 ? ((peak - runningProfit) / peak) * 100 : 0;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    });

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate:
        trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
      profitFactor:
        grossLoss === 0
          ? grossProfit > 0
            ? Infinity
            : 0
          : grossProfit / grossLoss,
      totalProfit,
      maxDrawdown,
      averageProfit:
        winningTrades.length > 0 ? grossProfit / winningTrades.length : 0,
      averageLoss:
        losingTrades.length > 0 ? grossLoss / losingTrades.length : 0,
      sharpeRatio: this.calculateSharpeRatio()
    };
  }
}
