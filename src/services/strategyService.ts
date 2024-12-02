import { KlineData, TechnicalIndicators } from './indicatorService';
import { getHistoricalData } from './priceService';
import { RiskManagementService } from './riskManagementService';

interface IndicatorConfig {
  type: string;
  params: {
    [key: string]: number | string;
  };
}

export type IndicatorType =
  | 'rsi'
  | 'macd'
  | 'macd_signal'
  | 'macd_histogram'
  | 'bollinger'
  | 'sma'
  | 'ema';

export interface StrategyCondition {
  indicator: IndicatorType;
  comparison: 'above' | 'below' | 'crosses_above' | 'crosses_below';
  value: number | string;
  targetIndicator?: string;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  indicators: {
    [key in IndicatorType]: IndicatorConfig;
  };
  entryConditions: StrategyCondition[];
  exitConditions: StrategyCondition[];
  riskManagement: {
    stopLoss: number;
    takeProfit: number;
    maxPositionSize: number;
    trailingStop?: number;
  };
}

export interface BacktestResult {
  trades: Trade[];
  metrics: {
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
  };
  equity: number[];
  drawdowns: number[];
  finalBalance: number;
}

export interface Trade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  type: 'long' | 'short';
  quantity: number;
  profit: number;
  profitPercentage: number;
}

export class StrategyManager {
  private strategies: Map<string, Strategy> = new Map();
  private backtestResults: Map<string, BacktestResult> = new Map();

  addStrategy(strategy: Strategy): string {
    if (!strategy.id) {
      strategy.id = this.generateStrategyId();
    }
    this.validateStrategy(strategy);
    this.strategies.set(strategy.id, strategy);
    return strategy.id;
  }

  getStrategy(id: string): Strategy | undefined {
    return this.strategies.get(id);
  }

  getAllStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  updateStrategy(id: string, strategy: Strategy): boolean {
    if (!this.strategies.has(id)) return false;
    this.validateStrategy(strategy);
    this.strategies.set(id, { ...strategy, id });
    return true;
  }

  deleteStrategy(id: string): boolean {
    return this.strategies.delete(id);
  }

