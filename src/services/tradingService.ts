import { TechnicalIndicators } from './indicatorService';
import { StrategyManager, Strategy } from './strategyService';
import { PortfolioManager } from './portfolioService';
import { getHistoricalData, getLivePrice } from './priceService';
import { LiveTradingService } from './liveTestingService';
import { BacktestingService } from './backtestingService';

interface RiskParameters {
  maxPositionSize: number;
  maxTotalExposure: number;
  riskPerTrade: number;
  maxDrawdown: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
}

interface LiveTradingParams extends Strategy {
  timeframe?: string;
}

export class TradingService {
  private portfolioManager: PortfolioManager;
  private liveTradingService: LiveTradingService;
  private backtestingService: BacktestingService;
  private strategyManager: StrategyManager;

  constructor(
    initialBalance: number,
    riskParams: RiskParameters,
    strategyManager?: StrategyManager
  ) {
    this.portfolioManager = new PortfolioManager(initialBalance, riskParams);
    this.liveTradingService = new LiveTradingService(initialBalance);
    this.backtestingService = new BacktestingService(initialBalance);
    this.strategyManager = strategyManager || new StrategyManager();
  }

  // Strategy Management
  async createStrategy(strategyConfig: Strategy): Promise<string> {
    return this.strategyManager.addStrategy(strategyConfig);
  }

  async getStrategy(id: string): Promise<Strategy | undefined> {
    return this.strategyManager.getStrategy(id);
  }

  async getAllStrategies(): Promise<Strategy[]> {
    return this.strategyManager.getAllStrategies();
  }

  async updateStrategy(id: string, strategy: Strategy): Promise<boolean> {
    return this.strategyManager.updateStrategy(id, strategy);
  }

  async deleteStrategy(id: string): Promise<boolean> {
    return this.strategyManager.deleteStrategy(id);
  }

  // Technical Analysis
  async calculateIndicators(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number
  ) {
    try {
      const historicalData = await getHistoricalData(
        symbol,
        interval,
        startTime,
        endTime
      );

      if (!historicalData || historicalData.length < 50) {
        throw new Error(
          'Insufficient historical data for indicator calculation'
        );
      }

      // İndikatörleri hesapla
      const rsi = TechnicalIndicators.calculateRSI(historicalData, 14);
      const macd = TechnicalIndicators.calculateMACD(historicalData, 12, 26, 9);
      const bollinger = TechnicalIndicators.calculateBollingerBands(
        historicalData,
        20,
        2
      );
      const sma = TechnicalIndicators.calculateSMA(historicalData, 20);
      const ema = TechnicalIndicators.calculateEMA(historicalData, 20);

      return {
        klines: historicalData,
        indicators: {
          rsi,
          macd,
          bollinger,
          sma,
          ema
        }
      };
    } catch (error) {
      console.error('Error calculating indicators:', error);
      throw error;
    }
  }

  // Portfolio Management
  async openPosition(
    symbol: string,
    side: 'long' | 'short',
    price: number,
    stopLoss: number,
    takeProfit: number
  ) {
    if (!symbol || !price || !stopLoss || !takeProfit) {
      throw new Error('Missing required parameters for opening position');
    }

    return this.portfolioManager.openPosition(
      symbol,
      side,
      price,
      stopLoss,
      takeProfit
    );
  }

  async closePosition(symbol: string) {
    if (!symbol) {
      throw new Error('Symbol is required to close position');
    }
    return this.portfolioManager.closePosition(symbol);
  }

  getPortfolio() {
    return this.portfolioManager.getPortfolio();
  }

  getPosition(symbol: string) {
    return this.portfolioManager.getPosition(symbol);
  }

  getAllPositions() {
    return this.portfolioManager.getAllPositions();
  }

  // Live Trading
  async startLiveTrading(
    strategyId: string,
    symbol: string,
    strategy: Strategy & { timeframe?: string }
  ) {
    // Strateji koşullarını LiveTradingStrategy formatına dönüştür
    const liveTradingStrategy = {
      rules: {
        buy: strategy.entryConditions
          .map(
            (condition) =>
              `${condition.indicator} ${condition.comparison} ${condition.value}`
          )
          .join(' && '),
        sell: strategy.exitConditions
          .map(
            (condition) =>
              `${condition.indicator} ${condition.comparison} ${condition.value}`
          )
          .join(' && ')
      },
      riskManagement: strategy.riskManagement,
      timeframe: strategy.timeframe
    };

    return this.liveTradingService.startLiveTrade(
      strategyId,
      symbol,
      liveTradingStrategy
    );
  }

  async stopLiveTrading(tradeId: string) {
    if (!tradeId) {
      throw new Error('Trade ID is required to stop live trading');
    }
    this.liveTradingService.stopLiveTrade(tradeId);
  }

  getLiveTradingStatus(tradeId: string) {
    if (!tradeId) {
      throw new Error('Trade ID is required to get status');
    }
    return this.liveTradingService.getLiveTradeStatus(tradeId);
  }

  // Backtesting
  async runBacktest(
    strategyId: string,
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime: number
  ) {
    // Validate parameters
    if (!strategyId || !symbol || !timeframe || !startTime || !endTime) {
      throw new Error('Missing required parameters for backtesting');
    }

    if (endTime <= startTime) {
      throw new Error('End time must be greater than start time');
    }

    // Get strategy configuration
    const strategy = await this.strategyManager.getStrategy(strategyId);
    if (!strategy) {
      throw new Error('Strategy not found');
    }

    // Get historical data
    const historicalData = await getHistoricalData(
      symbol,
      timeframe,
      startTime,
      endTime
    );

    if (!historicalData || historicalData.length < 50) {
      throw new Error('Insufficient historical data for backtesting');
    }

    try {
      // Run backtest
      const result = await this.backtestingService.runBacktest(historicalData, {
        indicators: strategy.indicators,
        entryConditions: strategy.entryConditions,
        exitConditions: strategy.exitConditions,
        riskManagement: strategy.riskManagement
      });

      // Store backtest result
      await this.strategyManager.saveBacktestResult(strategyId, result);

      return result;
    } catch (error) {
      console.error('Backtest error:', error);
      throw new Error('Failed to run backtest');
    }
  }

  async getBacktestResult(strategyId: string) {
    if (!strategyId) {
      throw new Error('Strategy ID is required to get backtest result');
    }
    return this.strategyManager.getBacktestResult(strategyId);
  }

  private formatCondition(condition: any): string {
    const indicatorRef =
      condition.indicator === 'close' ? 'close' : condition.indicator;

    const operator = this.getComparisonOperator(condition.comparison);
    const value = condition.targetIndicator
      ? `${condition.targetIndicator}`
      : condition.value;

    return `this.${indicatorRef} ${operator} ${value}`;
  }

  private getComparisonOperator(comparison: string): string {
    switch (comparison) {
      case 'above':
        return '>';
      case 'below':
        return '<';
      case 'crosses_above':
        return '<= this.prev_${indicatorRef} && >'; // Check previous value was below/equal and current is above
      case 'crosses_below':
        return '>= this.prev_${indicatorRef} && <'; // Check previous value was above/equal and current is below
      case 'equals':
        return '==';
      default:
        return '==';
    }
  }
}
