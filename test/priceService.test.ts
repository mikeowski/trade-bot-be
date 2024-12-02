import { getLivePrice, getHistoricalData } from '../src/services/priceService';

test('Get live price', async () => {
  const price = await getLivePrice('BTCUSDT');
  expect(price).toHaveProperty('price');
});

test('Get historical data', async () => {
  const data = await getHistoricalData(
    'BTCUSDT',
    '1h',
    1672531200000,
    1672538400000
  );
  expect(data).toBeInstanceOf(Array);
  expect(data[0]).toHaveProperty('open');
});