  async runBacktest(
    strategyId: string,
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime: number
  ): Promise<BacktestResult> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error('Strategy not found');
    }

    const historicalData = await getHistoricalData(
      symbol,
      timeframe,
      startTime,
      endTime
    );

    const indicatorValues = (await this.calculateIndicators(
      strategy,
      historicalData
    )) as Map<IndicatorType, number[]>;

    const trades = this.simulateTrades(
      strategy,
      historicalData,
      indicatorValues
    );

    const metrics = this.calculateMetrics(trades);

    const equity: number[] = [10000];
    const drawdowns: number[] = [0];
    let currentBalance = 10000;

    trades.forEach((trade) => {
      currentBalance += trade.profit;
      equity.push(currentBalance);

      // Calculate drawdown
      const peak = Math.max(...equity);
      const drawdown = ((peak - currentBalance) / peak) * 100;
      drawdowns.push(drawdown);
    });

    const result: BacktestResult = {
      trades,
      metrics,
      equity,
      drawdowns,
      finalBalance: currentBalance
    };
    this.backtestResults.set(strategyId, result);
    return result;
  }

  getBacktestResult(strategyId: string): BacktestResult | undefined {
    return this.backtestResults.get(strategyId);
  }

  async saveBacktestResult(
    strategyId: string,
    result: BacktestResult
  ): Promise<void> {
    if (!this.strategies.has(strategyId)) {
      throw new Error('Strategy not found');
    }
    this.backtestResults.set(strategyId, result);
  }

  // Private helper methods
  private generateStrategyId(): string {
    return `strat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private validateStrategy(strategy: Strategy): void {
    if (!strategy.name) {
      throw new Error('Missing required strategy fields');
    }

    if (!strategy.indicators || Object.keys(strategy.indicators).length === 0) {
      throw new Error('Strategy must have at least one indicator');
    }

    if (!strategy.entryConditions || strategy.entryConditions.length === 0) {
      throw new Error('Strategy must have at least one entry condition');
    }

    if (!strategy.exitConditions || strategy.exitConditions.length === 0) {
      throw new Error('Strategy must have at least one exit condition');
    }

    if (!strategy.riskManagement) {
      throw new Error('Strategy must have risk management parameters');
    }
  }

  private async calculateIndicators(
    strategy: Strategy,
    historicalData: any[]
  ): Promise<Map<string, number[]>> {
    const indicatorValues = new Map<string, number[]>();

    // Önce verileri KlineData formatına dönüştürelim
    const klines: KlineData[] = historicalData.map((candle) => ({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      closeTime: candle.time + this.getIntervalMs(candle.interval || '1m')
    }));

    for (const [name, config] of Object.entries(strategy.indicators)) {
      try {
        switch (config.type.toLowerCase()) {
          case 'rsi': {
            const rsiResults = TechnicalIndicators.calculateRSI(
              klines,
              (config.params.period as number) || 14
            );
            // RSI değerlerini al ve map'e ekle
            indicatorValues.set(
              name,
              rsiResults.map((r) => r.value)
            );

            break;
          }
          case 'macd': {
            const macdResults = TechnicalIndicators.calculateMACD(
              klines,
              (config.params.fastPeriod as number) || 12,
              (config.params.slowPeriod as number) || 26,
              (config.params.signalPeriod as number) || 9
            );

            indicatorValues.set(
              name,
              macdResults.map((m) => m.value[0])
            );
            indicatorValues.set(
              `${name}_signal`,
              macdResults.map((m) => m.value[1])
            );
            indicatorValues.set(
              `${name}_histogram`,
              macdResults.map((m) => m.value[2])
            );

            break;
          }
          case 'bollinger': {
            const bb = TechnicalIndicators.calculateBollingerBands(
              klines,
              (config.params.period as number) || 20,
              (config.params.stdDev as number) || 2
            );

            // Upper, Middle ve Lower bantları ayrı ayrı sakla
            indicatorValues.set(`${name}_upper`, bb.upper);
            indicatorValues.set(`${name}_middle`, bb.middle);
            indicatorValues.set(`${name}_lower`, bb.lower);

            break;
          }
          case 'sma': {
            const smaResults = TechnicalIndicators.calculateSMA(
              klines,
              (config.params.period as number) || 20
            );
            indicatorValues.set(
              name,
              smaResults.map((r) => r.value) as number[]
            );
            break;
          }
          case 'ema': {
            const emaResults = TechnicalIndicators.calculateEMA(
              klines,
              (config.params.period as number) || 20
            );
            indicatorValues.set(
              name,
              emaResults.map((r) => r.value) as number[]
            );
            break;
          }
          default:
            throw new Error(`Unsupported indicator type: ${config.type}`);
        }
      } catch (error) {
        console.error(`Error calculating ${name} indicator:`, error);
        throw error;
      }
    }

    return indicatorValues;
  }

  private getIntervalMs(interval: string): number {
    const unit = interval.slice(-1);
    const value = parseInt(interval.slice(0, -1));

    switch (unit) {
      case 'm':
        return value * 60 * 1000;
      case 'h':
        return value * 60 * 60 * 1000;
      case 'd':
        return value * 24 * 60 * 60 * 1000;
      case 'w':
        return value * 7 * 24 * 60 * 60 * 1000;
      case 'M':
        return value * 30 * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Invalid interval: ${interval}`);
    }
  }

  private getIndicatorOffsets(strategy: Strategy): number[] {
    const offsets: number[] = [];
    for (const config of Object.values(strategy.indicators)) {
      switch (config.type.toLowerCase()) {
        case 'rsi':
          offsets.push((config.params.period as number) || 14);
          break;
        case 'macd':
          offsets.push(
            Math.max(
              (config.params.fastPeriod as number) || 12,
              (config.params.slowPeriod as number) || 26,
              (config.params.signalPeriod as number) || 9
            )
          );
          break;
        case 'bollinger':
          offsets.push((config.params.period as number) || 20);
          break;
        case 'sma':
        case 'ema':
          offsets.push((config.params.period as number) || 20);
          break;
      }
    }
    return offsets;
  }

  private simulateTrades(
    strategy: Strategy,
    historicalData: any[],
    indicatorValues: Map<IndicatorType, number[]>
  ): Trade[] {
    try {
      const trades: Trade[] = [];
      let inPosition = false;
      let currentTrade: Partial<Trade> = {};
      let accountBalance = 10000; // Starting balance

      // Initialize risk management service
      const riskService = new RiskManagementService({
        maxPositionSize: strategy.riskManagement.maxPositionSize,
        maxRiskPerTrade: strategy.riskManagement.stopLoss,
        stopLossPercentage: strategy.riskManagement.stopLoss,
        takeProfitPercentage: strategy.riskManagement.takeProfit
      });

      // Get starting index based on indicator periods
      const indicatorOffsets = this.getIndicatorOffsets(strategy);
      const startIdx = Math.max(...indicatorOffsets, 1);

      for (let i = startIdx; i < historicalData.length; i++) {
        const candle = historicalData[i];

        if (!inPosition) {
          if (this.checkEntryConditions(strategy, indicatorValues, i)) {
            // Calculate position size based on current balance
            const positionSize = riskService.calculatePositionSize(
              candle.close,
              accountBalance
            );

            // Validate trade before entering
            const validation = riskService.validateTrade(
              candle.close,
              positionSize.units,
              accountBalance
            );

            if (validation.valid && positionSize.units > 0) {
              inPosition = true;
              currentTrade = {
                entryTime: candle.time,
                entryPrice: candle.close,
                type: 'long', // TODO: Add support for short positions
                quantity: positionSize.units
              };
            }
          }
        } else if (
          currentTrade.entryPrice !== undefined &&
          currentTrade.quantity !== undefined
        ) {
          // Calculate stop loss and take profit levels
          const stopLossPrice = riskService.calculateStopLoss(
            currentTrade.entryPrice,
            currentTrade.type as 'long' | 'short'
          );
          const takeProfitPrice = riskService.calculateTakeProfit(
            currentTrade.entryPrice,
            currentTrade.type as 'long' | 'short'
          );

          // Check for exit conditions
          if (
            candle.low <= stopLossPrice ||
            candle.high >= takeProfitPrice ||
            this.checkExitConditions(strategy, indicatorValues, i)
          ) {
            inPosition = false;
            const exitPrice =
              candle.low <= stopLossPrice
                ? stopLossPrice
                : candle.high >= takeProfitPrice
                ? takeProfitPrice
                : candle.close;

            // Calculate profit based on position type
            const profit =
              currentTrade.type === 'long'
                ? (exitPrice - currentTrade.entryPrice) * currentTrade.quantity
                : (currentTrade.entryPrice - exitPrice) * currentTrade.quantity;

            trades.push({
              ...(currentTrade as Trade),
              exitTime: candle.time,
              exitPrice,
              profit,
              profitPercentage:
                (profit / (currentTrade.entryPrice * currentTrade.quantity)) *
                100
            });

            // Update account balance
            accountBalance += profit;
            currentTrade = {};
          }
        }
      }

      return trades;
    } catch (error) {
      console.error('Error during trade simulation:', error);
      throw new Error(`Trade simulation failed: ${error}`);
    }
  }

  private checkEntryConditions(
    strategy: Strategy,
    indicatorValues: Map<string, number[]>,
    index: number
  ): boolean {
    return strategy.entryConditions.every((condition) => {
      const value = this.getIndicatorValue(
        condition.indicator,
        indicatorValues,
        index
      );
      const targetValue = condition.targetIndicator
        ? this.getIndicatorValue(
            condition.targetIndicator,
            indicatorValues,
            index
          )
        : Number(condition.value);

      if (value === undefined || targetValue === undefined) {
        return false;
      }

      switch (condition.comparison) {
        case 'above':
          return value > targetValue;
        case 'below':
          return value < targetValue;
        case 'crosses_above': {
          const prevValue = this.getIndicatorValue(
            condition.indicator,
            indicatorValues,
            index - 1
          );
          return (
            prevValue !== undefined &&
            prevValue <= targetValue &&
            value > targetValue
          );
        }
        case 'crosses_below': {
          const prevValue = this.getIndicatorValue(
            condition.indicator,
            indicatorValues,
            index - 1
          );
          return (
            prevValue !== undefined &&
            prevValue >= targetValue &&
            value < targetValue
          );
        }
        default:
          return false;
      }
    });
  }

  private checkExitConditions(
    strategy: Strategy,
    indicatorValues: Map<string, number[]>,
    index: number
  ): boolean {
    return strategy.exitConditions.some((condition) => {
      const value = this.getIndicatorValue(
        condition.indicator,
        indicatorValues,
        index
      );
      const targetValue = condition.targetIndicator
        ? this.getIndicatorValue(
            condition.targetIndicator,
            indicatorValues,
            index
          )
        : Number(condition.value);

      if (value === undefined || targetValue === undefined) {
        return false;
      }

      switch (condition.comparison) {
        case 'above':
          return value > targetValue;
        case 'below':
          return value < targetValue;
        case 'crosses_above': {
          const prevValue = this.getIndicatorValue(
            condition.indicator,
            indicatorValues,
            index - 1
          );
          return (
            prevValue !== undefined &&
            prevValue <= targetValue &&
            value > targetValue
          );
        }
        case 'crosses_below': {
          const prevValue = this.getIndicatorValue(
            condition.indicator,
            indicatorValues,
            index - 1
          );
          return (
            prevValue !== undefined &&
            prevValue >= targetValue &&
            value < targetValue
          );
        }
        default:
          return false;
      }
    });
  }

  private getIndicatorValue(
    indicator: string,
    indicatorValues: Map<string, number[]>,
    index: number
  ): number | undefined {
    const values = indicatorValues.get(indicator);
    return values ? values[index] : undefined;
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
      const drawdown = ((peak - runningProfit) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    });

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: (winningTrades.length / trades.length) * 100,
      profitFactor: grossLoss === 0 ? 0 : grossProfit / grossLoss,
      totalProfit,
      maxDrawdown,
      averageProfit:
        winningTrades.length > 0 ? grossProfit / winningTrades.length : 0,
      averageLoss:
        losingTrades.length > 0 ? grossLoss / losingTrades.length : 0,
      sharpeRatio: this.calculateSharpeRatio(trades)
    };
  }

  private calculateSharpeRatio(trades: Trade[]): number {
    if (trades.length < 2) return 0;

    const returns = trades.map((t) => t.profitPercentage);
    const averageReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, b) => a + Math.pow(b - averageReturn, 2), 0) /
      (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    return stdDev === 0 ? 0 : (averageReturn / stdDev) * Math.sqrt(252); // Annualized
  }
}

export const strategyManager = new StrategyManager();
