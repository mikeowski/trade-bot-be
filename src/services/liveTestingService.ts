import WebSocket from "ws";
import { TradingCore } from "./tradingCore";
import { TechnicalIndicators, KlineData } from "./indicatorService";
import { getHistoricalData } from "./priceService";
import {
  Strategy,
  StrategyCondition,
  IndicatorType,
  StrategyManager,
} from "./strategyService";

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
  price: number;
}

interface LiveTradeStatus {
  strategyId: string;
  symbol: string;
  status: "running" | "stopped";
  startTime: number;
  currentIndicators: IndicatorValues;
  position: {
    inPosition: boolean;
    entryPrice: number;
    quantity: number;
    side: "long" | "short";
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
  previousIndicators?: IndicatorValues;
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
  private readonly MAX_PRICES = 100;
  private readonly PING_INTERVAL = 3 * 60 * 1000;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000;
  private readonly MAX_RECONNECT_DELAY = 60000;
  private pingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private messageRateLimiter: Map<string, number[]> = new Map();
  private readonly MESSAGE_WINDOW = 1000;
  private readonly MAX_MESSAGES_PER_SECOND = 5;
  private readonly WEIGHT_PER_CONNECTION = 2;
  private readonly MAX_CONNECTIONS = 300;
  private readonly CONNECTION_WINDOW = 5 * 60 * 1000;
  private connectionAttempts: number[] = [];
  private reconnectAttempts: Map<string, number> = new Map();

  constructor(initialBalance: number = 10000) {
    super(initialBalance);
  }

  private getValidTimeframe(timeframe: string): string {
    const validTimeframes = [
      "1s",
      "1m",
      "3m",
      "5m",
      "15m",
      "30m",
      "1h",
      "2h",
      "4h",
      "6h",
      "8h",
      "12h",
      "1d",
      "3d",
      "1w",
      "1M",
    ];

    const tf = timeframe.toLowerCase();
    if (!validTimeframes.includes(tf)) {
      throw new Error(
        `Invalid timeframe: ${timeframe}. Valid timeframes are: ${validTimeframes.join(
          ", ",
        )}`,
      );
    }

    return tf;
  }

  private setupWebSocket(
    tradeId: string,
    symbol: string,
    strategyManager: StrategyManager,
    initialTimeframe = "1m",
  ): WebSocket {
    const now = Date.now();
    if (this.connectionAttempts.length >= this.MAX_CONNECTIONS) {
      throw new Error(
        `Connection limit exceeded. Please wait ${Math.ceil(
          (this.CONNECTION_WINDOW - (now - this.connectionAttempts[0])) / 1000,
        )} seconds.`,
      );
    }
    this.connectionAttempts.push(now);

    const timeframe = this.getValidTimeframe(initialTimeframe);

    const wsEndpoints = [
      `wss://stream.binance.com:9443`,
      `wss://stream.binance.com:443`,
    ];

    const ws = new WebSocket(
      `${
        wsEndpoints[0]
      }/stream?streams=${symbol.toLowerCase()}@kline_${timeframe}/${symbol.toLowerCase()}@trade`,
    );

    ws.on("open", () => {
      console.log(`[${symbol}] WebSocket connection established`);

      const subscribeMessage = {
        method: "SUBSCRIBE",
        params: [
          `${symbol.toLowerCase()}@kline_${timeframe}`,
          `${symbol.toLowerCase()}@trade`,
        ],
        id: Date.now(),
      };
      ws.send(JSON.stringify(subscribeMessage));
    });

    let pingTimeout: NodeJS.Timeout;
    const heartbeat = () => {
      clearTimeout(pingTimeout);

      pingTimeout = setTimeout(
        () => {
          console.log(`[${symbol}] WebSocket connection timed out`);
          ws.terminate();
        },
        10 * 60 * 1000,
      );
    };

    ws.on("ping", (data) => {
      ws.pong(data);
      heartbeat();
    });

    ws.on("pong", heartbeat);

    heartbeat();

    ws.on("message", (data) => {
      try {
        if (this.isRateLimited(tradeId)) {
          return;
        }

        const message = JSON.parse(data.toString());

        if (message.result === null) {
          console.log(`[${symbol}] Successfully subscribed to streams`);
          return;
        }

        if (!message.data) {
          console.warn("Received malformed message:", message);
          return;
        }

        const streamData = message.data;

        if (streamData.e === "kline") {
          const klineData = TechnicalIndicators.parseWebSocketKline(
            streamData.k,
          );
          const trade = this.liveTrades.get(tradeId);
          if (!trade || trade.status !== "running") return;

          const strategy = strategyManager.getStrategy(trade.strategy.id);

          if (strategy) {
            if (streamData.k.x) {
              trade.klines.push(klineData);
              if (trade.klines.length > this.MAX_PRICES) {
                trade.klines.shift();
              }

              if (trade.klines.length >= 50) {
                this.processTradeLogic(trade, klineData, strategy);
              }
            } else {
              const tempKlines = [...trade.klines];
              if (tempKlines.length > 0) {
                tempKlines[tempKlines.length - 1] = klineData;

                if (tempKlines.length >= 50) {
                  const indicators = this.calculateIndicators(
                    tempKlines,
                    strategy,
                  );
                  trade.currentIndicators = indicators;
                }
              }
            }
          } else {
            throw new Error("Strategy not found");
          }
        }
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    });

    ws.on("error", (error) => {
      console.error(`[${symbol}] WebSocket error:`, error);
      clearTimeout(pingTimeout);

      const trade = this.liveTrades.get(tradeId);
      if (trade) {
        trade.lastError = `WebSocket error: ${error.message}`;
      }

      this.handleReconnection(
        tradeId,
        symbol,
        strategyManager,
        initialTimeframe,
      );
    });

    ws.on("close", () => {
      console.log(`[${symbol}] WebSocket connection closed`);
      clearTimeout(pingTimeout);

      const trade = this.liveTrades.get(tradeId);
      if (trade && trade.status === "running") {
        this.handleReconnection(
          tradeId,
          symbol,
          strategyManager,
          initialTimeframe,
        );
      }
    });

    return ws;
  }

  private handleReconnection(
    tradeId: string,
    symbol: string,
    strategyManager: StrategyManager,
    initialTimeframe = "1m",
  ): void {
    const currentAttempt = this.reconnectAttempts.get(tradeId) || 0;

    const delay = Math.min(
      this.RECONNECT_DELAY * Math.pow(2, currentAttempt),
      this.MAX_RECONNECT_DELAY,
    );

    this.reconnectAttempts.set(tradeId, currentAttempt + 1);

    console.log(
      `[${symbol}] Attempting reconnection in ${delay / 1000}s (attempt ${
        currentAttempt + 1
      }/${this.MAX_RECONNECT_ATTEMPTS})`,
    );

    setTimeout(() => {
      this.reconnectWebSocket(
        tradeId,
        symbol,
        strategyManager,
        initialTimeframe,
      );
    }, delay);
  }

  private isRateLimited(tradeId: string): boolean {
    const now = Date.now();
    const messages = this.messageRateLimiter.get(tradeId) || [];

    const recentMessages = messages.filter(
      (time) => now - time < this.MESSAGE_WINDOW,
    );

    if (recentMessages.length >= this.MAX_MESSAGES_PER_SECOND) {
      console.warn(`[${tradeId}] Rate limit exceeded, message dropped`);
      return true;
    }

    recentMessages.push(now);
    this.messageRateLimiter.set(tradeId, recentMessages);

    return false;
  }

  private async reconnectWebSocket(
    tradeId: string,
    symbol: string,
    strategyManager: StrategyManager,
    initialTimeframe = "1m",
  ): Promise<void> {
    const trade = this.liveTrades.get(tradeId);
    if (!trade) return;

    const currentAttempt = this.reconnectAttempts.get(tradeId) || 0;
    if (currentAttempt > this.MAX_RECONNECT_ATTEMPTS) {
      trade.status = "stopped";
      trade.lastError = "Max reconnection attempts reached";
      this.reconnectAttempts.delete(tradeId);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, this.RECONNECT_DELAY));

    try {
      const ws = this.setupWebSocket(
        tradeId,
        symbol,
        strategyManager,
        initialTimeframe,
      );
      this.websockets.set(tradeId, ws);
    } catch (error) {
      console.error(`Failed to reconnect WebSocket for ${symbol}:`, error);
      await this.reconnectWebSocket(
        tradeId,
        symbol,
        strategyManager,
        initialTimeframe,
      );
    }
  }

  private async initializeHistoricalData(
    symbol: string,
    timeframe: string,
  ): Promise<KlineData[]> {
    try {
      const endTime = Date.now();
      const startTime =
        endTime - this.MAX_PRICES * this.getTimeframeInMs(timeframe);

      const historicalData = await getHistoricalData(
        symbol,
        timeframe,
        startTime,
        endTime,
      );

      return historicalData.map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        closeTime: candle.time + this.getTimeframeInMs(timeframe),
      }));
    } catch (error) {
      console.error("Error fetching historical data:", error);
      throw new Error("Failed to initialize historical data");
    }
  }

  private getTimeframeInMs(timeframe: string): number {
    const unit = timeframe.slice(-1);
    const value = parseInt(timeframe.slice(0, -1));

    switch (unit) {
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      case "w":
        return value * 7 * 24 * 60 * 60 * 1000;
      case "M":
        return value * 30 * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Invalid timeframe unit: ${unit}`);
    }
  }

  async startLiveTrade(
    strategyId: string,
    symbol: string,
    strategyManager: StrategyManager,
    timeframe = "1m",
  ): Promise<string> {
    if (!strategyId || !symbol) {
      throw new Error("Missing required parameters for live trading");
    }

    this.getValidTimeframe(timeframe);

    const tradeId = `${strategyId}-${Date.now()}`;
    const startTime = Date.now();

    // Get strategy configuration
    const strategy = strategyManager.getStrategy(strategyId);
    if (!strategy) {
      throw new Error("Strategy not found");
    }

    try {
      const historicalKlines = await this.initializeHistoricalData(
        symbol,
        timeframe,
      );

      const tradeStatus: LiveTradeStatus = {
        strategyId,
        symbol,
        status: "running",
        startTime,
        currentIndicators: {
          rsi: 0,
          macd: {
            value: 0,
            signal: 0,
            histogram: 0,
          },
          price: historicalKlines[historicalKlines.length - 1]?.close || 0,
        },
        position: this.getPosition(),
        performance: {
          totalTrades: 0,
          winningTrades: 0,
          losingTrades: 0,
          totalProfit: 0,
          maxDrawdown: 0,
          runningTimeMs: 0,
        },
        currentBalance: this.getCurrentBalance(),
        trades: this.getTrades(),
        klines: historicalKlines,
        strategy: strategy,
      };

      this.liveTrades.set(tradeId, tradeStatus);

      if (historicalKlines.length >= 50) {
        const indicators = this.calculateIndicators(historicalKlines, strategy);
        console.log(indicators);
        tradeStatus.currentIndicators = indicators;
      }

      const ws = this.setupWebSocket(
        tradeId,
        symbol,
        strategyManager,
        timeframe,
      );
      this.websockets.set(tradeId, ws);

      console.log(
        `[${symbol}] Live trade started with ${historicalKlines.length} historical candles`,
      );
      return tradeId;
    } catch (error) {
      console.error("Error starting live trade:", error);
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
      trade.status = "stopped";
      if (trade.position.inPosition) {
        this.executeExit(Date.now(), trade.currentIndicators.price);
        this.updateTradeStatus(tradeId);
      }
    }
    this.reconnectAttempts.delete(tradeId);
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
    strategy: Strategy,
  ): IndicatorValues {
    try {
      const indicators: IndicatorValues = {
        price: klines[klines.length - 1].close,
      };

      for (const [name, config] of Object.entries(strategy.indicators)) {
        switch (config.type.toLowerCase()) {
          case "rsi": {
            const rsi = TechnicalIndicators.calculateRSI(
              klines,
              (config.params.period as number) || 14,
            );
            indicators[name] = rsi[rsi.length - 1].value;
            break;
          }
          case "macd": {
            const macd = TechnicalIndicators.calculateMACD(
              klines,
              (config.params.fastPeriod as number) || 12,
              (config.params.slowPeriod as number) || 26,
              (config.params.signalPeriod as number) || 9,
            );
            const latest = macd[macd.length - 1];
            indicators[name] = {
              value: latest.value[0],
              signal: latest.value[1],
              histogram: latest.value[2],
            };
            break;
          }
          case "bollinger": {
            const bb = TechnicalIndicators.calculateBollingerBands(
              klines,
              (config.params.period as number) || 20,
              (config.params.stdDev as number) || 2,
            );
            indicators[name] = {
              value: bb.middle[bb.middle.length - 1],
              upper: bb.upper[bb.upper.length - 1],
              middle: bb.middle[bb.middle.length - 1],
              lower: bb.lower[bb.lower.length - 1],
            };
            break;
          }
          case "sma": {
            const sma = TechnicalIndicators.calculateSMA(
              klines,
              (config.params.period as number) || 20,
            );
            indicators[name] = {
              value: sma[sma.length - 1].value as number,
            };
            break;
          }
          case "ema": {
            const ema = TechnicalIndicators.calculateEMA(
              klines,
              (config.params.period as number) || 20,
            );
            indicators[name] = {
              value: ema[ema.length - 1].value as number,
            };
            break;
          }
        }
      }

      return indicators;
    } catch (error) {
      console.error("Error calculating indicators:", error);
      throw error;
    }
  }

  private evaluateCondition(
    condition: StrategyCondition,
    currentValue: number,
    targetValue: number,
    previousValue?: number,
    previousTargetValue?: number,
  ): boolean {
    switch (condition.comparison) {
      case "above":
        return currentValue > targetValue;
      case "below":
        return currentValue < targetValue;
      case "crosses_above":
        return (
          previousValue !== undefined &&
          previousTargetValue !== undefined &&
          previousValue <= previousTargetValue &&
          currentValue > targetValue
        );
      case "crosses_below":
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
    context: IndicatorValues,
  ): number | undefined {
    const value = context[indicator];
    if (typeof value === "number") {
      return value;
    } else if (value && typeof value === "object") {
      if ("value" in value) return value.value;
      if ("middle" in value) return value.middle;
    }
    return undefined;
  }

  private processTradeLogic(
    trade: LiveTradeStatus,
    klineData: KlineData,
    strategy: Strategy,
  ): void {
    try {
      const currentIndicators = this.calculateIndicators(
        trade.klines,
        strategy,
      );
      const previousIndicators = trade.currentIndicators;
      trade.previousIndicators = previousIndicators;
      trade.currentIndicators = currentIndicators;

      if (this.position.inPosition) {
        const stopLossPrice =
          this.position.entryPrice *
          (1 - strategy.riskManagement.stopLoss / 100);
        const takeProfitPrice =
          this.position.entryPrice *
          (1 + strategy.riskManagement.takeProfit / 100);

        const shouldExit =
          klineData.close <= stopLossPrice ||
          klineData.close >= takeProfitPrice ||
          strategy.exitConditions.some((condition) => {
            const currentValue = this.getIndicatorValue(
              condition.indicator,
              currentIndicators,
            );
            const targetValue = condition.targetIndicator
              ? this.getIndicatorValue(
                  condition.targetIndicator,
                  currentIndicators,
                )
              : Number(condition.value);
            const previousValue = previousIndicators
              ? this.getIndicatorValue(condition.indicator, previousIndicators)
              : undefined;
            const previousTargetValue =
              previousIndicators && condition.targetIndicator
                ? this.getIndicatorValue(
                    condition.targetIndicator,
                    previousIndicators,
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
                previousTargetValue,
              )
            );
          });

        if (shouldExit) {
          this.executeExit(Date.now(), klineData.close);
          this.updateTradeStatus(trade.strategyId);
        }
      } else {
        const shouldEnter = strategy.entryConditions.every((condition) => {
          const currentValue = this.getIndicatorValue(
            condition.indicator,
            currentIndicators,
          );
          const targetValue = condition.targetIndicator
            ? this.getIndicatorValue(
                condition.targetIndicator,
                currentIndicators,
              )
            : Number(condition.value);
          const previousValue = previousIndicators
            ? this.getIndicatorValue(condition.indicator, previousIndicators)
            : undefined;
          const previousTargetValue =
            previousIndicators && condition.targetIndicator
              ? this.getIndicatorValue(
                  condition.targetIndicator,
                  previousIndicators,
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
              previousTargetValue,
            )
          );
        });

        if (shouldEnter) {
          const stopLossPrice =
            klineData.close * (1 - strategy.riskManagement.stopLoss / 100);
          const riskPerTrade = this.currentBalance * 0.01;
          const riskPerUnit = klineData.close - stopLossPrice;
          const quantity = Math.min(
            riskPerTrade / riskPerUnit,
            (this.currentBalance * strategy.riskManagement.maxPositionSize) /
              100 /
              klineData.close,
          );

          if (quantity > 0) {
            this.executeEntry(Date.now(), klineData.close, quantity);
            this.updateTradeStatus(trade.strategyId);
          }
        }
      }
    } catch (error) {
      console.error("Error in trade logic:", error);
      trade.lastError =
        error instanceof Error ? error.message : "Unknown error in trade logic";
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
        runningTimeMs: Date.now() - trade.startTime,
      };
      trade.currentBalance = this.getCurrentBalance();
      trade.position = this.getPosition();
      trade.trades = this.getTrades();
    } catch (error) {
      console.error("Error updating trade status:", error);
      trade.lastError =
        error instanceof Error
          ? error.message
          : "Unknown error updating status";
    }
  }

  getAllActiveTrades() {
    return Array.from(this.liveTrades.keys())
      .map((tradeId) => ({
        id: tradeId,
        ...this.liveTrades.get(tradeId),
      }))
      .filter((trade) => trade.status === "running");
  }
  updateTradeStrategy(tradeId: string, newStrategyId: string) {
    const trade = this.liveTrades.get(tradeId);
    if (!trade) return;
    trade.strategyId = newStrategyId;
  }
}
