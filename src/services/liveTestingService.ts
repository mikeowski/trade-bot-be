import WebSocket from 'ws';
import { TradingCore, TradeMetrics } from './tradingCore';
import { TechnicalIndicators, KlineData } from './indicatorService';
import { EventEmitter } from 'events';
import { getHistoricalData } from './priceService';
import { Strategy, StrategyCondition, IndicatorType } from './strategyService';
import { RiskManagementService } from './riskManagementService';

// Dinamik indikatör değerleri için interface güncellendi
interface IndicatorValues {
  [key: string]:
    | number
    | {
        value?: number;
        signal?: number;
        histogram?: number;
        upper?: number;
        middle?: number;
        lower?: number;
      };
  price: number; // Price is always required
}

interface LiveTradeStatus {
  strategyId: string;
  symbol: string;
  status: 'running' | 'stopped';
  startTime: number;
  currentIndicators: IndicatorValues;
  position: {
    inPosition: boolean;
    entryPrice: number;
    quantity: number;
    side: 'long' | 'short';
  };
  performance: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalProfit: number;
    maxDrawdown: number;
    runningTimeMs: number;
  };
  currentBalance: number;
  trades: any[];
  lastError?: string;
  lastPingTime?: number;
  reconnectAttempts?: number;
  klines: KlineData[];
  strategy: Strategy;
  previousIndicators?: IndicatorValues; // Crossover kontrolleri için eklendi
}

interface LiveTradingStrategy {
  indicators: {
    [key in IndicatorType]?: {
      type: string;
      params: {
        [key: string]: number | string;
      };
    };
  };
  entryConditions: StrategyCondition[];
  exitConditions: StrategyCondition[];
  riskManagement: {
    stopLoss: number;
    takeProfit: number;
    maxPositionSize: number;
    trailingStop?: number;
  };
  timeframe?: string;
}

export class LiveTradingService extends TradingCore {
  private liveTrades: Map<string, LiveTradeStatus> = new Map();
  private websockets: Map<string, WebSocket> = new Map();
  private readonly MAX_PRICES = 100; // Keep more prices for better indicator calculation
  private readonly PING_INTERVAL = 3 * 60 * 1000; // 3 minutes
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  private readonly MAX_RECONNECT_DELAY = 60000; // 1 dakika maksimum reconnect gecikmesi
  private pingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private messageRateLimiter: Map<string, number[]> = new Map();
  private readonly MESSAGE_WINDOW = 1000; // 1 saniye
  private readonly MAX_MESSAGES_PER_SECOND = 5;
  private readonly WEIGHT_PER_CONNECTION = 2;
  private readonly MAX_CONNECTIONS = 300; // 5 dakikada maksimum bağlantı
  private readonly CONNECTION_WINDOW = 5 * 60 * 1000; // 5 dakika
  private connectionAttempts: number[] = [];
  private reconnectAttempts: Map<string, number> = new Map(); // Her bağlantı için yeniden bağlanma denemesi sayısı

  constructor(initialBalance: number = 10000) {
    super(initialBalance);
  }

  private getValidTimeframe(timeframe: string): string {
    const validTimeframes = [
      '1s', // 1 second
      '1m',
      '3m',
      '5m',
      '15m',
      '30m', // minutes
      '1h',
      '2h',
      '4h',
      '6h',
      '8h',
      '12h', // hours
      '1d',
      '3d', // days
      '1w', // week
      '1M' // month
    ];

    const tf = timeframe.toLowerCase();
    if (!validTimeframes.includes(tf)) {
      throw new Error(
        `Invalid timeframe: ${timeframe}. Valid timeframes are: ${validTimeframes.join(
          ', '
        )}`
      );
    }

    return tf;
  }

