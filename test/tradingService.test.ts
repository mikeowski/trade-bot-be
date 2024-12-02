import { TradingService } from '../src/services/tradingService';
import { getHistoricalData } from '../src/services/priceService';

jest.mock('../src/services/priceService');

describe('TradingService', () => {
  let tradingService: TradingService;

  // Mock historical data with sufficient length
  const mockHistoricalData = Array(200)
    .fill(0)
    .map((_, i) => {
      const trend = Math.sin(i * 0.05) * 10;
      const noise = Math.random() * 2 - 1;
      const price = 100 + trend + noise;
      return {
        time: Date.now() - (200 - i) * 60000,
        open: price,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 1000 + Math.random() * 500
      };
    });

  const defaultRiskParams = {
    maxPositionSize: 20,
    maxTotalExposure: 80,
    riskPerTrade: 1,
    maxDrawdown: 20,
    stopLossPercentage: 2,
    takeProfitPercentage: 4
  };

  beforeEach(() => {
    tradingService = new TradingService(10000, defaultRiskParams);
    (getHistoricalData as jest.Mock).mockResolvedValue(mockHistoricalData);
  });

  describe('Strategy Management', () => {
    test('Create and retrieve strategy', async () => {
      const strategy = {
        id: '',
        name: 'Test Strategy',
        description: 'Test strategy description',
        indicators: {
          rsi: {
            type: 'rsi',
            params: { period: 14 }
          }
        },
        entryConditions: [
          {
            indicator: 'rsi',
            comparison: 'below' as const,
            value: 30
          }
        ],
        exitConditions: [
          {
            indicator: 'rsi',
            comparison: 'above' as const,
            value: 70
          }
        ],
        riskManagement: {
          stopLoss: 2,
          takeProfit: 4,
          maxPositionSize: 1000
        }
      };

      const id = await tradingService.createStrategy(strategy);
      const retrieved = await tradingService.getStrategy(id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe(strategy.name);
    });

    test('Update strategy', async () => {
      const strategy = {
        id: '',
        name: 'Test Strategy',
        description: 'Test strategy description',
        indicators: {
          rsi: {
            type: 'rsi',
            params: { period: 14 }
          }
        },
        entryConditions: [
          {
            indicator: 'rsi',
            comparison: 'below' as const,
            value: 30
          }
        ],
        exitConditions: [
          {
            indicator: 'rsi',
            comparison: 'above' as const,
            value: 70
          }
        ],
        riskManagement: {
          stopLoss: 2,
          takeProfit: 4,
          maxPositionSize: 1000
        }
      };

      const id = await tradingService.createStrategy(strategy);
      const success = await tradingService.updateStrategy(id, {
        ...strategy,
        id,
        name: 'Updated Strategy'
      });

      expect(success).toBe(true);
      const updated = await tradingService.getStrategy(id);
      expect(updated?.name).toBe('Updated Strategy');
    });

    test('Delete strategy', async () => {
      const strategy = {
        id: '',
        name: 'Test Strategy',
        description: 'Test strategy description',
        indicators: {
          rsi: {
            type: 'rsi',
            params: { period: 14 }
          }
        },
        entryConditions: [
          {
            indicator: 'rsi',
            comparison: 'below' as const,
            value: 30
          }
        ],
        exitConditions: [
          {
            indicator: 'rsi',
            comparison: 'above' as const,
            value: 70
          }
        ],
        riskManagement: {
          stopLoss: 2,
          takeProfit: 4,
          maxPositionSize: 1000
        }
      };

      const id = await tradingService.createStrategy(strategy);
      const success = await tradingService.deleteStrategy(id);
      expect(success).toBe(true);
      const deleted = await tradingService.getStrategy(id);
      expect(deleted).toBeUndefined();
    });
  });

  describe('Technical Analysis', () => {
    test('Calculate indicators', async () => {
      const result = await tradingService.calculateIndicators(
        'BTCUSDT',
        '1h',
        Date.now() - 30 * 24 * 60 * 60 * 1000,
        Date.now()
      );

      expect(result).toBeDefined();
      expect(result.rsi).toBeDefined();
      expect(result.macd).toBeDefined();
      expect(Array.isArray(result.rsi)).toBe(true);
      expect(Array.isArray(result.macd)).toBe(true);
    });
  });

  describe('Backtesting', () => {
    test('Run backtest', async () => {
      const strategy = {
        id: '',
        name: 'Test Strategy',
        description: 'Test strategy description',
        indicators: {
          rsi: {
            type: 'rsi',
            params: { period: 14 }
          }
        },
        entryConditions: [
          {
            indicator: 'rsi',
            comparison: 'below' as const,
            value: 30
          }
        ],
        exitConditions: [
          {
            indicator: 'rsi',
            comparison: 'above' as const,
            value: 70
          }
        ],
        riskManagement: {
          stopLoss: 2,
          takeProfit: 4,
          maxPositionSize: 1000
        }
      };

      const id = await tradingService.createStrategy(strategy);
      const result = await tradingService.runBacktest(
        id,
        'BTCUSDT',
        '1h',
        Date.now() - 30 * 24 * 60 * 60 * 1000,
        Date.now()
      );

      expect(result).toBeDefined();
      expect(result.trades).toBeDefined();
      expect(result.metrics).toBeDefined();
      expect(result.equity).toBeDefined();
      expect(result.drawdowns).toBeDefined();
      expect(result.finalBalance).toBeDefined();
      expect(result.metrics.winRate).toBeGreaterThanOrEqual(0);
      expect(result.metrics.winRate).toBeLessThanOrEqual(100);
    });
  });
});
