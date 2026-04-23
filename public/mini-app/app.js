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
    async function api(method, path, body) {
        const opts = {
            method,
            headers: {
                'Authorization': `tma ${initData}`,
                'Content-Type': 'application/json'
            }
        };
        if (body !== undefined) opts.body = JSON.stringify(body);
        const res = await fetch(`/api/users${path}`, opts);
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
        el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span>${msg}</span>`;
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
        if (name === 'dashboard') startRefresh();
        else stopRefresh();
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
                toast('Подключено! Баланс: $' + Number(data.balance).toFixed(2), 'ok');
                document.getElementById('inp-apikey').value = '';
                document.getElementById('inp-secret').value = '';
                document.getElementById('inp-pass').value   = '';
                setTimeout(function () { showScreen('dashboard'); }, 1200);
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

            // Stats
            var s = data.stats || {};
            var pnl = Number(s.totalPnl || 0);
            setEl('stat-trades',  s.totalTrades || 0);
            setEl('stat-winrate', Math.round(s.winRate || 0) + '%');
            var pnlEl = document.getElementById('stat-pnl');
            if (pnlEl) {
                pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2);
                pnlEl.className   = 'stat-val ' + (pnl >= 0 ? 'pnl-positive' : 'pnl-negative');
            }

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

        } catch (e) { /* ignore */ }
    }

    function setEl(id, val) {
        var el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function fmt(v, d) {
        var n = Number(v);
        return Number.isFinite(n) ? n.toFixed(d != null ? d : 2) : '—';
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
            var pnl     = Number(p.realizedPnl || 0);
            var pnlCls  = pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            var pnlStr  = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2);
            var lev     = p.leverage ? p.leverage + '×' : '';
            var sym     = p.symbol.replace('USDT', '');

            var progress = 50;
            if (p.stopLoss && p.tp1Price && p.entryPrice) {
                var range = Math.abs(p.tp1Price - p.stopLoss);
                if (range > 0) {
                    progress = Math.min(100, Math.max(0, (Math.abs(p.entryPrice - p.stopLoss) / range) * 100));
                }
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
                '<div class="pnl-bar"><div class="pnl-bar-fill" style="width:' + progress + '%"></div></div>' +
                '<div class="pos-data">' +
                    '<div class="pos-datum"><span class="pos-datum-label">Вход</span><span class="pos-datum-val">$' + fmt(p.entryPrice, 4) + '</span></div>' +
                    '<div class="pos-datum"><span class="pos-datum-label">Объём</span><span class="pos-datum-val">' + fmt(p.remainingQuantity, 4) + '</span></div>' +
                    (p.stopLoss ? '<div class="pos-datum"><span class="pos-datum-label">Stop Loss' + (p.slMovedToBreakeven ? ' · б/у' : '') + '</span><span class="pos-datum-val val-sl">$' + fmt(p.stopLoss, 4) + '</span></div>' : '') +
                    (p.tp1Price ? '<div class="pos-datum"><span class="pos-datum-label">Take Profit</span><span class="pos-datum-val val-tp">$' + fmt(p.tp1Price, 4) + '</span></div>' : '') +
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
        try {
            await api('POST', _paused ? '/me/resume' : '/me/pause');
            await refresh();
            toast(_paused ? 'Торговля возобновлена' : 'Торговля приостановлена', 'info');
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
        try {
            var profile = await api('GET', '/me');
            if (profile.success && profile.user && profile.user.hasKeys) {
                await loadSettings();
                showScreen('dashboard');
            } else {
                showScreen('onboarding');
            }
        } catch (e) {
            showScreen('onboarding');
        }
    }

    window.App = {
        show: function (name) {
            haptic('light');
            if (name === 'settings') loadSettings();
            showScreen(name);
        },
        toggleEye: toggleEye
    };

    init();

})();