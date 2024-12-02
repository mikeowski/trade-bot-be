import axios from 'axios';
import { KlineData } from './indicatorService';

const API_BASE = 'https://api.binance.com/api/v3';
const MAX_LIMIT = 1000; // Binance API limit

export async function getLivePrice(symbol: string): Promise<{ price: string }> {
  const response = await axios.get(`${API_BASE}/ticker/price?symbol=${symbol}`);
  return response.data;
}

export async function getHistoricalData(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  limit: number = MAX_LIMIT
): Promise<KlineData[]> {
  try {
    // Validate inputs
    if (!symbol || !interval || !startTime || !endTime) {
      throw new Error('Missing required parameters');
    }

    if (endTime <= startTime) {
      throw new Error('End time must be greater than start time');
    }

    // Calculate time chunks if data range is large
    const chunks: { start: number; end: number }[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const chunkEnd = Math.min(
        // Her chunk için maksimum veri sayısını hesapla
        currentStart + limit * getIntervalInMs(interval),
        endTime
      );
      chunks.push({ start: currentStart, end: chunkEnd });
      currentStart = chunkEnd;
    }

    // Fetch data for each chunk
    const allData: KlineData[] = [];

    for (const chunk of chunks) {
      const response = await axios.get(`${API_BASE}/klines`, {
        params: {
          symbol: symbol.toUpperCase(),
          interval,
          startTime: chunk.start,
          endTime: chunk.end,
          limit
        }
      });

      const chunkData = response.data.map((candle: any) => ({
        time: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: candle[6],
        quoteVolume: parseFloat(candle[7]),
        trades: parseInt(candle[8]),
        takerBuyBaseVolume: parseFloat(candle[9]),
        takerBuyQuoteVolume: parseFloat(candle[10])
      }));

      allData.push(...chunkData);
    }

    return allData;
  } catch (error) {
    console.error('Error fetching historical data:', error);
    throw new Error(
      error instanceof Error ? error.message : 'Failed to fetch historical data'
    );
  }
}

export function getIntervalInMs(interval: string): number {
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
