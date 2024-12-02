import { RSI, MACD, BollingerBands, SMA, EMA } from 'technicalindicators';

export interface KlineData {
  time: number; // Kline start time
  open: number; // Open price
  high: number; // High price
  low: number; // Low price
  close: number; // Close price
  volume: number; // Volume
  closeTime: number; // Kline close time
  [key: string]: number; // Index signature for dynamic access
}

export interface IndicatorResult {
  value: number | number[];
  timestamp: number;
}

export interface BollingerBandsResult {
  upper: number[];
  middle: number[];
  lower: number[];
  timestamp: number[];
}

export interface MACDResult extends IndicatorResult {
  value: [number, number, number]; // [MACD, Signal, Histogram]
}

export interface RSIResult extends IndicatorResult {
  value: number;
}

export class TechnicalIndicators {
  // Kline verilerini dönüştürme yardımcı fonksiyonu
  private static extractPrices(
    klines: KlineData[],
    type: 'close' | 'high' | 'low' | 'open' = 'close'
  ): number[] {
    return klines.map((kline) => kline[type]);
  }

  private static extractTimestamps(klines: KlineData[]): number[] {
    return klines.map((kline) => kline.time);
  }

  static calculateRSI(klines: KlineData[], period: number = 14): RSIResult[] {
    if (klines.length < period + 1) {
      throw new Error(
        `Insufficient data for RSI calculation. Need at least ${
          period + 1
        } points`
      );
    }

    const prices = this.extractPrices(klines);
    const timestamps = this.extractTimestamps(klines);

    try {
      const changes = [];
      const gains = [];
      const losses = [];

      for (let i = 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        changes.push(change);
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
      }

      const firstAvgGain =
        gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
      const firstAvgLoss =
        losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

      const avgGains = [firstAvgGain];
      const avgLosses = [firstAvgLoss];

      for (let i = period; i < changes.length; i++) {
        const avgGain =
          (avgGains[avgGains.length - 1] * (period - 1) + gains[i]) / period;
        const avgLoss =
          (avgLosses[avgLosses.length - 1] * (period - 1) + losses[i]) / period;
        avgGains.push(avgGain);
        avgLosses.push(avgLoss);
      }

      const rsiValues = avgGains.map((gain, i) => {
        const loss = avgLosses[i];
        if (loss === 0) return 100;
        const RS = gain / loss;
        return 100 - 100 / (1 + RS);
      });

      return rsiValues.map((value, index) => ({
        value: Number(value.toFixed(2)),
        timestamp: timestamps[index + period]
      }));
    } catch (error) {
      console.error('Error in RSI calculation:', error);
      throw new Error(
        `RSI calculation failed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  static calculateMACD(
    klines: KlineData[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): MACDResult[] {
    if (klines.length < Math.max(fastPeriod, slowPeriod) + signalPeriod) {
      throw new Error('Insufficient data for MACD calculation');
    }

    const prices = this.extractPrices(klines);
    const timestamps = this.extractTimestamps(klines);

    try {
      const macdInput = {
        values: prices,
        fastPeriod,
        slowPeriod,
        signalPeriod,
        SimpleMAOscillator: false,
        SimpleMASignal: false
      };

      const macdResults = MACD.calculate(macdInput);

      // MACD hesaplaması için gerekli offset
      const offset = Math.max(fastPeriod, slowPeriod) + signalPeriod - 2;

      return macdResults.map((result, index) => ({
        value: [
          Number(result.MACD?.toFixed(8) || 0),
          Number(result.signal?.toFixed(8) || 0),
          Number(result.histogram?.toFixed(8) || 0)
        ],
        timestamp: timestamps[index + offset]
      }));
    } catch (error) {
      console.error('MACD calculation error:', error);
      throw error;
    }
  }

  static calculateBollingerBands(
    klines: KlineData[],
    period: number = 20,
    stdDev: number = 2
  ): BollingerBandsResult {
    if (klines.length < period) {
      throw new Error('Insufficient data for Bollinger Bands calculation');
    }

    const prices = this.extractPrices(klines);
    const timestamps = this.extractTimestamps(klines);

    try {
      const bbInput = {
        values: prices,
        period,
        stdDev
      };

      const bbResults = BollingerBands.calculate(bbInput);

      // Bollinger Bands için offset
      const offset = period - 1;

      return {
        upper: bbResults.map((r) => Number(r.upper?.toFixed(8) || 0)),
        middle: bbResults.map((r) => Number(r.middle?.toFixed(8) || 0)),
        lower: bbResults.map((r) => Number(r.lower?.toFixed(8) || 0)),
        timestamp: timestamps.slice(offset)
      };
    } catch (error) {
      console.error('Bollinger Bands calculation error:', error);
      throw error;
    }
  }

  static calculateSMA(klines: KlineData[], period: number): IndicatorResult[] {
    if (klines.length < period) {
      throw new Error('Insufficient data for SMA calculation');
    }

    const prices = this.extractPrices(klines);
    const timestamps = this.extractTimestamps(klines);

    try {
      const smaInput = {
        values: prices,
        period
      };

      const smaResults = SMA.calculate(smaInput);

      // SMA için offset
      const offset = period - 1;

      return smaResults.map((value, index) => ({
        value: Number(value.toFixed(8)),
        timestamp: timestamps[index + offset]
      }));
    } catch (error) {
      console.error('SMA calculation error:', error);
      throw error;
    }
  }

  static calculateEMA(klines: KlineData[], period: number): IndicatorResult[] {
    if (klines.length < period) {
      throw new Error('Insufficient data for EMA calculation');
    }

    const prices = this.extractPrices(klines);
    const timestamps = this.extractTimestamps(klines);

    try {
      const emaInput = {
        values: prices,
        period
      };

      const emaResults = EMA.calculate(emaInput);

      // EMA için offset
      const offset = period - 1;

      return emaResults.map((value, index) => ({
        value: Number(value.toFixed(8)),
        timestamp: timestamps[index + offset]
      }));
    } catch (error) {
      console.error('EMA calculation error:', error);
      throw error;
    }
  }

  // Kline verilerinin geçerliliğini kontrol etme
  static validateKlineData(klines: KlineData[], minLength: number): void {
    if (!Array.isArray(klines) || klines.length < minLength) {
      throw new Error(`Invalid kline data: need at least ${minLength} candles`);
    }

    const requiredFields = [
      'time',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'closeTime'
    ] as const;

    type RequiredField = (typeof requiredFields)[number];

    const isValid = klines.every((kline) =>
      requiredFields.every((field: RequiredField) => {
        const value = kline[field];
        return typeof value === 'number' && !isNaN(value);
      })
    );

    if (!isValid) {
      throw new Error('Invalid kline data: missing or invalid fields');
    }
  }

  // WebSocket kline verilerini dönüştürme
  static parseWebSocketKline(wsKline: {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    T: number;
  }): KlineData {
    return {
      time: wsKline.t, // Kline start time
      open: parseFloat(wsKline.o),
      high: parseFloat(wsKline.h),
      low: parseFloat(wsKline.l),
      close: parseFloat(wsKline.c),
      volume: parseFloat(wsKline.v),
      closeTime: wsKline.T // Kline close time
    };
  }
}
