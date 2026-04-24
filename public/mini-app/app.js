/* AlgoTrade Pro — Enterprise Mini App v2.0 */
(function () {
    'use strict';

    // ── Telegram WebApp SDK ───────────────────────────────────────────────────
    const tg = window.Telegram?.WebApp;
    if (tg) {
        tg.ready();
        tg.expand();
        try { tg.setHeaderColor('#060A12'); } catch {}
        try { tg.setBackgroundColor('#060A12'); } catch {}
    }
    const initData = tg?.initData || '';

    function haptic(style) {
        try { tg?.HapticFeedback?.impactOccurred(style || 'light'); } catch {}
    }
    function hapticNotify(type) {
        try { tg?.HapticFeedback?.notificationOccurred(type || 'success'); } catch {}
    }

    // ── API ───────────────────────────────────────────────────────────────────
    // API_BASE is injected by config.js (loaded before this script in index.html).
    // Falls back to same-origin when config is missing (e.g. local dev).
    const API_BASE = (window.__APP_CONFIG__ && window.__APP_CONFIG__.API_BASE) || '';

    async function api(method, path, body) {
        const opts = {
            method,
            cache: 'no-store', // never reuse cached responses — live trading data must be fresh
            headers: {
                'Authorization': `tma ${initData}`,
                'Content-Type': 'application/json',
                // Bypass ngrok free-tier interstitial warning page for browser fetches.
                'ngrok-skip-browser-warning': 'true'
            }
        };
        if (body !== undefined) opts.body = JSON.stringify(body);
        const res = await fetch(`${API_BASE}/api/users${path}`, opts);
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    // ── Toast ─────────────────────────────────────────────────────────────────
    const TOAST_ICONS = {
        ok: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        err: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
        info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`
    };

    function toast(msg, type, duration) {
        type = type || 'info';
        duration = duration || 3500;
        const container = document.getElementById('toast-container');
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        // Icon SVG is a safe constant; message is untrusted (error strings from
        // server/network) — inject icon via innerHTML, message via textContent
        // to prevent XSS if an error payload ever contains HTML/script.
        const iconSpan = document.createElement('span');
        iconSpan.className = 'toast-icon';
        iconSpan.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
        const msgSpan = document.createElement('span');
        msgSpan.textContent = msg == null ? '' : String(msg);
        el.appendChild(iconSpan);
        el.appendChild(msgSpan);
        container.appendChild(el);

        const dismiss = function () {
            if (!el.parentNode) return;
            el.classList.add('toast-out');
            setTimeout(function () { if (el.parentNode) el.remove(); }, 250);
        };
        const timer = setTimeout(dismiss, duration);
        el.addEventListener('click', function () { clearTimeout(timer); dismiss(); });
    }

    // ── Confirm dialog ────────────────────────────────────────────────────────
    function showConfirm(msg) {
        return new Promise(function (resolve) {
            if (tg && tg.showConfirm) {
                tg.showConfirm(msg, function (ok) { resolve(ok); });
            } else {
                resolve(window.confirm(msg));
            }
        });
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let _paused = false;
    let _timer  = null;
    let _prevBal = null;
    let _skeletonCleared = false;
    let _hasKeys = false;
    let _lastProfile = null;
    // Stats cache — populated from /me/status on each refresh(); the active
    // period is chosen via the .period-btn group.
    let _statsToday   = { totalTrades: 0, winRate: 0, totalPnl: 0 };
    let _stats7d      = { totalTrades: 0, winRate: 0, totalPnl: 0 };
    let _stats30d     = { totalTrades: 0, winRate: 0, totalPnl: 0 };
    let _statsAllTime = { totalTrades: 0, winRate: 0, totalPnl: 0 };
    let _statsPeriod  = 'today';

    function _statsFor(period) {
        if (period === '7d')  return _stats7d;
        if (period === '30d') return _stats30d;
        if (period === 'all') return _statsAllTime;
        return _statsToday;
    }
    function _periodLabel(period) {
        if (period === '7d')  return 'за 7 дней';
        if (period === '30d') return 'за месяц';
        if (period === 'all') return 'за всё время';
        return 'сегодня';
    }

    // Render all three stat tiles for the currently selected period.
    function renderStats() {
        var s = _statsFor(_statsPeriod);
        // Diagnostic: confirm each period bucket actually has data.
        try {
            console.log('[stats] period=' + _statsPeriod,
                'today=', _statsToday.totalTrades, '/', _statsToday.totalPnl,
                '7d=',    _stats7d.totalTrades,    '/', _stats7d.totalPnl,
                '30d=',   _stats30d.totalTrades,   '/', _stats30d.totalPnl,
                'all=',   _statsAllTime.totalTrades,'/', _statsAllTime.totalPnl);
        } catch (e) {}
        var pnl = Number(s.totalPnl || 0);

        var tradesEl  = document.getElementById('stat-trades');
        var winEl     = document.getElementById('stat-winrate');
        var pnlEl     = document.getElementById('stat-pnl');
        var pnlLabel  = document.getElementById('stat-pnl-label');
        var tradesSub = document.getElementById('stat-trades-sub');
        var winSub    = document.getElementById('stat-winrate-sub');
        var pnlSub    = document.getElementById('stat-pnl-sub');

        if (tradesEl) tradesEl.textContent = s.totalTrades || 0;
        if (winEl)    winEl.textContent    = Math.round(s.winRate || 0) + '%';
        if (pnlEl) {
            pnlEl.textContent = (pnl >= 0 ? '+' : '−') + '$' + Math.abs(pnl).toFixed(2);
            pnlEl.className   = 'stat-val ' + (pnl >= 0 ? 'pnl-positive' : 'pnl-negative');
        }
        if (pnlLabel) pnlLabel.textContent = 'P&L ' + _periodLabel(_statsPeriod);

        // Subtext: win/loss split and all-time comparison.
        if (tradesSub) {
            var wins = s.winTrades || 0, losses = s.lossTrades || 0;
            tradesSub.textContent = (wins || losses)
                ? (wins + ' / ' + losses + ' W/L')
                : '';
        }
        if (winSub) {
            winSub.textContent = (s.totalTrades || 0) > 0
                ? ((s.winTrades || 0) + ' из ' + s.totalTrades)
                : '';
        }
        if (pnlSub) {
            var all = _statsAllTime;
            var allPnl = Number(all.totalPnl || 0);
            pnlSub.textContent = (_statsPeriod !== 'all' && (all.totalTrades || 0) > 0)
                ? ('всего: ' + (allPnl >= 0 ? '+' : '−') + '$' + Math.abs(allPnl).toFixed(2))
                : '';
        }

        // Sync active button state.
        var btns = document.querySelectorAll('.period-btn');
        for (var i = 0; i < btns.length; i++) {
            var on = btns[i].getAttribute('data-period') === _statsPeriod;
            btns[i].classList.toggle('is-active', on);
            btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
        }
    }

    // Attach period-switcher clicks once (DOM is ready by the time app.js runs).
    document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('.period-btn');
        if (!btn) return;
        var p = btn.getAttribute('data-period');
        if (!p || p === _statsPeriod) return;
        _statsPeriod = p;
        renderStats();
    });

    // Render the Onboarding/API screen in the correct state — either the registration
    // form (no keys yet) or the "connected" card with balance + disconnect button.
    function renderOnboardingState(connected, profile, balance, positionsCount, paused) {
        var form = document.getElementById('form-register');
        var connBlock = document.getElementById('onboarding-connected');
        var infoCard = document.querySelector('#screen-onboarding .info-card');
        var header = document.querySelector('#screen-onboarding .screen-header');

        if (connected) {
            if (form) form.style.display = 'none';
            if (infoCard) infoCard.style.display = 'none';
            if (connBlock) { connBlock.style.display = ''; connBlock.classList.remove('hidden'); }
            if (header) {
                var title = header.querySelector('.screen-title');
                var sub = header.querySelector('.screen-sub');
                if (title) title.textContent = 'API подключён';
                if (sub) sub.textContent = 'Ваш WEEX аккаунт привязан и торговый движок активен';
            }
            var uEl = document.getElementById('connected-username');
            if (uEl && profile) uEl.textContent = profile.username ? '@' + profile.username : ('ID ' + (profile.userId || ''));
            var bEl = document.getElementById('connected-balance');
            if (bEl) {
                bEl.textContent = (balance != null && Number.isFinite(Number(balance)))
                    ? Number(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDT'
                    : '— USDT';
            }
            var pEl = document.getElementById('connected-positions');
            if (pEl) pEl.textContent = positionsCount != null ? String(positionsCount) : '0';
            var sEl = document.getElementById('connected-status');
            if (sEl) {
                sEl.textContent = paused ? 'Пауза' : 'Активен';
                sEl.style.color = paused ? '#FFB547' : '#00D97E';
            }
        } else {
            if (form) form.style.display = '';
            if (infoCard) infoCard.style.display = '';
            if (connBlock) { connBlock.style.display = 'none'; connBlock.classList.add('hidden'); }
            if (header) {
                var title2 = header.querySelector('.screen-title');
                var sub2 = header.querySelector('.screen-sub');
                if (title2) title2.textContent = 'Подключение';
                if (sub2) sub2.textContent = 'Введите API ключи для активации торгового движка';
            }
        }
    }

    // ── Screen routing ────────────────────────────────────────────────────────
    function showScreen(name) {
        document.querySelectorAll('.screen').forEach(function (s) {
            var active = s.id === 'screen-' + name;
            if (active) {
                s.classList.remove('hidden');
                s.classList.remove('screen-enter');
                void s.offsetWidth; // force reflow to restart animation
                s.classList.add('screen-enter');
            } else {
                s.classList.add('hidden');
            }
        });
        document.querySelectorAll('.nav-btn').forEach(function (b) {
            b.classList.toggle('active', b.dataset.screen === name);
        });
        if (name === 'dashboard') {
            startRefresh();
        } else {
            stopRefresh();
            // On the API screen the "connected" card shows balance + position
            // count — trigger one immediate refresh so the user doesn't stare
            // at stale numbers (or skeletons) while waiting for the next
            // dashboard visit.
            if (name === 'api' && _hasKeys) {
                refresh().catch(function () { /* surfaced inside refresh */ });
            }
        }
    }

    // ── Slider fill ───────────────────────────────────────────────────────────
    function updateSliderFill(sl) {
        var pct = ((+sl.value - +sl.min) / (+sl.max - +sl.min)) * 100;
        sl.style.setProperty('--val', pct + '%');
    }

    var SLIDERS = [
        ['sl-loss', 'val-loss', function (v) { return v + '%'; }],
        ['sl-pos',  'val-pos',  function (v) { return v; }],
        ['sl-lev',  'val-lev',  function (v) { return v + '×'; }],
        ['sl-size', 'val-size', function (v) { return v + '%'; }]
    ];

    SLIDERS.forEach(function (def) {
        var sl = document.getElementById(def[0]);
        var vl = document.getElementById(def[1]);
        var fmt = def[2];
        if (!sl || !vl) return;
        updateSliderFill(sl);
        sl.addEventListener('input', function () {
            vl.textContent = fmt(sl.value);
            updateSliderFill(sl);
            haptic('light');
        });
    });

    // ── Eye toggle ────────────────────────────────────────────────────────────
    function toggleEye(btn, inputId) {
        var inp = document.getElementById(inputId);
        var isPass = inp.type === 'password';
        inp.type = isPass ? 'text' : 'password';
        btn.querySelector('.eye-open').classList.toggle('hidden', isPass);
        btn.querySelector('.eye-closed').classList.toggle('hidden', !isPass);
    }

    // ── Onboarding ────────────────────────────────────────────────────────────
    document.getElementById('form-register').addEventListener('submit', async function (e) {
        e.preventDefault();
        haptic('medium');

        var btn     = document.getElementById('btn-register');
        var btnText = btn.querySelector('.btn-text');
        var btnArrow = document.getElementById('register-arrow');
        var spinner = document.getElementById('register-spinner');

        var apiKey     = document.getElementById('inp-apikey').value.trim();
        var secretKey  = document.getElementById('inp-secret').value.trim();
        var passphrase = document.getElementById('inp-pass').value.trim();

        if (!apiKey || !secretKey || !passphrase) {
            hapticNotify('error');
            toast('Заполните все три поля', 'err');
            return;
        }

        btn.disabled = true;
        btnText.classList.add('hidden');
        btnArrow.classList.add('hidden');
        spinner.classList.remove('hidden');
        toast('Проверяем API ключи...', 'info', 10000);

        try {
            var data = await api('POST', '/register', { apiKey, secretKey, passphrase });
            if (data.success) {
                hapticNotify('success');
                toast('Подключено! Баланс: $' + Number(data.balance).toFixed(2), 'ok', 4000);
                document.getElementById('inp-apikey').value = '';
                document.getElementById('inp-secret').value = '';
                document.getElementById('inp-pass').value   = '';

                // Pre-fill dashboard with balance from register response so user
                // immediately sees "connected" state without waiting for refresh().
                var balEl = document.getElementById('balance-value');
                if (balEl) {
                    balEl.textContent = Number(data.balance).toLocaleString('en-US', {
                        minimumFractionDigits: 2, maximumFractionDigits: 2
                    });
                    _prevBal = Number(data.balance);
                }
                // Clear all skeletons so dashboard looks live immediately.
                _skeletonCleared = true;
                document.querySelectorAll('.skel-line, .skel-card').forEach(function (s) { s.remove(); });
                setEl('stat-trades', 0);
                setEl('stat-winrate', '0%');
                var pnlEl = document.getElementById('stat-pnl');
                if (pnlEl) { pnlEl.textContent = '+$0.00'; pnlEl.className = 'stat-val pnl-positive'; }

                _hasKeys = true;
                _lastProfile = { userId: (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || null,
                                 username: (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.username) || null };
                // Swap the API screen to the connected card right away so user sees confirmation.
                renderOnboardingState(true, _lastProfile, Number(data.balance), 0, false);
                setTimeout(function () { showScreen('dashboard'); }, 800);
            } else {
                hapticNotify('error');
                toast(data.error || 'Ошибка подключения', 'err');
            }
        } catch (err) {
            hapticNotify('error');
            toast(err.message || 'Ошибка сети', 'err');
        } finally {
            btn.disabled = false;
            btnText.classList.remove('hidden');
            btnArrow.classList.remove('hidden');
            spinner.classList.add('hidden');
        }
    });

    // ── Load settings ─────────────────────────────────────────────────────────
    async function loadSettings() {
        try {
            var data = await api('GET', '/me');
            if (!data.success) return;
            var r = data.user.risk;

            function setSlider(id, val, valId, fmt) {
                var sl = document.getElementById(id);
                var vl = document.getElementById(valId);
                if (!sl || !vl) return;
                sl.value = val;
                updateSliderFill(sl);
                vl.textContent = fmt(val);
            }

            setSlider('sl-loss', r.maxDailyLossPct, 'val-loss', function (v) { return v + '%'; });
            setSlider('sl-pos',  r.maxPositions,    'val-pos',  function (v) { return v; });
            setSlider('sl-lev',  r.leverage,         'val-lev',  function (v) { return v + '×'; });
            setSlider('sl-size', r.positionSizePct,  'val-size', function (v) { return v + '%'; });

            var active = data.user.symbols || [];
            document.querySelectorAll('#symbols-grid input[type=checkbox]').forEach(function (cb) {
                cb.checked = active.includes(cb.value);
            });
        } catch (e) { /* not registered yet */ }
    }

    // ── Save settings ─────────────────────────────────────────────────────────
    document.getElementById('btn-save-settings').addEventListener('click', async function () {
        haptic('medium');
        var btn = document.getElementById('btn-save-settings');
        var btnText = btn.querySelector('.btn-text');
        btn.disabled = true;
        btnText.textContent = 'Сохраняем...';

        try {
            var symbols = Array.from(document.querySelectorAll('#symbols-grid input:checked')).map(function (c) { return c.value; });
            if (symbols.length === 0) {
                toast('Выберите хотя бы один символ', 'err');
                return;
            }

            var results = await Promise.all([
                api('PUT', '/me/risk', {
                    maxDailyLossPct: +document.getElementById('sl-loss').value,
                    maxPositions:    +document.getElementById('sl-pos').value,
                    leverage:        +document.getElementById('sl-lev').value,
                    positionSizePct: +document.getElementById('sl-size').value
                }),
                api('PUT', '/me/symbols', { symbols: symbols })
            ]);

            if (results[0].success && results[1].success) {
                hapticNotify('success');
                toast('Настройки сохранены', 'ok');
                // Refresh settings screen from server so sliders reflect the
                // canonical (validated/clamped) values, not the stale inputs.
                try { await loadSettings(); } catch (_) { /* non-fatal */ }
            } else {
                throw new Error(results[0].error || results[1].error || 'Ошибка');
            }
        } catch (err) {
            hapticNotify('error');
            toast(err.message || 'Ошибка сохранения', 'err');
        } finally {
            btn.disabled = false;
            btnText.textContent = 'Сохранить настройки';
        }
    });

    // ── Delete account ────────────────────────────────────────────────────────
    document.getElementById('btn-delete-account').addEventListener('click', async function () {
        haptic('heavy');
        var confirmed = await showConfirm('Отключить аккаунт? API ключи будут удалены.');
        if (!confirmed) return;

        try {
            await api('DELETE', '/me');
            hapticNotify('warning');
            toast('Аккаунт отключён', 'info');
            setTimeout(function () { showScreen('onboarding'); }, 1000);
        } catch (err) {
            toast(err.message || 'Ошибка', 'err');
        }
    });

    // ── Sparkline ─────────────────────────────────────────────────────────────
    function drawSparkline(svgEl, points, isPositive) {
        if (!svgEl || !points || points.length < 2) return;
        var w = svgEl.clientWidth || 300;
        var h = 40;
        var min = Math.min.apply(null, points);
        var max = Math.max.apply(null, points);
        var range = max - min || 1;

        var xs = points.map(function (_, i) { return (i / (points.length - 1)) * w; });
        var ys = points.map(function (v) { return h - ((v - min) / range) * (h - 6) - 3; });

        var path = xs.map(function (x, i) { return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + ys[i].toFixed(1); }).join(' ');
        var area = path + ' L' + w + ',' + h + ' L0,' + h + ' Z';
        var color = isPositive ? '#00D97E' : '#FF4D6B';

        svgEl.innerHTML =
            '<defs>' +
            '<linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.32"/>' +
            '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
            '</linearGradient></defs>' +
            '<path d="' + area + '" fill="url(#sg)"/>' +
            '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    }

    // ── Balance counter animation ─────────────────────────────────────────────
    function animateBalance(el, from, to) {
        var start = performance.now();
        var duration = 550;
        function tick(now) {
            var t = Math.min((now - start) / duration, 1);
            var eased = 1 - Math.pow(1 - t, 3);
            el.textContent = (from + (to - from) * eased).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            if (t < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }

    // ── Dashboard refresh ─────────────────────────────────────────────────────
    async function refresh() {
        var dot = document.getElementById('refresh-dot');
        if (dot) { dot.classList.add('active'); setTimeout(function () { dot.classList.remove('active'); }, 700); }

        try {
            var data = await api('GET', '/me/status');
            if (!data.success) return;

            // Clear skeleton on first load
            if (!_skeletonCleared) {
                _skeletonCleared = true;
                document.querySelectorAll('.skel-line, .skel-card').forEach(function (s) { s.remove(); });
            }

            // Balance
            var bal = data.balance != null ? Number(data.balance) : null;
            var balEl = document.getElementById('balance-value');
            if (balEl && bal != null) {
                if (_prevBal !== null && _prevBal !== bal) {
                    animateBalance(balEl, _prevBal, bal);
                } else {
                    balEl.textContent = bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                }
                _prevBal = bal;
            } else if (balEl) {
                balEl.textContent = '—';
            }

            // Stats — cache all four scopes, the active one is chosen by the period switch.
            _statsToday   = data.stats        || { totalTrades: 0, winRate: 0, totalPnl: 0 };
            _stats7d      = data.stats7d      || { totalTrades: 0, winRate: 0, totalPnl: 0 };
            _stats30d     = data.stats30d     || { totalTrades: 0, winRate: 0, totalPnl: 0 };
            _statsAllTime = data.allTimeStats || { totalTrades: 0, winRate: 0, totalPnl: 0 };
            renderStats();
            var pnl = Number((_statsPeriod === 'today' ? _statsToday : _statsAllTime).totalPnl || 0);

            // Sparkline
            if (bal != null) {
                var spk = document.getElementById('sparkline-svg');
                var variation = bal * 0.003;
                var pts = Array.from({ length: 20 }, function (_, i) {
                    return bal + (pnl * (i / 19)) + Math.sin(i * 1.4) * variation * (1 - i / 19);
                });
                drawSparkline(spk, pts, pnl >= 0);
            }

            // Badge & pause button
            var risk = data.risk || {};
            _paused = Boolean(risk.paused);
            var badge    = document.getElementById('trading-status-badge');
            var badgeLbl = document.getElementById('badge-label');
            var pauseLbl = document.getElementById('pause-label');
            var iconPause = document.getElementById('icon-pause');
            var iconPlay  = document.getElementById('icon-play');

            if (_paused) {
                badge.className   = 'status-badge badge-paused';
                badgeLbl.textContent = 'Пауза';
                iconPause.classList.add('hidden');
                iconPlay.classList.remove('hidden');
                pauseLbl.textContent = 'Возобновить';
            } else {
                badge.className   = 'status-badge badge-active';
                badgeLbl.textContent = 'Активен';
                iconPause.classList.remove('hidden');
                iconPlay.classList.add('hidden');
                pauseLbl.textContent = 'Пауза';
            }

            // Positions
            var positions = data.positions || [];
            setEl('pos-count', positions.length);
            renderPositions(positions);

            // Keep the "connected" card on the API screen in sync.
            if (_hasKeys) {
                renderOnboardingState(true, _lastProfile, bal, positions.length, _paused);
            }

        } catch (e) {
            // Surface the error so we can see why dashboard stays on skeletons.
            var balEl = document.getElementById('balance-value');
            if (balEl) balEl.textContent = 'ERR';
            toast('Refresh: ' + (e && e.message ? e.message : 'network'), 'err', 5000);
        }
    }

    function setEl(id, val) {
        var el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function fmt(v, d) {
        var n = Number(v);
        return Number.isFinite(n) ? n.toFixed(d != null ? d : 2) : '—';
    }

    // Escape HTML special chars — used when embedding server-supplied strings
    // (e.g. position symbol) into innerHTML templates. Prevents XSS if the
    // backend ever leaks untrusted data into those fields.
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderPositions(list) {
        var el = document.getElementById('positions-list');
        if (!list.length) {
            el.innerHTML =
                '<div class="empty-state">' +
                '<div class="empty-icon-box">' +
                '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>' +
                '</div>' +
                '<p class="empty-title">Нет открытых позиций</p>' +
                '<p class="empty-sub">Торговый движок ожидает сигнала</p>' +
                '</div>';
            return;
        }

        el.innerHTML = list.map(function (p) {
            var isLong  = p.side === 'long';
            var cls     = isLong ? 'pos-long' : 'pos-short';
            var dir     = isLong ? 'LONG' : 'SHORT';
            // Prefer unrealized PnL from exchange (live floating) over stored realized PnL.
            var hasUnreal = p.unrealizedPnl != null && Number.isFinite(Number(p.unrealizedPnl));
            var pnl     = hasUnreal ? Number(p.unrealizedPnl) : Number(p.realizedPnl || 0);
            var pnlCls  = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            var pnlSign = pnl >= 0 ? '+' : '−'; // always show sign for clarity
            var pnlStr  = pnlSign + '$' + Math.abs(pnl).toFixed(2);
            var lev     = p.leverage ? escapeHtml(p.leverage) + '×' : '';
            var sym     = escapeHtml(String(p.symbol || '').replace('USDT', ''));

            // Progress bar: how far the MARK price has travelled from SL
            // (0 %, red end) toward the furthest configured TP (100 %, green end).
            // WEEX doesn't return mark price directly, so derive it from
            // entry + unrealized PnL per unit: for LONG  mark ≈ entry + pnl/qty;
            //                                    for SHORT mark ≈ entry − pnl/qty.
            var progress = 50;
            var ticksHtml = '';
            var qty = Number(p.remainingQuantity);
            var markPrice = null;
            if (Number.isFinite(Number(p.unrealizedPnl)) && Number.isFinite(qty) && qty > 0 && Number.isFinite(p.entryPrice)) {
                markPrice = isLong
                    ? p.entryPrice + Number(p.unrealizedPnl) / qty
                    : p.entryPrice - Number(p.unrealizedPnl) / qty;
            }
            // Pick the furthest TP that's actually set so the bar spans the
            // whole trade plan instead of stopping at TP1.
            var tpEnd = p.tp3Price || p.tp2Price || p.tp1Price || null;
            function barPct(price) {
                if (!p.stopLoss || !tpEnd || price == null) return null;
                var pct = isLong
                    ? (price - p.stopLoss) / (tpEnd - p.stopLoss) * 100
                    : (p.stopLoss - price) / (p.stopLoss - tpEnd) * 100;
                return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null;
            }
            var markPct = barPct(markPrice);
            if (markPct != null) progress = markPct;

            // Vertical tick markers for each TP that exists (TP-end sits at
            // 100 % so no label needed — the green tail of the gradient
            // already signals it).
            [['TP1', p.tp1Price], ['TP2', p.tp2Price], ['TP3', p.tp3Price]].forEach(function (pair) {
                var label = pair[0], price = pair[1];
                if (!price || price === tpEnd) return;
                var pct = barPct(price);
                if (pct == null) return;
                ticksHtml += '<span class="pnl-bar-tick" style="left:' + pct.toFixed(1) + '%" data-label="' + label + '"></span>';
            });
            // Always label the rightmost TP too, so the user sees which level caps the bar.
            if (tpEnd && p.stopLoss) {
                var endLabel = tpEnd === p.tp3Price ? 'TP3' : tpEnd === p.tp2Price ? 'TP2' : 'TP1';
                ticksHtml += '<span class="pnl-bar-tick" style="left:100%" data-label="' + endLabel + '"></span>';
            }

            return '<div class="position-card ' + cls + '" role="listitem">' +
                '<div class="pos-header">' +
                    '<div class="pos-identity">' +
                        '<span class="pos-dir-badge">' + dir + '</span>' +
                        '<span class="pos-symbol">' + sym + '<span class="pos-symbol-suffix">USDT</span></span>' +
                        (lev ? '<span class="pos-lev">' + lev + '</span>' : '') +
                    '</div>' +
                    '<span class="pos-pnl ' + pnlCls + '">' + pnlStr + '</span>' +
                '</div>' +
                '<div class="pnl-bar"><div class="pnl-bar-fill" style="width:' + progress + '%"></div>' + ticksHtml + '</div>' +
                '<div class="pos-data">' +
                    // Row 1 — general position info (always 4 cells).
                    '<div class="pos-datum"><span class="pos-datum-label">Вход</span><span class="pos-datum-val">$' + fmt(p.entryPrice, 4) + '</span></div>' +
                    '<div class="pos-datum"><span class="pos-datum-label">Объём</span><span class="pos-datum-val">' + fmt(p.remainingQuantity, 4) + '</span></div>' +
                    '<div class="pos-datum"><span class="pos-datum-label">Ликвид.</span><span class="pos-datum-val val-sl">' + (p.liquidatePrice ? '$' + fmt(p.liquidatePrice, 4) : '—') + '</span></div>' +
                    '<div class="pos-datum"><span class="pos-datum-label">Маржа</span><span class="pos-datum-val">' + (p.marginSize ? '$' + fmt(p.marginSize, 2) : '—') + '</span></div>' +
                    // Row 2 — Stop Loss + three take-profit levels (always 4 cells).
                    '<div class="pos-datum"><span class="pos-datum-label">SL' + (p.slMovedToBreakeven ? '·б/у' : '') + '</span><span class="pos-datum-val val-sl">' + (p.stopLoss ? '$' + fmt(p.stopLoss, 4) : '—') + '</span></div>' +
                    '<div class="pos-datum"><span class="pos-datum-label">TP1</span><span class="pos-datum-val val-tp">' + (p.tp1Price ? '$' + fmt(p.tp1Price, 4) : '—') + '</span></div>' +
                    '<div class="pos-datum"><span class="pos-datum-label">TP2</span><span class="pos-datum-val val-tp">' + (p.tp2Price ? '$' + fmt(p.tp2Price, 4) : '—') + '</span></div>' +
                    '<div class="pos-datum"><span class="pos-datum-label">TP3</span><span class="pos-datum-val val-tp">' + (p.tp3Price ? '$' + fmt(p.tp3Price, 4) : '—') + '</span></div>' +
                '</div>' +
                '</div>';
        }).join('');
    }

    function startRefresh() {
        refresh();
        _timer = setInterval(refresh, 10000);
    }
    function stopRefresh() {
        if (_timer) { clearInterval(_timer); _timer = null; }
    }

    // ── Pause / Resume ────────────────────────────────────────────────────────
    document.getElementById('btn-pause-resume').addEventListener('click', async function () {
        haptic('medium');
        var btn = document.getElementById('btn-pause-resume');
        btn.disabled = true;
        // Capture intent BEFORE api + refresh. Previously we read _paused
        // after refresh() had already flipped it → toast showed the opposite
        // of what just happened.
        var wasPaused = _paused;
        try {
            await api('POST', wasPaused ? '/me/resume' : '/me/pause');
            await refresh();
            toast(wasPaused ? 'Торговля возобновлена' : 'Торговля приостановлена', 'info');
        } catch (err) {
            hapticNotify('error');
            toast(err.message || 'Ошибка', 'err');
        } finally {
            btn.disabled = false;
        }
    });

    // ── Emergency close ───────────────────────────────────────────────────────
    document.getElementById('btn-close-all').addEventListener('click', async function () {
        haptic('heavy');
        var confirmed = await showConfirm('Закрыть все позиции? Действие необратимо.');
        if (!confirmed) return;

        var btn = document.getElementById('btn-close-all');
        var lbl = document.getElementById('close-all-label');
        btn.disabled = true;
        lbl.textContent = 'Закрываем...';

        try {
            var res = await api('POST', '/me/close-all');
            if (res.success) {
                hapticNotify('success');
                toast('Закрыто позиций: ' + res.closed, 'ok');
                await refresh();
            } else {
                throw new Error(res.error || 'Ошибка');
            }
        } catch (err) {
            hapticNotify('error');
            toast(err.message || 'Ошибка закрытия', 'err');
        } finally {
            btn.disabled = false;
            lbl.textContent = 'Закрыть всё';
        }
    });

    // ── Init ──────────────────────────────────────────────────────────────────
    async function init() {
        // Probe profile first. Longer timeout (8s) — WEEX REST sometimes needs a moment.
        const controller = new AbortController();
        const timeout = setTimeout(function () { controller.abort(); }, 8000);
        let profile = null;
        try {
            const res = await fetch(`${API_BASE}/api/users/me`, {
                headers: {
                    'Authorization': `tma ${initData}`,
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true'
                },
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (res.ok) {
                const body = await res.json();
                if (body && body.success) profile = body.user;
            }
        } catch (e) {
            clearTimeout(timeout);
            if (!initData) {
                console.warn('[App] No Telegram initData — running outside Telegram, API will reject.');
            } else {
                console.warn('[App] profile probe failed', e);
            }
        }

        if (profile && profile.hasKeys) {
            _hasKeys = true;
            _lastProfile = profile;
            // Pre-render the API screen in "connected" state so switching tabs never shows empty inputs.
            renderOnboardingState(true, profile, null, 0, false);
            await loadSettings();
            showScreen('dashboard');
        } else {
            _hasKeys = false;
            renderOnboardingState(false);
            showScreen('onboarding');
        }
    }

    // Disconnect button inside "connected" card on the API screen
    var disconnectBtn = document.getElementById('btn-disconnect');
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async function () {
            haptic('heavy');
            var ok = await showConfirm('Отключить аккаунт? API ключи будут удалены.');
            if (!ok) return;
            try {
                await api('DELETE', '/me');
                hapticNotify('warning');
                _hasKeys = false;
                _lastProfile = null;
                renderOnboardingState(false);
                toast('API ключи удалены', 'info');
                showScreen('onboarding');
            } catch (err) {
                hapticNotify('error');
                toast(err.message || 'Ошибка', 'err');
            }
        });
    }

    window.App = {
        show: function (name) {
            haptic('light');
            if (name === 'settings') loadSettings();
            // When navigating to the API/onboarding screen, make sure it reflects
            // the current connection state (form vs. connected card) and force a
            // refresh so balance/positions numbers are fresh.
            if (name === 'onboarding') {
                renderOnboardingState(_hasKeys, _lastProfile);
                if (_hasKeys) refresh();
            }
            showScreen(name);
        },
        toggleEye: toggleEye
    };

    init();

})();