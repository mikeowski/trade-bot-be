import { LiveTradingService } from '../src/services/liveTestingService';
import WebSocket from 'ws';

// Mock WebSocket
jest.mock('ws');

describe('LiveTradingService', () => {
  let liveTestingService: LiveTradingService;
  let mockWebSocket: jest.Mocked<WebSocket>;
  let mockOn: jest.Mock;
  let mockSend: jest.Mock;
  let mockTerminate: jest.Mock;
  let mockPong: jest.Mock;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mock functions
    mockOn = jest.fn();
    mockSend = jest.fn();
    mockTerminate = jest.fn();
    mockPong = jest.fn();

    // Create mock WebSocket instance
    mockWebSocket = {
      on: mockOn,
      send: mockSend,
      terminate: mockTerminate,
      pong: mockPong
    } as unknown as jest.Mocked<WebSocket>;

    // Mock WebSocket constructor
    (WebSocket as unknown as jest.Mock).mockImplementation(() => mockWebSocket);

    // Initialize service
    liveTestingService = new LiveTradingService(10000);
  });

  describe('WebSocket Connection', () => {
    const sampleStrategy = {
      rules: {
        buy: 'RSI < 30',
        sell: 'RSI > 70'
      },
      riskManagement: {
        stopLoss: 2,
        takeProfit: 4,
        maxPositionSize: 100
      },
      timeframe: '1m'
    };

    test('should establish WebSocket connection with correct parameters', () => {
      const symbol = 'BTCUSDT';
      const tradeId = 'test_trade_1';

      // @ts-expect-error - accessing private method for testing
      liveTestingService['setupWebSocket'](tradeId, symbol, sampleStrategy);

      // Verify WebSocket constructor was called with correct URL
      expect(WebSocket).toHaveBeenCalledWith(
        'wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/btcusdt@trade'
      );

      // Verify event listeners were set up
      expect(mockOn).toHaveBeenCalledWith('open', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('ping', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('pong', expect.any(Function));
    });

    test('should handle WebSocket open event correctly', () => {
      const symbol = 'BTCUSDT';
      const tradeId = 'test_trade_1';

      // @ts-expect-error - accessing private method for testing
      liveTestingService['setupWebSocket'](tradeId, symbol, sampleStrategy);

      // Get and call the 'open' event handler
      const openHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'open'
      )?.[1];
      expect(openHandler).toBeDefined();
      openHandler.call(mockWebSocket);

      // Verify subscription message was sent
      expect(mockSend).toHaveBeenCalledWith(
        expect.stringContaining('"method":"SUBSCRIBE"')
      );
      expect(mockSend).toHaveBeenCalledWith(
        expect.stringContaining('"params":["btcusdt@kline_1m","btcusdt@trade"]')
      );
    });

    test('should handle ping/pong correctly', () => {
      const symbol = 'BTCUSDT';
      const tradeId = 'test_trade_1';

      // @ts-expect-error - accessing private method for testing
      liveTestingService['setupWebSocket'](tradeId, symbol, sampleStrategy);

      // Get and call the ping handler
      const pingHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'ping'
      )?.[1];
      expect(pingHandler).toBeDefined();
      pingHandler.call(mockWebSocket);

      // Verify pong was sent
      expect(mockPong).toHaveBeenCalled();
    });

    test('should handle connection rate limiting', () => {
      const symbol = 'BTCUSDT';
      const tradeId = 'test_trade_1';

      // Try to create many connections quickly
      for (let i = 0; i < 301; i++) {
        try {
          // @ts-expect-error - accessing private method for testing
          liveTestingService['setupWebSocket'](
            tradeId + i,
            symbol,
            sampleStrategy
          );
        } catch (error: any) {
          expect(error.message).toContain('Connection limit exceeded');
          return;
        }
      }
    });
  });

  describe('Message Processing', () => {
    test('should process kline messages correctly', () => {
      const symbol = 'BTCUSDT';
      const tradeId = 'test_trade_1';

      // Setup WebSocket
      // @ts-expect-error - accessing private method for testing
      const ws = liveTestingService['setupWebSocket'](tradeId, symbol, {
        rules: {
          buy: 'RSI < 30',
          sell: 'RSI > 70'
        },
        riskManagement: {
          stopLoss: 2,
          takeProfit: 4,
          maxPositionSize: 100
        },
        timeframe: '1m'
      });

      // Get message handler
      const messageHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];
      expect(messageHandler).toBeDefined();

      // Create sample kline message
      const klineMessage = {
        stream: 'btcusdt@kline_1m',
        data: {
          e: 'kline',
          E: 1623456789000,
          s: 'BTCUSDT',
          k: {
            t: 1623456780000,
            T: 1623456839999,
            s: 'BTCUSDT',
            i: '1m',
            f: 100,
            L: 200,
            o: '35000.00',
            c: '35100.00',
            h: '35200.00',
            l: '34900.00',
            v: '10.5',
            n: 100,
            x: true,
            q: '367500.00',
            V: '5.2',
            Q: '182350.00',
            B: '0'
          }
        }
      };

      // Call message handler with kline data
      messageHandler?.call(
        mockWebSocket,
        Buffer.from(JSON.stringify(klineMessage))
      );

      // Verify trade status was updated
      // @ts-expect-error - accessing private property for testing
      const trade = liveTestingService['liveTrades'].get(tradeId);
      expect(trade).toBeDefined();
      if (trade) {
        expect(trade.klines).toBeDefined();
        expect(trade.klines.length).toBeGreaterThan(0);
      }
    });

    test('should handle malformed messages gracefully', () => {
      const symbol = 'BTCUSDT';
      const tradeId = 'test_trade_1';

      // Setup WebSocket
      // @ts-expect-error - accessing private method for testing
      const ws = liveTestingService['setupWebSocket'](tradeId, symbol, {
        rules: {
          buy: 'RSI < 30',
          sell: 'RSI > 70'
        },
        riskManagement: {
          stopLoss: 2,
          takeProfit: 4,
          maxPositionSize: 100
        },
        timeframe: '1m'
      });

      // Get message handler
      const messageHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];
      expect(messageHandler).toBeDefined();

      // Call message handler with malformed data
      expect(() => {
        messageHandler?.call(mockWebSocket, Buffer.from('{"malformed": true}'));
      }).not.toThrow();
    });
  });

  describe('Timeframe Validation', () => {
    test('should validate timeframe correctly', () => {
      const validTimeframes = [
        '1s',
        '1m',
        '3m',
        '5m',
        '15m',
        '30m',
        '1h',
        '2h',
        '4h',
        '6h',
        '8h',
        '12h',
        '1d',
        '3d',
        '1w',
        '1M'
      ];

      validTimeframes.forEach((timeframe) => {
        expect(() => {
          // @ts-expect-error - accessing private method for testing
          liveTestingService['getValidTimeframe'](timeframe);
        }).not.toThrow();
      });

      expect(() => {
        // @ts-expect-error - accessing private method for testing
        liveTestingService['getValidTimeframe']('invalid');
      }).toThrow('Invalid timeframe');
    });
  });

  describe('Rate Limiting', () => {
    test('should enforce message rate limits', () => {
      const tradeId = 'test_trade_1';

      // Simulate rapid messages
      for (let i = 0; i < 10; i++) {
        // @ts-expect-error - accessing private method for testing
        const isLimited = liveTestingService['isRateLimited'](tradeId);
        if (i >= 5) {
          expect(isLimited).toBe(true);
        } else {
          expect(isLimited).toBe(false);
        }
      }
    });
  });
});
