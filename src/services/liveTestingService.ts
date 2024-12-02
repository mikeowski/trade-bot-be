import WebSocket from 'ws';
import { TradingCore, TradeMetrics } from './tradingCore';
import { TechnicalIndicators, KlineData } from './indicatorService';
import { EventEmitter } from 'events';
import { getHistoricalData } from './priceService';

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
}

interface IndicatorValues {
  rsi: number;
  macd: {
    value: number;
    signal: number;
    histogram: number;
  };
  price: number;
}

interface LiveTradingStrategy {
  rules: {
    buy: string;
    sell: string;
  };
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

    // 1. Combined stream kullanımı
    const ws = new WebSocket(
      `wss://stream.binance.com:9443/stream?streams=${symbol.toLowerCase()}@kline_${timeframe}/${symbol.toLowerCase()}@trade`
    );

    // 2. Subscribe/Unsubscribe mekanizması ekle
    ws.on('open', () => {
      console.log(`[${symbol}] WebSocket connection established`);

      // Subscribe to streams
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

    // 3. Ping/Pong mekanizmasını düzelt
    let pingTimeout: NodeJS.Timeout;
    const heartbeat = () => {
      clearTimeout(pingTimeout);

      // 10 dakika içinde pong gelmezse bağlantıyı kapat
      pingTimeout = setTimeout(() => {
        console.log(`[${symbol}] WebSocket connection timed out`);
        ws.terminate();
      }, 10 * 60 * 1000); // 10 minutes
    };

    ws.on('ping', () => {
      ws.pong(); // Ping geldiğinde hemen pong gönder
      heartbeat();
    });

    ws.on('pong', () => {
      heartbeat();
    });

    // İlk heartbeat'i başlat
    heartbeat();

    // 4. Message handler'ı güncelle
    ws.on('message', (data) => {
      try {
        if (this.isRateLimited(tradeId)) {
          return;
        }

        const message = JSON.parse(data.toString());
        if (!message.data) {
          console.warn('Received malformed message:', message);
          return;
        }

        const streamData = message.data;

        // Kline verisi
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
              this.processTradeLogic(trade, strategy, klineData);
            }
          } else {
            // Mum henüz kapanmadı, ama indikatörleri güncelleyebiliriz
            const tempKlines = [...trade.klines];
            if (tempKlines.length > 0) {
              // Son mumu güncelle
              tempKlines[tempKlines.length - 1] = klineData;

              // İndikatörleri hesapla ama trade mantığını çalıştırma
              if (tempKlines.length >= 50) {
                const indicators = this.calculateIndicators(tempKlines);
                trade.currentIndicators = indicators;
              }
            }
          }
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    });

    // 5. Error ve Close handler'larını güncelle
    ws.on('error', (error) => {
      console.error(`[${symbol}] WebSocket error:`, error);
      clearTimeout(pingTimeout);
      const trade = this.liveTrades.get(tradeId);
      if (trade) {
        trade.lastError = `WebSocket error: ${error.message}`;
      }
    });

    ws.on('close', () => {
      console.log(`[${symbol}] WebSocket connection closed`);
      clearTimeout(pingTimeout);
      const trade = this.liveTrades.get(tradeId);
      if (trade && trade.status === 'running') {
        const currentAttempt = this.reconnectAttempts.get(tradeId) || 0;
        const delay = Math.min(
          1000 * Math.pow(2, currentAttempt),
          this.MAX_RECONNECT_DELAY
        );
        this.reconnectAttempts.set(tradeId, currentAttempt + 1);

        console.log(`Reconnecting in ${delay / 1000} seconds...`);
        setTimeout(() => {
          this.reconnectWebSocket(tradeId, symbol, strategy);
        }, delay);
      }
    });

    return ws;
  }

  private isRateLimited(tradeId: string): boolean {
    const now = Date.now();
    const messages = this.messageRateLimiter.get(tradeId) || [];

    // Son 1 saniyedeki mesajları filtrele
    const recentMessages = messages.filter(
      (time) => now - time < this.MESSAGE_WINDOW
    );

    // Bağlantı limitini kontrol et
    this.connectionAttempts = this.connectionAttempts.filter(
      (time) => now - time < this.CONNECTION_WINDOW
    );

    // Rate limit kontrolü
    if (recentMessages.length >= this.MAX_MESSAGES_PER_SECOND) {
      console.warn(
        `Rate limit exceeded for ${tradeId}. Waiting for next window...`
      );
      return true;
    }

    // Mesajı ekle
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
    strategy: LiveTradingStrategy
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
        klines: historicalKlines
      };

      this.liveTrades.set(tradeId, tradeStatus);

