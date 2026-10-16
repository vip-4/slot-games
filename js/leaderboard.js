/*!
 * leaderboard.js —— 社区最高倍率排行榜（CloudBase PostgreSQL）
 *
 * 设计约束：
 * - 零构建：用动态 import() 从 CDN 懒加载 @cloudbase/js-sdk，首屏不受影响，失败即降级；
 * - 只读优先：RLS 放行 anon SELECT；写入被 WITH CHECK 限制在 0~5000×、昵称 1~16 字符；
 * - 写入节流：≥10× 才提交、间隔 ≥20s、每会话 ≤5 次（RLS 无法限频，只能由前端收敛）；
 * - 失败静默：任何异常都保留构建期静态注入的榜单，不弹错、不空白；
 * - ACCESS_KEY 是面向浏览器的匿名 PublishableKey（无法用于管理接口），
 *   真正的写入边界由数据库 RLS 保证，而不是靠隐藏这个密钥。
 */
(function () {
  'use strict';

  var ENV_ID = 'vip8-d4gy9ns0x898ab5b1';
  var REGION = 'ap-shanghai';
  var ACCESS_KEY =
    'eyJhbGciOiJSUzI1NiIsImtpZCI6IjQ1MDgxNzgwLWY5ZDktNGQwOS1iODIxLTg0ZWUyMzMzMjU3NCJ9.eyJpc3MiOiJodHRwczovL3ZpcDgtZDRneTluczB4ODk4YWI1YjEuYXAtc2hhbmdoYWkudGNiLWFwaS50ZW5jZW50Y2xvdWRhcGkuY29tIiwic3ViIjoiYW5vbiIsImF1ZCI6InZpcDgtZDRneTluczB4ODk4YWI1YjEiLCJleHAiOjQwOTU4Njk2NzIsImlhdCI6MTc5MjE4NjQ3Miwibm9uY2UiOiJsV1A1TEdWOFJVMm1ubjZ1endTRDlnIiwiYXRfaGFzaCI6ImxXUDVMR1Y4UlUybW5uNnV6d1NEOWciLCJuYW1lIjoiQW5vbnltb3VzIiwic2NvcGUiOiJhbm9ueW1vdXMiLCJwcm9qZWN0X2lkIjoidmlwOC1kNGd5OW5zMHg4OThhYjViMSIsIm1ldGEiOnsicGxhdGZvcm0iOiJQdWJsaXNoYWJsZUtleSJ9LCJyb2xlIjoiYW5vbiIsImlzX2Fub255bW91cyI6dHJ1ZSwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiYW5vbnltb3VzIiwicHJvdmlkZXJzIjpbImFub255bW91cyJdfSwidXNlcl9tZXRhZGF0YSI6eyJuYW1lIjoiQW5vbnltb3VzIn0sInVzZXJfdHlwZSI6IiIsImNsaWVudF90eXBlIjoiY2xpZW50X3VzZXIiLCJpc19zeXN0ZW1fYWRtaW4iOmZhbHNlfQ.GxqKGJI_p6bYyqSZQm76Rofm5GILfAgwUWX7bOPJ8PzYKKfEtbssymGYyefD5fEjbMLMk37QVf2i9_iEdQ76RrncZ9j70fjzWgkBp_ZChhxtWNm2eLLiC5Wae7AjWBa155NIGWAtsPEgNVxQRuibpnWJQgH89qw6IOyOnRZ9UMV9eI3t8LkNLZJ_DPkXA46N8mG9lcXStQSk2U5sccEEQinZiEpHkUZ4ur5AboxeIzfng3qb-mY7VS5W5I0typraVjF02TuyNAaoc-H79JeNAtszF2foRZ1IT4c6VDbIT2TTpUWJtKIcXErhdQK-QoPszMLkzDD0LlZr9S6Q2vwulw';
  var TABLE = 'slot_scores';
  var SDK_ESM = 'https://esm.sh/@cloudbase/js-sdk@3.10.2';
  var SDK_ESM_FALLBACK = 'https://cdn.jsdelivr.net/npm/@cloudbase/js-sdk@3.10.2/dist/index.esm.js';

  var MIN_MULTIPLIER = 10; // 低于此倍率不提交，抑制写入量
  var MIN_INTERVAL_MS = 20000; // 两次提交最小间隔
  var MAX_PER_SESSION = 5; // 单会话最多提交次数（刷新页面重置）
  var NAME_KEY = 'slot-player-name';
  var MAX_MULTIPLIER = 5000; // 与 RLS 的 WITH CHECK 上限保持一致

  var appPromise = null;
  var lastSubmitAt = 0;
  var submitCount = 0;

  function loadModule() {
    return import(SDK_ESM).catch(function () {
      return import(SDK_ESM_FALLBACK);
    });
  }

  function getApp() {
    if (appPromise) return appPromise;
    appPromise = loadModule()
      .then(function (mod) {
        var cloudbase = mod.cloudbase || mod.default || mod;
        var app = cloudbase.init({ env: ENV_ID, region: REGION, accessKey: ACCESS_KEY });
        // 匿名登录失败不阻断：RLS 已放行 anon SELECT，登录态只影响审计字段
        try {
          var auth = app.auth({ persistence: 'local' });
          if (auth && typeof auth.signInAnonymously === 'function') {
            return auth
              .signInAnonymously()
              .catch(function () {
                return null;
              })
              .then(function () {
                return app;
              });
          }
        } catch (e) {
          /* 某些版本没有 auth 模块，忽略 */
        }
        return app;
      })
      .catch(function (err) {
        appPromise = null; // 允许下一次重试
        throw err;
      });
    return appPromise;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function playerName() {
    try {
      var saved = localStorage.getItem(NAME_KEY);
      if (saved) return saved.slice(0, 16);
    } catch (e) {
      /* 隐私模式下 localStorage 不可用 */
    }
    return '匿名玩家';
  }

  function setStatus(text) {
    var box = document.getElementById('community-status');
    if (box) box.textContent = text;
  }

  function bindNameInput() {
    var input = document.getElementById('player-name');
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    input.value = playerName() === '匿名玩家' ? '' : playerName();
    input.addEventListener('change', function () {
      var v = (input.value || '').trim().slice(0, 16);
      try {
        if (v) localStorage.setItem(NAME_KEY, v);
        else localStorage.removeItem(NAME_KEY);
      } catch (e) {
        /* ignore */
      }
    });
  }

  /** 读取榜单：gameId 为空时读全站 TopN。失败返回 null，由调用方保留静态快照。 */
  function top(gameId, limit) {
    return getApp()
      .then(function (app) {
        var q = app.rdb().from(TABLE).select('game_id, game_name, player, best_multiplier');
        if (gameId) q = q.eq('game_id', gameId);
        return q.order('best_multiplier', { ascending: false }).limit(limit || 10);
      })
      .then(function (res) {
        if (res && res.error) throw new Error(res.error.message || '查询失败');
        return (res && res.data) || [];
      });
  }

  /** 按需提交成绩。未达阈值 / 被节流 / 失败都返回 false，绝不抛错。 */
  function maybeSubmit(entry) {
    var mult = Number(entry && entry.multiplier) || 0;
    var now = Date.now();
    if (mult < MIN_MULTIPLIER) return Promise.resolve(false);
    if (now - lastSubmitAt < MIN_INTERVAL_MS) return Promise.resolve(false);
    if (submitCount >= MAX_PER_SESSION) return Promise.resolve(false);

    lastSubmitAt = now;
    submitCount += 1;

    return getApp()
      .then(function (app) {
        return app.rdb().from(TABLE).insert([
          {
            game_id: String((entry && entry.gameId) || '').slice(0, 40),
            game_name: String((entry && entry.gameName) || '').slice(0, 40),
            player: playerName().slice(0, 16),
            best_multiplier: Math.min(Math.round(mult * 100) / 100, MAX_MULTIPLIER),
            bet: Number((entry && entry.bet) || 0),
          },
        ]);
      })
      .then(function (res) {
        if (res && res.error) throw new Error(res.error.message || '写入失败');
        return true;
      })
      .catch(function () {
        return false;
      });
  }

  /** 渲染榜单到 <ol id="elId">；元素不存在或读取失败时静默保留静态内容。 */
  function mount(elId, gameId) {
    var ol = document.getElementById(elId);
    if (!ol) return Promise.resolve(false);
    bindNameInput();
    setStatus('正在读取社区榜单…');
    return top(gameId, 10)
      .then(function (rows) {
        if (!rows.length) {
          setStatus('暂无社区成绩，打出 10× 以上即可上榜。');
          return false;
        }
        ol.innerHTML = rows
          .map(function (r) {
            var who = esc(r.player || '匿名玩家');
            var game = esc(r.game_name || r.game_id || '');
            var mult = Number(r.best_multiplier || 0).toFixed(1);
            return '<li>' + who + ' · ' + game + ' · ' + mult + 'x</li>';
          })
          .join('');
        setStatus('实时榜单（匿名只读，数据存于 CloudBase）');
        return true;
      })
      .catch(function () {
        setStatus('社区榜单暂不可用（已保留构建期快照）。');
        return false;
      });
  }

  window.SlotLeaderboard = {
    top: top,
    mount: mount,
    maybeSubmit: maybeSubmit,
    thresholds: { minMultiplier: MIN_MULTIPLIER, maxMultiplier: MAX_MULTIPLIER },
  };
})();
