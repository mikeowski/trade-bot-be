import { PortfolioManager } from '../src/services/portfolioService';
import { getLivePrice } from '../src/services/priceService';

// Mock the priceService
jest.mock('../src/services/priceService', () => ({
  getLivePrice: jest.fn().mockResolvedValue({ price: '40000' })
}));

describe('PortfolioManager', () => {
  const initialBalance = 100000;
  const defaultRiskParams = {
    maxPositionSize: 20, // 20% of portfolio
    maxTotalExposure: 80, // 80% of portfolio
    riskPerTrade: 1, // 1% risk per trade
    maxDrawdown: 20, // 20% maximum drawdown
    stopLossPercentage: 2, // 2% stop loss
    takeProfitPercentage: 4 // 4% take profit
  };

  let portfolioManager: PortfolioManager;

  beforeEach(() => {
    portfolioManager = new PortfolioManager(initialBalance, defaultRiskParams);
    (getLivePrice as jest.Mock).mockClear();
  });

  test('Initialize portfolio', () => {
    const portfolio = portfolioManager.getPortfolio();
    expect(portfolio.totalBalance).toBe(initialBalance);
    expect(portfolio.availableBalance).toBe(initialBalance);
    expect(portfolio.positions.size).toBe(0);
  });

  test('Open position with valid parameters', async () => {
    const position = await portfolioManager.openPosition(
      'BTCUSDT',
      'long',
      40000,
      39200, // 2% stop loss
      41600 // 4% take profit
    );

    expect(position).toBeDefined();
    expect(position?.symbol).toBe('BTCUSDT');
    expect(position?.side).toBe('long');
    expect(position?.entryPrice).toBe(40000);
  });

  test('Respect maximum position size', async () => {
    // Try to open a position that would exceed maxPositionSize
    const position = await portfolioManager.openPosition(
      'BTCUSDT',
      'long',
      40000,
      20000, // Very wide stop loss to force large position size
      42000
    );

    const portfolio = portfolioManager.getPortfolio();
    expect(portfolio.exposure).toBeLessThanOrEqual(
      defaultRiskParams.maxPositionSize
    );
  });

  test('Calculate correct position size based on risk', async () => {
    const position = await portfolioManager.openPosition(
      'BTCUSDT',
      'long',
      40000,
      39200, // 2% stop loss
      41600
    );

    // Risk amount should be 1% of portfolio (1000 USDT)
    // Stop loss distance is 800 USDT
    // Expected position size should be 1000/800 = 1.25 BTC
    expect(position?.quantity).toBeCloseTo(1.25, 1);
  });

  test('Update portfolio metrics', async () => {
    await portfolioManager.openPosition('BTCUSDT', 'long', 39000, 38220, 40560);

    // Mock price increase
    (getLivePrice as jest.Mock).mockResolvedValueOnce({ price: '40000' });

    await portfolioManager.updatePortfolioMetrics();
    const position = portfolioManager.getPosition('BTCUSDT');

    expect(position?.unrealizedPnL).toBeGreaterThan(0);
    expect(position?.unrealizedPnLPercentage).toBeGreaterThan(0);
  });

  test('Close position and realize PnL', async () => {
    // Open position
    await portfolioManager.openPosition('BTCUSDT', 'long', 39000, 38220, 40560);

    // Mock price increase
    (getLivePrice as jest.Mock).mockResolvedValueOnce({ price: '40000' });
    await portfolioManager.updatePortfolioMetrics();

    // Close position
    const success = await portfolioManager.closePosition('BTCUSDT');
    expect(success).toBe(true);

    const portfolio = portfolioManager.getPortfolio();
    expect(portfolio.totalBalance).toBeGreaterThan(initialBalance);
    expect(portfolio.positions.size).toBe(0);
  });

  test('Prevent opening position when exposure limit reached', async () => {
    // Open maximum allowed positions
    const maxPositions = Math.floor(
      defaultRiskParams.maxTotalExposure / defaultRiskParams.maxPositionSize
    );

    for (let i = 0; i < maxPositions; i++) {
      await portfolioManager.openPosition(
        `BTC${i}USDT`,
        'long',
        40000,
        39200,
        41600
      );
    }

    // Try to open one more position
    const position = await portfolioManager.openPosition(
      'ETHUSDT',
      'long',
      40000,
      39200,
      41600
    );

    expect(position).toBeNull();
  });

  test('Update risk parameters', () => {
    const newParams = {
      maxPositionSize: 15,
      riskPerTrade: 0.5
    };

    portfolioManager.updateRiskParameters(newParams);
    const updatedParams = portfolioManager.getRiskParameters();

    expect(updatedParams.maxPositionSize).toBe(15);
    expect(updatedParams.riskPerTrade).toBe(0.5);
    expect(updatedParams.maxTotalExposure).toBe(
      defaultRiskParams.maxTotalExposure
    );
  });
});
