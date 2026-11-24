import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStore, parseCookieHeader } from '../server/authStore.ts';
import type { UserWorkspaceState } from '../shared/types.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap-auth-test-'));
}

describe('AccountStore', () => {
  it('registers a user, saves workspace state, and preserves session & state across store restarts', () => {
    const dir = makeTempDir();
    try {
      const store1 = new AccountStore(dir);
      const initialState: UserWorkspaceState = {
        activePage: 'chart',
        exchange: 'combined',
        timeframe: '1d',
        colormap: 'bookmap',
        chartSettings: {
          chartStyle: 'candles',
          scaleMode: 'log',
          autoScaleY: true,
          indicators: {
            ma50: true,
            ma100: true,
            ma200: true,
            ema9: false,
            ema21: false,
            ema50: false,
            ema200: false,
            vwap: false,
            bb: false,
            volume: true,
            rsi: false,
            macd: false,
            priceLine: true,
          },
          drawColor: '#f59e0b',
          drawWidth: 2,
          drawDashed: false,
          magnetMode: true,
          hideDrawings: false,
        },
        drawingsByExchange: {
          combined: [
            {
              id: 'd1',
              type: 'hline',
              points: [{ time: 1700000000000, price: 95000 }],
              color: '#f59e0b',
              lineWidth: 2,
            },
          ],
        },
      };

      const reg = store1.register('TraderOne', 'secret123', initialState);
      assert.equal(reg.ok, true);
      if (!reg.ok) return;
      assert.equal(reg.user.username, 'TraderOne');
      assert.equal(reg.state.activePage, 'chart');
      assert.equal(reg.state.chartSettings?.indicators.ma200, true);

      // Update state and flush synchronously (simulating graceful server shutdown)
      const saveRes = store1.saveUserState(reg.token, {
        priceStep: 50,
        whaleAlertBtc: 25,
      });
      assert.equal(saveRes.ok, true);
      store1.flushSync();

      // Simulate server restart with a brand new AccountStore reading the same disk directory
      const store2 = new AccountStore(dir);
      const restored = store2.getSessionUser(reg.token);
      assert.ok(restored);
      assert.equal(restored.user.username, 'TraderOne');
      assert.equal(restored.state.activePage, 'chart');
      assert.equal(restored.state.exchange, 'combined');
      assert.equal(restored.state.timeframe, '1d');
      assert.equal(restored.state.priceStep, 50);
      assert.equal(restored.state.whaleAlertBtc, 25);
      assert.equal(restored.state.chartSettings?.indicators.ma50, true);
      assert.equal(restored.state.drawingsByExchange?.combined?.length, 1);

      // Logout revokes session on disk too
      store2.logout(reg.token);
      const store3 = new AccountStore(dir);
      assert.equal(store3.getSessionUser(reg.token), null);

      // Wrong password fails; right password (case-insensitive username) logs back in with saved state
      const badLogin = store3.login('traderone', 'wrongpass');
      assert.equal(badLogin.ok, false);

      const goodLogin = store3.login('traderone', 'secret123');
      assert.equal(goodLogin.ok, true);
      if (!goodLogin.ok) return;
      assert.equal(goodLogin.user.username, 'TraderOne');
      assert.equal(goodLogin.state.whaleAlertBtc, 25);
      assert.equal(goodLogin.state.drawingsByExchange?.combined?.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid credentials and duplicate usernames', () => {
    const dir = makeTempDir();
    try {
      const store = new AccountStore(dir);
      assert.equal(store.register('ab', '123456').ok, false);
      assert.equal(store.register('valid_user', '123').ok, false);
      assert.equal(store.register('valid_user', 'password123').ok, true);
      assert.equal(store.register('VALID_USER', 'anotherpass').ok, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses cookies safely including malformed percent encodings', () => {
    const parsed = parseCookieHeader('foo=bar; heatmap_sid=abc123; broken=%E0%A4%A');
    assert.equal(parsed.foo, 'bar');
    assert.equal(parsed.heatmap_sid, 'abc123');
    assert.equal(parsed.broken, '%E0%A4%A');
  });
});
