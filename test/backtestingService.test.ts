import {
  BacktestingService,
  BacktestingResult
} from '../src/services/backtestingService';

describe('BacktestingService', () => {
  let backtestingService: BacktestingService;
  let sampleHistoricalData: any[];
  let sampleStrategy: any;

  beforeEach(() => {
    backtestingService = new BacktestingService(10000);

    // Create sample historical data with an upward trend
    sampleHistoricalData = Array(100)
      .fill(0)
      .map((_, i) => ({
        time: Date.now() + i * 60000,
        open: 100 + i * 0.1,
        high: 100 + i * 0.1 + 0.05,
        low: 100 + i * 0.1 - 0.05,
        close: 100 + i * 0.1 + 0.02,
        volume: 1000 + Math.random() * 500
      }));

    sampleStrategy = {
      indicators: {
        rsi: {
          type: 'RSI',
          params: {
            period: 14
          }
        },
        macd: {
          type: 'MACD',
          params: {
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9
          }
        }
      },
      entryConditions: [
        {
          indicator: 'rsi',
          comparison: 'below',
          value: 30
        }
      ],
      exitConditions: [
        {
          indicator: 'rsi',
          comparison: 'above',
          value: 70
        }
      ],
      riskManagement: {
        stopLoss: 2,
        takeProfit: 4,
        maxPositionSize: 100
      }
    };
  });

  describe('Basic Functionality', () => {
    test('should initialize with correct initial balance', () => {
      const service = new BacktestingService(5000);
      expect(service['initialBalance']).toBe(5000);
      expect(service['currentBalance']).toBe(5000);
    });

    test('should throw error on insufficient historical data', async () => {
      const shortData = sampleHistoricalData.slice(0, 40);
      await expect(
        backtestingService.runBacktest(shortData, sampleStrategy)
      ).rejects.toThrow('Insufficient historical data for backtesting');
    });
  });

  describe('Backtesting Results', () => {
    test('should return valid backtest result structure', async () => {
      const result = await backtestingService.runBacktest(
        sampleHistoricalData,
        sampleStrategy
      );

      expect(result).toHaveProperty('trades');
      expect(result).toHaveProperty('metrics');
      expect(result).toHaveProperty('equity');
      expect(result).toHaveProperty('drawdowns');
      expect(result).toHaveProperty('finalBalance');
      expect(result).toHaveProperty('debug');

      expect(Array.isArray(result.trades)).toBe(true);
      expect(Array.isArray(result.equity)).toBe(true);
      expect(Array.isArray(result.drawdowns)).toBe(true);
      expect(typeof result.finalBalance).toBe('number');
    });

    test('should calculate metrics correctly', async () => {
      const result = await backtestingService.runBacktest(
        sampleHistoricalData,
        sampleStrategy
      );

      expect(result.metrics).toHaveProperty('totalTrades');
      expect(result.metrics).toHaveProperty('winningTrades');
      expect(result.metrics).toHaveProperty('losingTrades');
      expect(result.metrics).toHaveProperty('winRate');
      expect(result.metrics).toHaveProperty('profitFactor');
      expect(result.metrics).toHaveProperty('totalProfit');
      expect(result.metrics).toHaveProperty('maxDrawdown');
      expect(result.metrics).toHaveProperty('averageProfit');
      expect(result.metrics).toHaveProperty('averageLoss');
      expect(result.metrics).toHaveProperty('sharpeRatio');

      expect(result.metrics.totalTrades).toBe(
        result.metrics.winningTrades + result.metrics.losingTrades
      );
    });

    test('should maintain equity curve integrity', async () => {
      const result = await backtestingService.runBacktest(
        sampleHistoricalData,
        sampleStrategy
      );

      // Equity curve should start with initial balance
      expect(result.equity[0]).toBe(10000);

      // Final equity should match final balance
      expect(result.equity[result.equity.length - 1]).toBe(result.finalBalance);

      // Equity curve should be monotonic (no gaps)
      expect(result.equity.length).toBeGreaterThan(1);
      for (let i = 1; i < result.equity.length; i++) {
        expect(typeof result.equity[i]).toBe('number');
        expect(isNaN(result.equity[i])).toBe(false);
      }
    });
  });

  describe('Risk Management', () => {
    test('should respect maximum position size', async () => {
      const result = await backtestingService.runBacktest(
        sampleHistoricalData,
        {
          ...sampleStrategy,
          riskManagement: {
            ...sampleStrategy.riskManagement,
            maxPositionSize: 50 // 50% of account
          }
        }
      );

      // Check that no trade exceeds max position size
      result.trades.forEach((trade) => {
        const positionSize =
          ((trade.entryPrice * trade.quantity) / 10000) * 100;
        expect(positionSize).toBeLessThanOrEqual(50);
      });
    });

    test('should handle stop loss correctly', async () => {
      const result = await backtestingService.runBacktest(
        sampleHistoricalData,
        {
          ...sampleStrategy,
          riskManagement: {
            ...sampleStrategy.riskManagement,
            stopLoss: 1 // 1% stop loss
          }
        }
      );

      // Check that no trade loses more than stop loss percentage
      result.trades.forEach((trade) => {
        const lossPercentage = trade.profitPercentage;
        expect(lossPercentage).toBeGreaterThan(-1.1); // Allow small buffer for slippage
      });
    });
  });

  describe('Debug Data', () => {
    test('should provide detailed debug information', async () => {
      const result = await backtestingService.runBacktest(
        sampleHistoricalData,
        sampleStrategy
      );

      expect(result.debug).toBeDefined();
      expect(result.debug?.indicatorValues).toBeInstanceOf(Array);
      expect(result.debug?.conditions).toHaveProperty('entry');
      expect(result.debug?.conditions).toHaveProperty('exit');

      // Check indicator values structure
      if (result.debug?.indicatorValues.length) {
        const firstValue = result.debug.indicatorValues[0];
        expect(firstValue).toHaveProperty('time');
        expect(typeof firstValue.time).toBe('number');
      }
    });
  });
});
