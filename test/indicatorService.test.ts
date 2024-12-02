import {
  TechnicalIndicators,
  KlineData
} from '../src/services/indicatorService';

describe('TechnicalIndicators', () => {
  // Helper function to create sample KlineData
  const createSampleKlineData = (length: number): KlineData[] => {
    return Array(length)
      .fill(0)
      .map((_, i) => ({
        time: Date.now() + i * 60000, // Each candle 1 minute apart
        open: 44 + Math.sin(i * 0.1) * 10,
        high: 44 + Math.sin(i * 0.1) * 10 + 1,
        low: 44 + Math.sin(i * 0.1) * 10 - 1,
        close: 44 + Math.sin(i * 0.1) * 10 + 0.5,
        volume: 1000 + Math.random() * 500,
        closeTime: Date.now() + (i + 1) * 60000
      }));
  };

  const sampleData = createSampleKlineData(100);

  describe('RSI Calculations', () => {
    test('Calculate RSI with default period', () => {
      const rsi = TechnicalIndicators.calculateRSI(sampleData);
      expect(Array.isArray(rsi)).toBe(true);
      expect(rsi.length).toBeGreaterThan(0);
      expect(rsi[0]).toHaveProperty('value');
      expect(rsi[0]).toHaveProperty('timestamp');
      expect(typeof rsi[0].value).toBe('number');
      expect(rsi[0].value).toBeGreaterThanOrEqual(0);
      expect(rsi[0].value).toBeLessThanOrEqual(100);
    });

    test('RSI should throw error on insufficient data', () => {
      const shortData = createSampleKlineData(3);
      expect(() => TechnicalIndicators.calculateRSI(shortData, 14)).toThrow(
        'Insufficient data'
      );
    });
  });

  describe('MACD Calculations', () => {
    test('Calculate MACD with default parameters', () => {
      const macd = TechnicalIndicators.calculateMACD(sampleData);
      expect(Array.isArray(macd)).toBe(true);
      expect(macd[0]).toHaveProperty('value');
      expect(Array.isArray(macd[0].value)).toBe(true);
      expect(macd[0].value).toHaveLength(3);
      expect(typeof macd[0].value[0]).toBe('number'); // MACD line
      expect(typeof macd[0].value[1]).toBe('number'); // Signal line
      expect(typeof macd[0].value[2]).toBe('number'); // Histogram
    });

    test('MACD with custom periods', () => {
      const macd = TechnicalIndicators.calculateMACD(sampleData, 8, 17, 9);
      expect(Array.isArray(macd)).toBe(true);
      expect(macd[0].value).toHaveLength(3);
    });
  });

  describe('Bollinger Bands Calculations', () => {
    test('Calculate Bollinger Bands with default parameters', () => {
      const bb = TechnicalIndicators.calculateBollingerBands(sampleData);
      expect(bb).toHaveProperty('upper');
      expect(bb).toHaveProperty('middle');
      expect(bb).toHaveProperty('lower');
      expect(bb).toHaveProperty('timestamp');
      expect(Array.isArray(bb.upper)).toBe(true);
      expect(bb.upper.length).toBe(bb.middle.length);
      expect(bb.middle.length).toBe(bb.lower.length);
      expect(bb.timestamp.length).toBe(bb.upper.length);
    });

    test('Upper band should always be greater than middle band', () => {
      const bb = TechnicalIndicators.calculateBollingerBands(sampleData);
      bb.upper.forEach((value, index) => {
        expect(value).toBeGreaterThan(bb.middle[index]);
      });
    });
  });

  describe('Moving Averages', () => {
    test('Calculate SMA', () => {
      const period = 20;
      const sma = TechnicalIndicators.calculateSMA(sampleData, period);
      expect(Array.isArray(sma)).toBe(true);
      expect(sma.length).toBe(sampleData.length - period + 1);
      expect(sma[0]).toHaveProperty('value');
      expect(sma[0]).toHaveProperty('timestamp');
    });

    test('Calculate EMA', () => {
      const period = 20;
      const ema = TechnicalIndicators.calculateEMA(sampleData, period);
      expect(Array.isArray(ema)).toBe(true);
      expect(ema.length).toBe(sampleData.length - period + 1);
      expect(ema[0]).toHaveProperty('value');
      expect(ema[0]).toHaveProperty('timestamp');
    });
  });

  describe('Data Validation', () => {
    test('validateKlineData should validate proper data', () => {
      expect(() => {
        TechnicalIndicators.validateKlineData(sampleData, 10);
      }).not.toThrow();
    });

    test('validateKlineData should throw on insufficient data', () => {
      const shortData = createSampleKlineData(5);
      expect(() => {
        TechnicalIndicators.validateKlineData(shortData, 10);
      }).toThrow('Invalid kline data: need at least 10 candles');
    });

    test('validateKlineData should throw on invalid data structure', () => {
      const invalidData = [{ time: 123 }] as any[];
      expect(() => {
        TechnicalIndicators.validateKlineData(invalidData, 1);
      }).toThrow('Invalid kline data: missing or invalid fields');
    });
  });

  describe('WebSocket Data Parsing', () => {
    test('parseWebSocketKline should correctly parse WebSocket data', () => {
      const wsKline = {
        t: 1623456789000,
        o: '44.5',
        h: '45.0',
        l: '44.0',
        c: '44.8',
        v: '1000.5',
        T: 1623456849000
      };

      const parsed = TechnicalIndicators.parseWebSocketKline(wsKline);
      expect(parsed).toEqual({
        time: 1623456789000,
        open: 44.5,
        high: 45.0,
        low: 44.0,
        close: 44.8,
        volume: 1000.5,
        closeTime: 1623456849000
      });
    });
  });
});