      // Calculate initial indicators if we have enough data
      if (historicalKlines.length >= 50) {
        const indicators = this.calculateIndicators(historicalKlines);
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

  protected calculateIndicators(klines: KlineData[]): IndicatorValues {
    try {
      TechnicalIndicators.validateKlineData(klines, 50);

      const rsi = TechnicalIndicators.calculateRSI(klines, 14);
      const macd = TechnicalIndicators.calculateMACD(klines, 12, 26, 9);

      return {
        rsi: rsi[rsi.length - 1].value,
        macd: {
          value: macd[macd.length - 1].value[0],
          signal: macd[macd.length - 1].value[1],
          histogram: macd[macd.length - 1].value[2]
        },
        price: klines[klines.length - 1].close
      };
    } catch (error) {
      console.error('Error calculating indicators:', error);
      throw error;
    }
  }

  private evaluateCondition(condition: string, context: any): boolean {
    try {
      // Koşulu parçalara ayır
      const parts = condition.split(' ');
      if (parts.length !== 3) {
        console.error('Invalid condition format:', condition);
        return false;
      }

      const [indicator, operator, value] = parts;
      const indicatorValue = context[indicator];
      const targetValue = parseFloat(value);

      if (typeof indicatorValue !== 'number' || isNaN(targetValue)) {
        console.error('Invalid values for comparison:', {
          indicator,
          value: indicatorValue,
          target: targetValue
        });
        return false;
      }

      // Debug log
      console.log('Condition evaluation:', {
        indicator,
        operator,
        currentValue: indicatorValue,
        targetValue,
        context
      });

      switch (operator) {
        case 'below':
          return indicatorValue < targetValue;
        case 'above':
          return indicatorValue > targetValue;
        default:
          console.error('Unknown operator:', operator);
          return false;
      }
    } catch (error) {
      console.error('Error evaluating condition:', error);
      return false;
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

  private processTradeLogic(
    trade: LiveTradeStatus,
    strategy: LiveTradingStrategy,
    klineData: KlineData
  ): void {
    try {
      const indicators = this.calculateIndicators(trade.klines);
      trade.currentIndicators = indicators;

      // Update running time
      trade.performance.runningTimeMs = Date.now() - trade.startTime;

      // Create evaluation context
      const context = {
        close: klineData.close,
        open: klineData.open,
        high: klineData.high,
        low: klineData.low,
        volume: klineData.volume,
        rsi: indicators.rsi,
        macd: indicators.macd.value,
        macd_signal: indicators.macd.signal,
        macd_histogram: indicators.macd.histogram,
        prev_close:
          trade.klines[trade.klines.length - 2]?.close || klineData.close
      };

      // Trading logic
      if (this.position.inPosition) {
        this.checkExitConditions(trade, strategy, context, klineData);
      } else {
        this.checkEntryConditions(trade, strategy, context, klineData);
      }
    } catch (error) {
      console.error('Error in trade logic:', error);
      trade.lastError =
        error instanceof Error ? error.message : 'Unknown error in trade logic';
    }
  }

  private checkExitConditions(
    trade: LiveTradeStatus,
    strategy: LiveTradingStrategy,
    context: any,
    klineData: KlineData
  ): void {
    const stopLossPrice =
      this.position.entryPrice * (1 - strategy.riskManagement.stopLoss / 100);
    const takeProfitPrice =
      this.position.entryPrice * (1 + strategy.riskManagement.takeProfit / 100);

    const shouldExit =
      klineData.close <= stopLossPrice ||
      klineData.close >= takeProfitPrice ||
      this.evaluateCondition(strategy.rules.sell, context);

    if (shouldExit) {
      this.executeExit(Date.now(), klineData.close);
      this.updateTradeStatus(trade.strategyId);

      const lastTrade = this.trades[this.trades.length - 1];
      console.log(
        `[${trade.symbol}] SELL at ${klineData.close} (Candle Close)`,
        {
          profit: lastTrade.profit.toFixed(2),
          balance: this.currentBalance.toFixed(2),
          reason:
            klineData.close <= stopLossPrice
              ? 'Stop Loss'
              : klineData.close >= takeProfitPrice
              ? 'Take Profit'
              : 'Exit Signal',
          indicators: trade.currentIndicators
        }
      );
    }
  }

  private checkEntryConditions(
    trade: LiveTradeStatus,
    strategy: LiveTradingStrategy,
    context: any,
    klineData: KlineData
  ): void {
    const shouldEnter = this.evaluateCondition(strategy.rules.buy, context);

    if (shouldEnter) {
      const stopLossPrice =
        klineData.close * (1 - strategy.riskManagement.stopLoss / 100);
      const riskPerTrade = this.currentBalance * 0.01;
      const riskPerUnit = klineData.close - stopLossPrice;
      const quantity = Math.min(
        riskPerTrade / riskPerUnit,
        (this.currentBalance * strategy.riskManagement.maxPositionSize) /
          100 /
          klineData.close
      );

      if (quantity > 0) {
        this.executeEntry(Date.now(), klineData.close, quantity);
        this.updateTradeStatus(trade.strategyId);

        console.log(
          `[${trade.symbol}] BUY at ${klineData.close} (Candle Close)`,
          {
            quantity,
            stopLoss: stopLossPrice,
            takeProfit:
              klineData.close * (1 + strategy.riskManagement.takeProfit / 100),
            balance: this.currentBalance,
            indicators: trade.currentIndicators
          }
        );
      }
    }
  }
}