  private setupWebSocket(
    tradeId: string,
    symbol: string,
    strategy: LiveTradingStrategy
  ): WebSocket {
    // Bağlantı limiti kontrolü
    const now = Date.now();
    if (this.connectionAttempts.length >= this.MAX_CONNECTIONS) {
      throw new Error(
        `Connection limit exceeded. Please wait ${Math.ceil(
          (this.CONNECTION_WINDOW - (now - this.connectionAttempts[0])) / 1000
        )} seconds.`
      );
    }
    this.connectionAttempts.push(now);

    const timeframe = this.getValidTimeframe(strategy.timeframe || '1m');

    // Use combined stream with both base endpoints for redundancy
    const wsEndpoints = [
      `wss://stream.binance.com:9443`,
      `wss://stream.binance.com:443`
    ];

    // Try primary endpoint first, fallback to secondary
    const ws = new WebSocket(
      `${
        wsEndpoints[0]
      }/stream?streams=${symbol.toLowerCase()}@kline_${timeframe}/${symbol.toLowerCase()}@trade`
    );

    ws.on('open', () => {
      console.log(`[${symbol}] WebSocket connection established`);

      // Subscribe to streams with proper ID
      const subscribeMessage = {
        method: 'SUBSCRIBE',
        params: [
          `${symbol.toLowerCase()}@kline_${timeframe}`,
          `${symbol.toLowerCase()}@trade`
        ],
        id: Date.now()
      };
      ws.send(JSON.stringify(subscribeMessage));
    });

    // Implement proper ping/pong handling per Binance docs
    let pingTimeout: NodeJS.Timeout;
    const heartbeat = () => {
      clearTimeout(pingTimeout);

      // Disconnect if no pong received within 10 minutes
      pingTimeout = setTimeout(() => {
        console.log(`[${symbol}] WebSocket connection timed out`);
        ws.terminate();
      }, 10 * 60 * 1000);
    };

    ws.on('ping', (data) => {
      ws.pong(data); // Echo back ping payload
      heartbeat();
    });

    ws.on('pong', heartbeat);

    // Start heartbeat on connection
    heartbeat();

    // Handle incoming messages with proper rate limiting
    ws.on('message', (data) => {
      try {
        // Check rate limits before processing
        if (this.isRateLimited(tradeId)) {
          return;
        }

        const message = JSON.parse(data.toString());

        // Handle subscription responses
        if (message.result === null) {
          console.log(`[${symbol}] Successfully subscribed to streams`);
          return;
        }

        // Handle stream data
        if (!message.data) {
          console.warn('Received malformed message:', message);
          return;
        }

        const streamData = message.data;

        // Process kline data
        if (streamData.e === 'kline') {
          const klineData = TechnicalIndicators.parseWebSocketKline(
            streamData.k
          );
          const trade = this.liveTrades.get(tradeId);

          if (!trade || trade.status !== 'running') return;

          // Mum kapanışlarında işlem yap
          if (streamData.k.x) {
            // Yeni mumu ekle ve en eski mumu çıkar
            trade.klines.push(klineData);
            if (trade.klines.length > this.MAX_PRICES) {
              trade.klines.shift();
            }

            // İndikatörleri hesapla ve trade mantığını çalıştır
            if (trade.klines.length >= 50) {
              this.processTradeLogic(trade, klineData);
            }
          } else {
            // Mum henüz kapanmadı, ama indikatörleri güncelleyebiliriz
            const tempKlines = [...trade.klines];
            if (tempKlines.length > 0) {
              // Son mumu güncelle
              tempKlines[tempKlines.length - 1] = klineData;

              // İndikatörleri hesapla ama trade mantığını çalıştırma
              if (tempKlines.length >= 50) {
                const indicators = this.calculateIndicators(
                  tempKlines,
                  trade.strategy
                );
                trade.currentIndicators = indicators;
              }
            }
          }
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    });

    // Enhanced error handling
    ws.on('error', (error) => {
      console.error(`[${symbol}] WebSocket error:`, error);
      clearTimeout(pingTimeout);

      const trade = this.liveTrades.get(tradeId);
      if (trade) {
        trade.lastError = `WebSocket error: ${error.message}`;
      }

      // Attempt reconnection on error
      this.handleReconnection(tradeId, symbol, strategy);
    });

    ws.on('close', () => {
      console.log(`[${symbol}] WebSocket connection closed`);
      clearTimeout(pingTimeout);

      // Attempt reconnection on close if trade is still running
      const trade = this.liveTrades.get(tradeId);
      if (trade && trade.status === 'running') {
        this.handleReconnection(tradeId, symbol, strategy);
      }
    });

    return ws;
  }

  // Helper method to handle reconnection logic
  private handleReconnection(
    tradeId: string,
    symbol: string,
    strategy: LiveTradingStrategy
  ): void {
    const currentAttempt = this.reconnectAttempts.get(tradeId) || 0;

    // Implement exponential backoff with max delay
    const delay = Math.min(
      this.RECONNECT_DELAY * Math.pow(2, currentAttempt),
      this.MAX_RECONNECT_DELAY
    );

    this.reconnectAttempts.set(tradeId, currentAttempt + 1);

    console.log(
      `[${symbol}] Attempting reconnection in ${delay / 1000}s (attempt ${
        currentAttempt + 1
      }/${this.MAX_RECONNECT_ATTEMPTS})`
    );

    setTimeout(() => {
      this.reconnectWebSocket(tradeId, symbol, strategy);
    }, delay);
  }

  // Update rate limiting implementation
  private isRateLimited(tradeId: string): boolean {
    const now = Date.now();
    const messages = this.messageRateLimiter.get(tradeId) || [];

    // Keep only messages within the last second
    const recentMessages = messages.filter(
      (time) => now - time < this.MESSAGE_WINDOW
    );

    // Check against Binance's 5 messages per second limit
    if (recentMessages.length >= this.MAX_MESSAGES_PER_SECOND) {
      console.warn(`[${tradeId}] Rate limit exceeded, message dropped`);
      return true;
    }

    // Update message history
    recentMessages.push(now);
    this.messageRateLimiter.set(tradeId, recentMessages);

    return false;
  }

  private async reconnectWebSocket(
    tradeId: string,
    symbol: string,
    strategy: LiveTradingStrategy
  ): Promise<void> {
    const trade = this.liveTrades.get(tradeId);
    if (!trade) return;

    const currentAttempt = this.reconnectAttempts.get(tradeId) || 0;
    if (currentAttempt > this.MAX_RECONNECT_ATTEMPTS) {
      trade.status = 'stopped';
      trade.lastError = 'Max reconnection attempts reached';
      this.reconnectAttempts.delete(tradeId);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, this.RECONNECT_DELAY));

    try {
      const ws = this.setupWebSocket(tradeId, symbol, strategy);
      this.websockets.set(tradeId, ws);
    } catch (error) {
      console.error(`Failed to reconnect WebSocket for ${symbol}:`, error);
      await this.reconnectWebSocket(tradeId, symbol, strategy);
    }
  }

  private async initializeHistoricalData(
    symbol: string,
    timeframe: string
  ): Promise<KlineData[]> {
    try {
      // Son 100 mumu al (50 minimum gerekli, 100 alarak buffer bırakıyoruz)
      const endTime = Date.now();
      const startTime =
        endTime - this.MAX_PRICES * this.getTimeframeInMs(timeframe);

      const historicalData = await getHistoricalData(
        symbol,
        timeframe,
        startTime,
        endTime
      );

      // Convert to KlineData format
      return historicalData.map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        closeTime: candle.time + this.getTimeframeInMs(timeframe)
      }));
    } catch (error) {
      console.error('Error fetching historical data:', error);
      throw new Error('Failed to initialize historical data');
    }
  }

  private getTimeframeInMs(timeframe: string): number {
    const unit = timeframe.slice(-1);
    const value = parseInt(timeframe.slice(0, -1));

    switch (unit) {
      case 's':
        return value * 1000;
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
        throw new Error(`Invalid timeframe unit: ${unit}`);
    }
  }

  async startLiveTrade(
    strategyId: string,
    symbol: string,
    strategy: Strategy & { timeframe?: string }
  ): Promise<string> {
    if (!strategyId || !symbol || !strategy) {
      throw new Error('Missing required parameters for live trading');
    }

    // Validate timeframe before starting
    const timeframe = strategy.timeframe || '1m';
    this.getValidTimeframe(timeframe);

    const tradeId = `${strategyId}-${Date.now()}`;
    const startTime = Date.now();

    try {
      // Get historical data first
      const historicalKlines = await this.initializeHistoricalData(
        symbol,
        timeframe
      );

      // Initialize trade status with historical data
      const tradeStatus: LiveTradeStatus = {
        strategyId,
        symbol,
        status: 'running',
        startTime,
        currentIndicators: {
          rsi: 0,
          macd: {
            value: 0,
            signal: 0,
            histogram: 0
          },
          price: historicalKlines[historicalKlines.length - 1]?.close || 0
        },
        position: this.getPosition(),
        performance: {
          totalTrades: 0,
          winningTrades: 0,
          losingTrades: 0,
          totalProfit: 0,
          maxDrawdown: 0,
          runningTimeMs: 0
        },
        currentBalance: this.getCurrentBalance(),
        trades: this.getTrades(),
        klines: historicalKlines,
        strategy: strategy
      };

      this.liveTrades.set(tradeId, tradeStatus);

      // Calculate initial indicators if we have enough data
      if (historicalKlines.length >= 50) {
        const indicators = this.calculateIndicators(historicalKlines, strategy);
        console.log(indicators);
        tradeStatus.currentIndicators = indicators;
      }

      // Setup WebSocket connection
      const ws = this.setupWebSocket(tradeId, symbol, strategy);
      this.websockets.set(tradeId, ws);

      console.log(
        `[${symbol}] Live trade started with ${historicalKlines.length} historical candles`
      );
      return tradeId;
    } catch (error) {
      console.error('Error starting live trade:', error);
      throw error;
    }
  }

  stopLiveTrade(tradeId: string): void {
    const ws = this.websockets.get(tradeId);
    const pingInterval = this.pingIntervals.get(tradeId);

    if (pingInterval) {
      clearInterval(pingInterval);
      this.pingIntervals.delete(tradeId);
    }

    this.messageRateLimiter.delete(tradeId);

    if (ws) {
      ws.close();
      this.websockets.delete(tradeId);
    }

    const trade = this.liveTrades.get(tradeId);
    if (trade) {
      trade.status = 'stopped';
      // Close any open position
      if (trade.position.inPosition) {
        this.executeExit(Date.now(), trade.currentIndicators.price);
        this.updateTradeStatus(tradeId);
      }
    }
    this.reconnectAttempts.delete(tradeId); // Yeniden bağlanma denemesi sayısını temizle
  }

  getLiveTradeStatus(tradeId: string): LiveTradeStatus | undefined {
    const trade = this.liveTrades.get(tradeId);
    if (trade) {
      this.updateTradeStatus(tradeId);
    }
    return trade;
  }

  private calculateIndicators(
    klines: KlineData[],
    strategy: Strategy
  ): IndicatorValues {
    try {
      // Initialize with required price field
      const indicators: IndicatorValues = {
        price: klines[klines.length - 1].close
      };

      for (const [name, config] of Object.entries(strategy.indicators)) {
        switch (config.type.toLowerCase()) {
          case 'rsi': {
            const rsi = TechnicalIndicators.calculateRSI(
              klines,
              (config.params.period as number) || 14
            );
            indicators[name] = rsi[rsi.length - 1].value;
            break;
          }
          case 'macd': {
            const macd = TechnicalIndicators.calculateMACD(
              klines,
              (config.params.fastPeriod as number) || 12,
              (config.params.slowPeriod as number) || 26,
              (config.params.signalPeriod as number) || 9
            );
            const latest = macd[macd.length - 1];
            indicators[name] = {
              value: latest.value[0],
              signal: latest.value[1],
              histogram: latest.value[2]
            };
            break;
          }
          case 'bollinger': {
            const bb = TechnicalIndicators.calculateBollingerBands(
              klines,
              (config.params.period as number) || 20,
              (config.params.stdDev as number) || 2
            );
            indicators[name] = {
              value: bb.middle[bb.middle.length - 1], // Ana değer olarak middle band'i kullan
              upper: bb.upper[bb.upper.length - 1],
              middle: bb.middle[bb.middle.length - 1],
              lower: bb.lower[bb.lower.length - 1]
            };
            break;
          }
          case 'sma': {
            const sma = TechnicalIndicators.calculateSMA(
              klines,
              (config.params.period as number) || 20
            );
            indicators[name] = {
              value: sma[sma.length - 1].value as number
            };
            break;
          }
          case 'ema': {
            const ema = TechnicalIndicators.calculateEMA(
              klines,
              (config.params.period as number) || 20
            );
            indicators[name] = {
              value: ema[ema.length - 1].value as number
            };
            break;
          }
        }
      }

      return indicators;
    } catch (error) {
      console.error('Error calculating indicators:', error);
      throw error;
    }
  }

  private evaluateCondition(
    condition: StrategyCondition,
    currentValue: number,
    targetValue: number,
    previousValue?: number,
    previousTargetValue?: number
  ): boolean {
    switch (condition.comparison) {
      case 'above':
        return currentValue > targetValue;
      case 'below':
        return currentValue < targetValue;
      case 'crosses_above':
        return (
          previousValue !== undefined &&
          previousTargetValue !== undefined &&
          previousValue <= previousTargetValue &&
          currentValue > targetValue
        );
      case 'crosses_below':
        return (
          previousValue !== undefined &&
          previousTargetValue !== undefined &&
          previousValue >= previousTargetValue &&
          currentValue < targetValue
        );
      default:
        return false;
    }
  }

  private getIndicatorValue(
    indicator: string,
    context: IndicatorValues
  ): number | undefined {
    const value = context[indicator];
    if (typeof value === 'number') {
      return value;
    } else if (value && typeof value === 'object') {
      if ('value' in value) return value.value;
      if ('middle' in value) return value.middle;
    }
    return undefined;
  }

  private processTradeLogic(
    trade: LiveTradeStatus,
    klineData: KlineData
  ): void {
    try {
      const currentIndicators = this.calculateIndicators(
        trade.klines,
        trade.strategy
      );
      const previousIndicators = trade.currentIndicators;
      trade.previousIndicators = previousIndicators;
      trade.currentIndicators = currentIndicators;

      const context = {
        ...currentIndicators,
        price: klineData.close,
        open: klineData.open,
        high: klineData.high,
        low: klineData.low,
        close: klineData.close,
        volume: klineData.volume
      };

      if (this.position.inPosition) {
        const stopLossPrice =
          this.position.entryPrice *
          (1 - trade.strategy.riskManagement.stopLoss / 100);
        const takeProfitPrice =
          this.position.entryPrice *
          (1 + trade.strategy.riskManagement.takeProfit / 100);

        const shouldExit =
          klineData.close <= stopLossPrice ||
          klineData.close >= takeProfitPrice ||
          trade.strategy.exitConditions.some((condition) => {
            const currentValue = this.getIndicatorValue(
              condition.indicator,
              currentIndicators
            );
            const targetValue = condition.targetIndicator
              ? this.getIndicatorValue(
                  condition.targetIndicator,
                  currentIndicators
                )
              : Number(condition.value);
            const previousValue = previousIndicators
              ? this.getIndicatorValue(condition.indicator, previousIndicators)
              : undefined;
            const previousTargetValue =
              previousIndicators && condition.targetIndicator
                ? this.getIndicatorValue(
                    condition.targetIndicator,
                    previousIndicators
                  )
                : undefined;

            return (
              currentValue !== undefined &&
              targetValue !== undefined &&
              this.evaluateCondition(
                condition,
                currentValue,
                targetValue,
                previousValue,
                previousTargetValue
              )
            );
          });

        if (shouldExit) {
          this.executeExit(Date.now(), klineData.close);
          this.updateTradeStatus(trade.strategyId);
        }
      } else {
        const shouldEnter = trade.strategy.entryConditions.every(
          (condition) => {
            const currentValue = this.getIndicatorValue(
              condition.indicator,
              currentIndicators
            );
            const targetValue = condition.targetIndicator
              ? this.getIndicatorValue(
                  condition.targetIndicator,
                  currentIndicators
                )
              : Number(condition.value);
            const previousValue = previousIndicators
              ? this.getIndicatorValue(condition.indicator, previousIndicators)
              : undefined;
            const previousTargetValue =
              previousIndicators && condition.targetIndicator
                ? this.getIndicatorValue(
                    condition.targetIndicator,
                    previousIndicators
                  )
                : undefined;

            return (
              currentValue !== undefined &&
              targetValue !== undefined &&
              this.evaluateCondition(
                condition,
                currentValue,
                targetValue,
                previousValue,
                previousTargetValue
              )
            );
          }
        );

        if (shouldEnter) {
          const stopLossPrice =
            klineData.close *
            (1 - trade.strategy.riskManagement.stopLoss / 100);
          const riskPerTrade = this.currentBalance * 0.01;
          const riskPerUnit = klineData.close - stopLossPrice;
          const quantity = Math.min(
            riskPerTrade / riskPerUnit,
            (this.currentBalance *
              trade.strategy.riskManagement.maxPositionSize) /
              100 /
              klineData.close
          );

          if (quantity > 0) {
            this.executeEntry(Date.now(), klineData.close, quantity);
            this.updateTradeStatus(trade.strategyId);
          }
        }
      }
    } catch (error) {
      console.error('Error in trade logic:', error);
      trade.lastError =
        error instanceof Error ? error.message : 'Unknown error in trade logic';
    }
  }

  private updateTradeStatus(tradeId: string): void {
    const trade = this.liveTrades.get(tradeId);
    if (!trade) return;

    try {
      const metrics = this.getMetrics();
      trade.performance = {
        totalTrades: metrics.totalTrades,
        winningTrades: metrics.winningTrades,
        losingTrades: metrics.losingTrades,
        totalProfit: metrics.totalProfit,
        maxDrawdown: metrics.maxDrawdown,
        runningTimeMs: Date.now() - trade.startTime
      };
      trade.currentBalance = this.getCurrentBalance();
      trade.position = this.getPosition();
      trade.trades = this.getTrades();
    } catch (error) {
      console.error('Error updating trade status:', error);
      trade.lastError =
        error instanceof Error
          ? error.message
          : 'Unknown error updating status';
    }
  }
}
