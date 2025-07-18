import express from 'express';
import cors from 'cors';
import { TradingService } from '../services/tradingService';
import { StrategyManager } from '../services/strategyService';
import { getHistoricalData, getIntervalInMs } from '../services/priceService';
import { TechnicalIndicators } from '../services/indicatorService';
import { Application } from 'express';
import { WebSocket } from 'ws';
import { Instance } from 'express-ws';

// Export a function that takes the ws app instance
export default function (wsInstance: Instance) {
  const router = express.Router();

  // Get the app from the instance and enable ws
  wsInstance.getWss();
  wsInstance.applyTo(router);

  const corsOptions = {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200,
    maxAge: 600,
    preflightContinue: false
  };

  router.use(cors(corsOptions));

  const strategyManager = new StrategyManager();
  const tradingService = new TradingService(
    10000,
    {
      maxPositionSize: 20,
      maxTotalExposure: 80,
      riskPerTrade: 1,
      maxDrawdown: 20,
      stopLossPercentage: 2,
      takeProfitPercentage: 4
    },
    strategyManager
  );

  // Error handling helper
  const handleError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    return 'An unknown error occurred';
  };

  // Strategy Management
  router.post('/strategies', async (req, res) => {
    try {
      const strategyId = await strategyManager.addStrategy(req.body);
      res.json({ success: true, strategyId });
    } catch (error) {
      console.error('Error creating strategy:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  router.get('/strategies', async (req, res) => {
    try {
      const strategies = await strategyManager.getAllStrategies();
      res.json({ success: true, strategies });
    } catch (error) {
      console.error('Error getting strategies:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  router.get('/strategies/:id', async (req, res) => {
    try {
      const strategy = await strategyManager.getStrategy(req.params.id);
      if (!strategy) {
        return res
          .status(404)
          .json({ success: false, error: 'Strategy not found' });
      }
      res.json({ success: true, strategy });
    } catch (error) {
      console.error('Error getting strategy:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  router.put('/strategies/:id', async (req, res) => {
    try {
      const success = await strategyManager.updateStrategy(
        req.params.id,
        req.body
      );
      if (!success) {
        return res
          .status(404)
          .json({ success: false, error: 'Strategy not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating strategy:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  router.delete('/strategies/:id', async (req, res) => {
    try {
      const success = await strategyManager.deleteStrategy(req.params.id);
      if (!success) {
        return res
          .status(404)
          .json({ success: false, error: 'Strategy not found' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting strategy:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  // Backtesting
  router.post('/backtest/:strategyId', async (req, res) => {
    try {
      const { symbol, timeframe, startTime, endTime } = req.body;
      const result = await strategyManager.runBacktest(
        req.params.strategyId,
        symbol,
        timeframe,
        startTime,
        endTime
      );
      res.json({ success: true, result });
    } catch (error) {
      console.error('Error running backtest:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  router.get('/backtest/:strategyId', async (req, res) => {
    try {
      const result = await strategyManager.getBacktestResult(
        req.params.strategyId
      );
      if (!result) {
        return res
          .status(404)
          .json({ success: false, error: 'Backtest result not found' });
      }
      res.json({ success: true, result });
    } catch (error) {
      console.error('Error getting backtest result:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  // Live Trading
  router.post('/live-trading', async (req, res) => {
    try {
      const { strategyId, symbol, timeframe } = req.body;

      // Get the strategy first
      const strategy = await strategyManager.getStrategy(strategyId);
      if (!strategy) {
        return res.status(404).json({
          success: false,
          error: 'Strategy not found'
        });
      }

      const tradeId = await tradingService.startLiveTrading(
        strategyId,
        symbol,
        {
          timeframe: timeframe || '1m' // Default to 1m if not specified
        }
      );

      res.json({
        success: true,
        tradeId,
        message: `Live trading started with ${timeframe || '1m'} timeframe`
      });
    } catch (error) {
      console.error('Error starting live trading:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  router.get('/live-trading/:tradeId', async (req, res) => {
    try {
      const status = tradingService.getLiveTradingStatus(req.params.tradeId);
      if (!status) {
        return res
          .status(404)
          .json({ success: false, error: 'Trade not found' });
      }
      res.json({ success: true, status });
    } catch (error) {
      console.error('Error getting live trading status:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  // WebSocket connections map
  const tradeSubscriptions: Map<string, Set<WebSocket>> = new Map();

  // Add WebSocket endpoint for live trade updates
  router.ws('/live-trading/:tradeId/ws', (ws, req) => {
    const tradeId = req.params.tradeId;

    // Add this connection to subscribers for this trade
    if (!tradeSubscriptions.has(tradeId)) {
      tradeSubscriptions.set(tradeId, new Set());
    }
    tradeSubscriptions.get(tradeId)?.add(ws);

    // Setup interval for sending updates
    const updateInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        try {
          const status = tradingService.getLiveTradingStatus(tradeId);
          if (status) {
            ws.send(
              JSON.stringify({
                type: 'trade_update',
                data: status
              })
            );
          } else {
            // Trade not found or stopped
            ws.send(
              JSON.stringify({
                type: 'trade_ended',
                message: 'Trade not found or stopped'
              })
            );
            clearInterval(updateInterval);
            ws.close();
          }
        } catch (error) {
          console.error(`Error sending trade update for ${tradeId}:`, error);
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Error getting trade status'
            })
          );
        }
      }
    }, 1000); // Send updates every second

    // Handle client disconnect
    ws.on('close', () => {
      clearInterval(updateInterval);
      tradeSubscriptions.get(tradeId)?.delete(ws);
      if (tradeSubscriptions.get(tradeId)?.size === 0) {
        tradeSubscriptions.delete(tradeId);
      }
    });

    // Send initial status
    const initialStatus = tradingService.getLiveTradingStatus(tradeId);
    if (initialStatus) {
      ws.send(
        JSON.stringify({
          type: 'trade_update',
          data: initialStatus
        })
      );
    }
  });

  // Modify existing stop endpoint to notify WebSocket clients
  router.post('/live-trading/:tradeId/stop', async (req, res) => {
    try {
      await tradingService.stopLiveTrading(req.params.tradeId);

      // Notify all WebSocket clients subscribed to this trade
      const subscribers = tradeSubscriptions.get(req.params.tradeId);
      if (subscribers) {
        subscribers.forEach((client) => {
          if (client.readyState === client.OPEN) {
            client.send(
              JSON.stringify({
                type: 'trade_stopped',
                message: 'Trade has been stopped'
              })
            );
            client.close();
          }
        });
        tradeSubscriptions.delete(req.params.tradeId);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error stopping live trading:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  // Technical Analysis
  router.post('/analysis/indicators', async (req, res) => {
    try {
      const { symbol, timeframe, startTime, endTime } = req.body;
      const result = await tradingService.calculateIndicators(
        symbol,
        timeframe,
        startTime,
        endTime
      );
      res.json({ success: true, result });
    } catch (error) {
      console.error('Error calculating indicators:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  // Debug endpoint
  router.get('/live-trading/:tradeId/debug', async (req, res) => {
    try {
      const status = tradingService.getLiveTradingStatus(req.params.tradeId);
      if (!status) {
        return res
          .status(404)
          .json({ success: false, error: 'Trade not found' });
      }

      const rsiValue =
        typeof status.currentIndicators.rsi === 'number'
          ? status.currentIndicators.rsi
          : status.currentIndicators.rsi?.value || 0;

      const debugInfo = {
        ...status,
        evaluationContext: {
          rsi: rsiValue,
          price: status.currentIndicators.price,
          entryCondition: 'rsi below 80',
          exitCondition: 'rsi above 95',
          shouldEnter: rsiValue < 80,
          shouldExit: rsiValue > 95,
          lastCheck: new Date().toISOString(),
          inPosition: status.position.inPosition,
          currentBalance: status.currentBalance
        }
      };

      res.json({ success: true, debug: debugInfo });
    } catch (error) {
      console.error('Error getting debug info:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  // Active trades
  router.get('/active-trades', async (req, res) => {
    try {
      const activeTrades = await tradingService.getAllLiveTrades();
      res.json({ success: true, activeTrades });
    } catch (error) {
      console.error('Error getting active trades:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  // Historical data endpoint ekleyelim
  router.get('/historical-data', async (req, res) => {
    try {
      const { symbol, interval, startTime, endTime, limit } = req.query;

      if (!symbol || !interval || !startTime || !endTime) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters'
        });
      }

      const data = await getHistoricalData(
        symbol as string,
        interval as string,
        parseInt(startTime as string),
        parseInt(endTime as string),
        limit ? parseInt(limit as string) : undefined
      );

      res.json({
        success: true,
        data: {
          symbol,
          interval,
          startTime,
          endTime,
          candles: data
        }
      });
    } catch (error) {
      console.error('Error fetching historical data:', error);
      res.status(500).json({
        success: false,
        error: handleError(error)
      });
    }
  });

  // Test RSI calculation
  router.get('/test-rsi/:symbol', async (req, res) => {
    try {
      const { symbol } = req.params;
      const endTime = Date.now();
      const startTime = endTime - 100 * 60 * 1000; // Son 100 dakika

      const historicalData = await getHistoricalData(
        symbol,
        '1m',
        startTime,
        endTime
      );

      const rsi = TechnicalIndicators.calculateRSI(historicalData, 14);

      res.json({
        success: true,
        data: {
          symbol,
          period: 14,
          totalCandles: historicalData.length,
          rsiValues: rsi,
          lastPrice: historicalData[historicalData.length - 1].close,
          firstPrice: historicalData[0].close,
          priceChange: (
            ((historicalData[historicalData.length - 1].close -
              historicalData[0].close) /
              historicalData[0].close) *
            100
          ).toFixed(2)
        }
      });
    } catch (error) {
      console.error('Error testing RSI:', error);
      res.status(500).json({
        success: false,
        error: handleError(error)
      });
    }
  });

  // Test indicators
  router.get('/test-indicators/:symbol', async (req, res) => {
    try {
      const { symbol } = req.params;
      const { interval = '1h', limit = '100' } = req.query;
      const endTime = Date.now();
      const startTime =
        endTime -
        parseInt(limit as string) * getIntervalInMs(interval as string);

      const historicalData = await getHistoricalData(
        symbol,
        interval as string,
        startTime,
        endTime
      );

      const rsi = TechnicalIndicators.calculateRSI(historicalData, 14);
      const macd = TechnicalIndicators.calculateMACD(historicalData, 12, 26, 9);
      const bb = TechnicalIndicators.calculateBollingerBands(
        historicalData,
        20,
        2
      );
      const sma = TechnicalIndicators.calculateSMA(historicalData, 20);
      const ema = TechnicalIndicators.calculateEMA(historicalData, 20);

      res.json({
        success: true,
        data: {
          symbol,
          totalCandles: historicalData.length,
          indicators: {
            rsi: {
              first: rsi.slice(0, 5),
              last: rsi.slice(-5)
            },
            macd: {
              first: macd.slice(0, 5),
              last: macd.slice(-5)
            },
            bollingerBands: {
              first: {
                upper: bb.upper.slice(0, 5),
                middle: bb.middle.slice(0, 5),
                lower: bb.lower.slice(0, 5)
              },
              last: {
                upper: bb.upper.slice(-5),
                middle: bb.middle.slice(-5),
                lower: bb.lower.slice(-5)
              }
            },
            sma: {
              first: sma.slice(0, 5),
              last: sma.slice(-5)
            },
            ema: {
              first: ema.slice(0, 5),
              last: ema.slice(-5)
            }
          },
          priceData: {
            first: historicalData.slice(0, 5),
            last: historicalData.slice(-5)
          }
        }
      });
    } catch (error) {
      console.error('Error testing indicators:', error);
      res.status(500).json({
        success: false,
        error: handleError(error)
      });
    }
  });

  // Live Trading endpoints içine yeni endpoint ekleyelim
  router.put('/live-trading/:tradeId/strategy', async (req, res) => {
    try {
      const { newStrategyId } = req.body;
      const tradeId = req.params.tradeId;

      if (!newStrategyId) {
        return res.status(400).json({
          success: false,
          error: 'New strategy ID is required'
        });
      }

      // Önce yeni stratejinin var olduğunu kontrol edelim
      const newStrategy = await strategyManager.getStrategy(newStrategyId);
      if (!newStrategy) {
        return res.status(404).json({
          success: false,
          error: 'New strategy not found'
        });
      }

      // Trade'in aktif olduğunu kontrol edelim
      const currentStatus = tradingService.getLiveTradingStatus(tradeId);
      if (!currentStatus) {
        return res.status(404).json({
          success: false,
          error: 'Trade not found or not active'
        });
      }

      // Trading service'e strateji güncelleme methodu ekleyelim ve çağıralım
      await tradingService.updateTradeStrategy(tradeId, newStrategyId);

      // WebSocket clients'ları bilgilendirelim
      const subscribers = tradeSubscriptions.get(tradeId);
      if (subscribers) {
        subscribers.forEach((client) => {
          if (client.readyState === client.OPEN) {
            client.send(
              JSON.stringify({
                type: 'strategy_updated',
                message: 'Trade strategy has been updated',
                newStrategyId
              })
            );
          }
        });
      }

      res.json({
        success: true,
        message: 'Trade strategy updated successfully',
        tradeId,
        newStrategyId
      });
    } catch (error) {
      console.error('Error updating trade strategy:', error);
      res.status(500).json({ success: false, error: handleError(error) });
    }
  });

  return router;
}
