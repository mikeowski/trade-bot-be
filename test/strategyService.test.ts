import {
  StrategyManager,
  Strategy,
  BacktestResult
} from '../src/services/strategyService';

describe('StrategyManager', () => {
  let strategyManager: StrategyManager;
  let sampleStrategy: Strategy;

  beforeEach(() => {
    strategyManager = new StrategyManager();
    sampleStrategy = {
      id: '',
      name: 'RSI + MACD Strategy',
      description: 'A simple strategy combining RSI and MACD indicators',
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
        },
        {
          indicator: 'macd',
          comparison: 'crosses_above',
          targetIndicator: 'macd_signal',
          value: 0
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
        maxPositionSize: 1000,
        trailingStop: 1.5
      }
    };
  });

  describe('Strategy Management', () => {
    test('should add a strategy and generate ID', () => {
      const id = strategyManager.addStrategy(sampleStrategy);
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^strat_\d+_[a-z0-9]+$/);
    });

    test('should get a strategy by ID', () => {
      const id = strategyManager.addStrategy(sampleStrategy);
      const retrieved = strategyManager.getStrategy(id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe(sampleStrategy.name);
    });

    test('should get all strategies', () => {
      const id1 = strategyManager.addStrategy(sampleStrategy);

      const secondStrategy = {
        ...sampleStrategy,
        name: 'Another Strategy',
        id: ''
      };
      const id2 = strategyManager.addStrategy(secondStrategy);

      const allStrategies = strategyManager.getAllStrategies();
      expect(allStrategies).toHaveLength(2);

      const strategy1 = allStrategies.find((s) => s.id === id1);
      const strategy2 = allStrategies.find((s) => s.id === id2);

      expect(strategy1).toBeDefined();
      expect(strategy2).toBeDefined();
      expect(strategy1?.name).toBe(sampleStrategy.name);
      expect(strategy2?.name).toBe('Another Strategy');
    });

    test('should update a strategy', () => {
      const id = strategyManager.addStrategy(sampleStrategy);
      const updated = {
        ...sampleStrategy,
        name: 'Updated Strategy'
      };

      const result = strategyManager.updateStrategy(id, updated);
      expect(result).toBe(true);

      const retrieved = strategyManager.getStrategy(id);
      expect(retrieved?.name).toBe('Updated Strategy');
    });

    test('should delete a strategy', () => {
      const id = strategyManager.addStrategy(sampleStrategy);
      const result = strategyManager.deleteStrategy(id);
      expect(result).toBe(true);
      expect(strategyManager.getStrategy(id)).toBeUndefined();
    });
  });

  describe('Strategy Validation', () => {
    test('should validate required fields', () => {
      const invalidStrategy = { ...sampleStrategy, name: '' };
      expect(() => strategyManager.addStrategy(invalidStrategy)).toThrow(
        'Missing required strategy fields'
      );
    });

    test('should validate indicators', () => {
      const invalidStrategy = { ...sampleStrategy, indicators: {} };
      expect(() => strategyManager.addStrategy(invalidStrategy)).toThrow(
        'Strategy must have at least one indicator'
      );
    });

    test('should validate entry conditions', () => {
      const invalidStrategy = { ...sampleStrategy, entryConditions: [] };
      expect(() => strategyManager.addStrategy(invalidStrategy)).toThrow(
        'Strategy must have at least one entry condition'
      );
    });

    test('should validate exit conditions', () => {
      const invalidStrategy = { ...sampleStrategy, exitConditions: [] };
      expect(() => strategyManager.addStrategy(invalidStrategy)).toThrow(
        'Strategy must have at least one exit condition'
      );
    });

    test('should validate risk management', () => {
      const invalidStrategy = {
        ...sampleStrategy,
        riskManagement: null
      };
      expect(() =>
        strategyManager.addStrategy(invalidStrategy as unknown as Strategy)
      ).toThrow('Strategy must have risk management parameters');
    });
  });

  describe('Backtest Results', () => {
    test('should save and retrieve backtest results', async () => {
      const id = strategyManager.addStrategy(sampleStrategy);
      const sampleResult: BacktestResult = {
        trades: [
          {
            entryTime: Date.now(),
            exitTime: Date.now() + 3600000,
            entryPrice: 100,
            exitPrice: 105,
            type: 'long',
            quantity: 1,
            profit: 5,
            profitPercentage: 5
          }
        ],
        metrics: {
          totalTrades: 1,
          winningTrades: 1,
          losingTrades: 0,
          winRate: 100,
          profitFactor: Infinity,
          totalProfit: 5,
          maxDrawdown: 0,
          averageProfit: 5,
          averageLoss: 0,
          sharpeRatio: 1
        },
        equity: [10000, 10005],
        drawdowns: [0, 0],
        finalBalance: 10005
      };

      await strategyManager.saveBacktestResult(id, sampleResult);
      const retrieved = strategyManager.getBacktestResult(id);
      expect(retrieved).toEqual(sampleResult);
    });

    test('should not save backtest result for non-existent strategy', async () => {
      const sampleResult: BacktestResult = {
        trades: [],
        metrics: {
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
        },
        equity: [10000],
        drawdowns: [0],
        finalBalance: 10000
      };

      await expect(
        strategyManager.saveBacktestResult('non-existent', sampleResult)
      ).rejects.toThrow('Strategy not found');
    });
  });
});
