// ═════════════════════════════════════════════════════════
// FRAUD & IP RISK
// Suspicious networks (cloud / VPS, non-US, many accounts per IP), the
// review queue (accounts and redemptions held automatically) and the
// manual Block / Approve / Unblock actions. Nothing is ever blocked
// automatically: blocking only happens from the buttons on this page.
// Depends on globals from app.js: API_BASE_URL, fetchWithAuth, showToast,
// hideAllSections, setActiveTab. Reuses _esc() / _fmtDate() from redemptions.js.
// ═════════════════════════════════════════════════════════

let _fraudTab = 'review';
let _fraudPage = { ips: 0, users: 0 };
const FRAUD_PAGE_SIZE = 100;
let _fraudBlockTarget = null;   // { userIds: [], ipBucket: null, label: '' }
let _fraudControlsWired = false;

const FRAUD_RULE_LABELS = {
    cloud_ip: 'Cloud / VPS IP',
    non_us: 'Outside US',
    ip_multi_account: '3+ accounts on IP',
    ip_shared_survey: 'Same survey, same IP',
    ip_shared_redeem: 'Cash-outs from same IP',
    ip_multi_signup: 'Sign-up burst',
    referral_same_ip: 'Referral from same IP',
};

function _fraudRuleChip(rule, open = true) {
    const high = ['cloud_ip', 'non_us', 'ip_multi_account', 'ip_shared_redeem', 'ip_multi_signup'].includes(rule);
    const [bg, fg] = !open ? ['#f3f4f6', '#9ca3af'] : high ? ['#fee2e2', '#991b1b'] : ['#ffedd5', '#9a3412'];
    return `<span style="display:inline-block; margin:1px 3px 1px 0; padding:2px 7px; border-radius:6px; font-size:11px; font-weight:600; background:${bg}; color:${fg};">${_esc(FRAUD_RULE_LABELS[rule] || rule)}</span>`;
}

function _fraudStatusBadge(status) {
    const map = {
        active: ['#dcfce7', '#166534', 'Active'],
        under_review: ['#fef3c7', '#92400e', 'Under review'],
        blocked: ['#fee2e2', '#991b1b', 'Blocked'],
    };
    const [bg, fg, label] = map[status] || ['#f3f4f6', '#6b7280', status || '—'];
    return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:600; background:${bg}; color:${fg};">${_esc(label)}</span>`;
}

function _fraudClassBadge(ipClass, provider, country) {
    if (ipClass === 'cloud') {
        return `<span style="display:inline-block; padding:2px 7px; border-radius:6px; font-size:11px; font-weight:700; background:#1f2937; color:#fff;">${_esc((provider || 'cloud').toUpperCase())}</span>`;
    }
    if (ipClass === 'non_us') {
        return `<span style="display:inline-block; padding:2px 7px; border-radius:6px; font-size:11px; font-weight:600; background:#e0e7ff; color:#3730a3;">Non-US ${_esc(country || '')}</span>`;
    }
    if (ipClass === 'residential') {
        return `<span style="display:inline-block; padding:2px 7px; border-radius:6px; font-size:11px; background:#f3f4f6; color:#4b5563;">US network</span>`;
    }
    return `<span style="font-size:11px; color:#9ca3af;">unknown</span>`;
}

function _usd(n) {
    return `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

async function _fraudFetch(path, options = {}) {
    const response = await fetchWithAuth(`${API_BASE_URL}${path}`, options);
    if (response.status === 403) throw new Error('Admin access required');
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try { detail = (await response.json()).detail || detail; } catch (_) { /* not json */ }
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return response;
}

async function _fraudPost(path, body) {
    const response = await _fraudFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    return response.json();
}

// ── page entry ───────────────────────────────────────────
async function showFraudRisk() {
    hideAllSections();
    document.getElementById('fraudSection').style.display = 'block';
    setActiveTab('fraud');
    wireUpFraudControls();
    await Promise.all([loadFraudSummary(), loadFraudCloudStatus()]);
    await switchFraudTab(_fraudTab);
}

function wireUpFraudControls() {
    if (_fraudControlsWired) return;
    _fraudControlsWired = true;
    document.querySelectorAll('.fraud-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchFraudTab(btn.dataset.tab));
    });
    let t = null;
    const search = document.getElementById('fraudSearch');
    if (search) search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { _fraudPage = { ips: 0, users: 0 }; switchFraudTab(_fraudTab); }, 300);
    });
    ['fraudRuleFilter', 'fraudStatusFilter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => { _fraudPage = { ips: 0, users: 0 }; switchFraudTab(_fraudTab); });
    });
}

async function refreshFraudPage() {
    await Promise.all([loadFraudSummary(), loadFraudCloudStatus(), switchFraudTab(_fraudTab)]);
}

// ── KPIs + mode banner ───────────────────────────────────
async function loadFraudSummary() {
    const kpis = document.getElementById('fraudKpis');
    const banner = document.getElementById('fraudModeBanner');
    try {
        const d = await (await _fraudFetch('/api/v1/admin/fraud/summary')).json();
        const card = (label, value, onclick) =>
            `<div class="kpi-card" ${onclick ? `style="cursor:pointer;" onclick="${onclick}"` : ''}><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div>`;
        kpis.innerHTML =
            card('Under review', (d.under_review || 0).toLocaleString(), "switchFraudTab('review')") +
            card('Held redemptions', `${d.held_redemptions || 0} · ${_usd(d.held_usd)}`, "switchFraudTab('review')") +
            card('Suspicious IPs', (d.suspicious_ips || 0).toLocaleString(), "switchFraudTab('ips')") +
            card('Cloud / VPS networks', (d.cloud_networks || 0).toLocaleString()) +
            card('Non-US users', (d.non_us_users || 0).toLocaleString()) +
            card('Flagged users', `${d.flagged_users || 0} · ${_usd(d.flagged_redeemed_usd)} redeemed`, "switchFraudTab('users')") +
            card('Blocked', (d.blocked || 0).toLocaleString(), "switchFraudTab('blocked')");

        if (d.mode === 'shadow') {
            const wb = d.would_block || {};
            const parts = Object.entries(wb).map(([k, v]) => `${v} ${_esc(k.replace(/_/g, ' '))}`).join(' · ');
            banner.innerHTML = `<div style="padding:10px 14px; border-radius:8px; background:#fef3c7; color:#92400e; font-size:13px; margin-bottom:14px;">
                <strong>Shadow mode.</strong> Rules are only recording what they would do; nothing is refused or held automatically.
                ${parts ? `Last 30 days, would have blocked: ${parts}.` : ''}</div>`;
        } else {
            banner.innerHTML = `<div style="padding:10px 14px; border-radius:8px; background:#fee2e2; color:#991b1b; font-size:13px; margin-bottom:14px;">
                <strong>Enforce mode.</strong> Cloud / VPS${d.block_non_us ? ' and non-US' : ''} networks are refused, accounts are put under review and redemptions held automatically. Blocking is still manual.</div>`;
        }
    } catch (error) {
        kpis.innerHTML = `<p style="color:#c62828;">Failed to load summary: ${_esc(error.message)}</p>`;
    }
}

// ── tabs ─────────────────────────────────────────────────
async function switchFraudTab(tab) {
    _fraudTab = tab;
    document.querySelectorAll('.fraud-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const filters = document.getElementById('fraudFilters');
    if (filters) filters.style.display = (tab === 'ips' || tab === 'users') ? 'flex' : 'none';
    const statusFilter = document.getElementById('fraudStatusFilter');
    if (statusFilter) statusFilter.style.display = tab === 'users' ? '' : 'none';
    const body = document.getElementById('fraudTabBody');
    body.innerHTML = '<p style="text-align:center; padding:40px; color:#9ca3af;">Loading…</p>';
    try {
        if (tab === 'review') await renderFraudReviewQueue(body);
        else if (tab === 'ips') await renderFraudIps(body);
        else if (tab === 'users') await renderFraudUsers(body);
        else if (tab === 'blocked') await renderFraudBlocked(body);
    } catch (error) {
        body.innerHTML = `<p style="text-align:center; padding:40px; color:#c62828;">Error: ${_esc(error.message)}</p>`;
    }
}

function _fraudTable(head, rows, empty) {
    if (!rows.length) return `<p style="text-align:center; padding:40px; color:#9ca3af;">${empty}</p>`;
    return `<div class="surveys-table-container"><table class="surveys-table"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function _fraudPager(kind, total) {
    const page = _fraudPage[kind];
    const pages = Math.max(1, Math.ceil(total / FRAUD_PAGE_SIZE));
    if (pages <= 1) return `<div style="font-size:12px; color:#9ca3af; margin-top:8px;">${total} total</div>`;
    return `<div style="display:flex; gap:8px; align-items:center; margin-top:10px; font-size:12px; color:#6b7280;">
        <button class="btn btn-secondary btn-sm" ${page === 0 ? 'disabled' : ''} onclick="_fraudPage.${kind}--; switchFraudTab(_fraudTab)">‹ Prev</button>
        Page ${page + 1} of ${pages} · ${total} total
        <button class="btn btn-secondary btn-sm" ${page + 1 >= pages ? 'disabled' : ''} onclick="_fraudPage.${kind}++; switchFraudTab(_fraudTab)">Next ›</button></div>`;
}

function _userCell(u) {
    return `<a href="#" onclick="openFraudUser('${u.user_id}'); return false;" style="font-weight:600;">${_esc(u.full_name || '—')}</a>
        <div style="font-size:12px; color:#6b7280;">${_esc(u.email)}</div>`;
}

// Review queue
async function renderFraudReviewQueue(body) {
    const d = await (await _fraudFetch('/api/v1/admin/fraud/review-queue')).json();
    const accounts = (d.accounts || []).map(u => `<tr>
        <td>${_userCell(u)}</td>
        <td>${(u.open_rules.length ? u.open_rules : u.rules).map(r => _fraudRuleChip(r)).join('')}</td>
        <td style="font-size:12px;">${(u.network_classes || []).map(c => _fraudClassBadge(c)).join(' ')} ${u.networks} network${u.networks === 1 ? '' : 's'}</td>
        <td style="text-align:right;">${_usd(u.redeemed_usd)}${u.held_usd ? `<div style="font-size:11px; color:#92400e;">${_usd(u.held_usd)} held</div>` : ''}</td>
        <td style="font-size:12px; color:#6b7280;">${_esc((u.held_by || '').replace('system:', 'auto: '))}<div>${_fmtDate(u.held_at)}</div></td>
        <td style="white-space:nowrap; text-align:right;">
            <button class="btn btn-secondary btn-sm" onclick="approveFraudUser('${u.user_id}')">Approve</button>
            <button class="btn btn-ghost btn-sm btn-ghost-danger" onclick="openFraudBlock({userIds:['${u.user_id}'], label:'${_esc(u.email)}'})">Block</button>
        </td></tr>`);
    const held = (d.held_redemptions || []).map(h => `<tr>
        <td><a href="#" onclick="openFraudUser('${h.user_id}'); return false;">${_esc(h.email)}</a> ${_fraudStatusBadge(h.account_status)}</td>
        <td>${_esc(h.brand || '—')} · ${_usd(h.value_usd)} <span style="color:#9ca3af;">(${h.points} pts)</span></td>
        <td>${_fraudRuleChip((h.hold_info || {}).rule || '')}</td>
        <td style="font-size:12px; color:#6b7280;">${_fmtDate(h.created_at)}</td>
        <td style="white-space:nowrap; text-align:right;">
            <button class="btn btn-secondary btn-sm" onclick="releaseFraudRedemption('${h.redemption_id}')">Release</button>
            <button class="btn btn-ghost btn-sm btn-ghost-danger" onclick="cancelFraudRedemption('${h.redemption_id}')">Cancel</button>
        </td></tr>`);
    body.innerHTML =
        `<h4 style="margin:4px 0 8px;">Accounts under review (${accounts.length})</h4>` +
        _fraudTable('<th>User</th><th>Why</th><th>Networks</th><th style="text-align:right;">Redeemed</th><th>Held by</th><th></th>',
            accounts, 'No accounts under review.') +
        `<h4 style="margin:22px 0 8px;">Held redemptions (${held.length})</h4>` +
        _fraudTable('<th>User</th><th>Reward</th><th>Rule</th><th>Requested</th><th></th>',
            held, 'No held redemptions.');
}

// Suspicious IPs
async function renderFraudIps(body) {
    const params = new URLSearchParams({ limit: FRAUD_PAGE_SIZE, offset: _fraudPage.ips * FRAUD_PAGE_SIZE });
    const rule = document.getElementById('fraudRuleFilter')?.value;
    const q = document.getElementById('fraudSearch')?.value.trim();
    if (rule) params.set('rule', rule);
    if (q) params.set('q', q);
    const d = await (await _fraudFetch(`/api/v1/admin/fraud/ips?${params}`)).json();
    const rows = (d.items || []).map(ip => `<tr style="cursor:pointer;" onclick="openFraudIp('${_esc(ip.ip_bucket)}')">
        <td style="font-family:monospace; font-size:12px;">${_esc(ip.ip_bucket)}${ip.rdns && ip.rdns !== '-' ? `<div style="font-family:inherit; color:#9ca3af; font-size:11px;">${_esc(ip.rdns)}</div>` : ''}</td>
        <td>${_fraudClassBadge(ip.ip_class, ip.provider, ip.country)}</td>
        <td>${(ip.rules || []).map(r => _fraudRuleChip(r)).join('')}</td>
        <td style="text-align:right; font-weight:600;">${ip.accounts}${ip.blocked_accounts ? `<div style="font-size:11px; color:#991b1b;">${ip.blocked_accounts} blocked</div>` : ''}</td>
        <td style="text-align:right;">${ip.signups || 0}</td>
        <td style="text-align:right;">${_usd(ip.redeemed_usd)}</td>
        <td style="font-size:12px; color:#6b7280;">${_fmtDate(ip.last_seen)}</td></tr>`);
    body.innerHTML = _fraudTable(
        '<th>Network</th><th>Type</th><th>Rules</th><th style="text-align:right;">Accounts</th><th style="text-align:right;">Sign-ups</th><th style="text-align:right;">Redeemed</th><th>Last seen</th>',
        rows, 'No suspicious networks.') + _fraudPager('ips', d.total_count || 0);
}

// Flagged users
async function renderFraudUsers(body) {
    const params = new URLSearchParams({ limit: FRAUD_PAGE_SIZE, offset: _fraudPage.users * FRAUD_PAGE_SIZE });
    const rule = document.getElementById('fraudRuleFilter')?.value;
    const status = document.getElementById('fraudStatusFilter')?.value;
    const q = document.getElementById('fraudSearch')?.value.trim();
    if (rule) params.set('rule', rule);
    if (status) params.set('account_status', status);
    if (q) params.set('q', q);
    const d = await (await _fraudFetch(`/api/v1/admin/fraud/users?${params}`)).json();
    const rows = (d.items || []).map(u => `<tr>
        <td>${_userCell(u)}</td>
        <td style="font-size:12px; color:#6b7280;">${_fmtDateShort(u.created_at)}</td>
        <td style="text-align:center; font-weight:700;">${u.risk_score}</td>
        <td>${(u.open_rules.length ? u.open_rules : u.rules).map(r => _fraudRuleChip(r, u.open_rules.includes(r))).join('')}</td>
        <td style="text-align:right;">${_usd(u.redeemed_usd)}</td>
        <td style="text-align:right;">${(u.points || 0).toLocaleString()}</td>
        <td>${_fraudStatusBadge(u.account_status)}</td>
        <td style="white-space:nowrap; text-align:right;">
            ${u.account_status === 'blocked'
                ? `<button class="btn btn-secondary btn-sm" onclick="unblockFraudUser('${u.user_id}')">Unblock</button>`
                : `<button class="btn btn-ghost btn-sm btn-ghost-danger" onclick="openFraudBlock({userIds:['${u.user_id}'], label:'${_esc(u.email)}'})">Block</button>`}
        </td></tr>`);
    body.innerHTML = _fraudTable(
        '<th>User</th><th>Joined</th><th style="text-align:center;">Risk</th><th>Flags</th><th style="text-align:right;">Redeemed</th><th style="text-align:right;">Points</th><th>Status</th><th></th>',
        rows, 'No flagged users.') + _fraudPager('users', d.total_count || 0);
}

// Blocked
async function renderFraudBlocked(body) {
    const d = await (await _fraudFetch('/api/v1/admin/fraud/blocked')).json();
    const users = (d.users || []).map(u => `<tr>
        <td>${_userCell(u)}</td>
        <td style="font-size:12px;">${_esc(u.status_reason || '')}</td>
        <td style="font-size:12px; color:#6b7280;">${_fmtDate(u.status_changed_at)}</td>
        <td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="unblockFraudUser('${u.user_id}')">Unblock</button></td></tr>`);
    const ids = (d.identifiers || []).map(i => `<tr>
        <td>${_esc(i.kind)}</td><td style="font-family:monospace; font-size:12px;">${_esc(i.value)}</td>
        <td style="font-size:12px;">${_esc(i.reason || '')}</td>
        <td style="font-size:12px; color:#6b7280;">${i.expires_at ? 'until ' + _fmtDateShort(i.expires_at) : 'permanent'}</td>
        <td style="text-align:right;"><button class="btn btn-ghost btn-sm" onclick="removeFraudIdentifier('${i.id}')">Remove</button></td></tr>`);
    body.innerHTML =
        `<h4 style="margin:4px 0 8px;">Blocked accounts (${users.length})</h4>` +
        _fraudTable('<th>User</th><th>Reason</th><th>Blocked</th><th></th>', users, 'No blocked accounts.') +
        `<h4 style="margin:22px 0 8px;">Blacklist (${ids.length})</h4>` +
        _fraudTable('<th>Type</th><th>Value</th><th>Reason</th><th>Expires</th><th></th>', ids, 'Blacklist is empty.');
}

// ── IP detail modal ──────────────────────────────────────
async function openFraudIp(bucket) {
    const modal = document.getElementById('fraudIpModal');
    const body = document.getElementById('fraudIpModalBody');
    modal.style.display = 'flex';
    body.innerHTML = '<p style="padding:30px; text-align:center; color:#9ca3af;">Loading…</p>';
    try {
        const d = await (await _fraudFetch(`/api/v1/admin/fraud/ips/detail?bucket=${encodeURIComponent(bucket)}`)).json();
        const info = d.info || {};
        const blockable = (d.accounts || []).filter(a => a.account_status !== 'blocked');
        const accounts = (d.accounts || []).map(a => `<tr>
            <td><input type="checkbox" class="fraud-ip-user" value="${a.user_id}" ${a.account_status === 'blocked' ? 'disabled' : ''}></td>
            <td>${_userCell(a)}</td>
            <td style="font-size:12px; color:#6b7280;">${_fmtDateShort(a.created_at)}</td>
            <td>${(a.flags || []).map(f => _fraudRuleChip(f.rule, f.status === 'open')).join('')}</td>
            <td style="text-align:right;">${_usd(a.redeemed_usd)}</td>
            <td>${_fraudStatusBadge(a.account_status)}</td></tr>`).join('');
        const events = (d.events || []).slice(0, 60).map(e => `<tr>
            <td style="font-size:11px; color:#6b7280; white-space:nowrap;">${_fmtDate(e.at)}</td>
            <td style="font-size:12px;">${_esc(e.event)}${e.would_block ? ' <span style="color:#92400e;">(would block)</span>' : ''}</td>
            <td style="font-size:11px; font-family:monospace;">${_esc((e.user_id || '').slice(0, 8))}</td>
            <td style="font-size:11px; color:#9ca3af;">${_esc(e.source)}</td></tr>`).join('');
        body.innerHTML = `
            <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div>
                    <h3 style="margin:0; font-family:monospace;">${_esc(d.ip_bucket)}</h3>
                    <div style="margin-top:6px;">${_fraudClassBadge(info.ip_class, info.provider, info.country)}
                        <span style="font-size:12px; color:#6b7280;">${_esc(info.asn_org || '')} ${info.rdns && info.rdns !== '-' ? '· ' + _esc(info.rdns) : ''}</span></div>
                    <div style="margin-top:6px;">${(d.flags || []).map(f => _fraudRuleChip(f.rule, f.status === 'open')).join('')}</div>
                    <div style="font-size:12px; color:#6b7280; margin-top:6px;">First seen ${_fmtDate(info.first_seen)} · last seen ${_fmtDate(info.last_seen)} · ${info.signups || 0} sign-ups · ${info.blocked_requests || 0} refused requests${d.blacklisted ? ' · <strong style="color:#991b1b;">blacklisted</strong>' : ''}</div>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" onclick="closeFraudModal('fraudIpModal')">Close</button>
            </div>
            <h4 style="margin:18px 0 8px;">Accounts on this network (${(d.accounts || []).length})</h4>
            <div class="surveys-table-container"><table class="surveys-table"><thead><tr>
                <th><input type="checkbox" onclick="document.querySelectorAll('.fraud-ip-user:not(:disabled)').forEach(c => c.checked = this.checked)"></th>
                <th>User</th><th>Joined</th><th>Flags</th><th style="text-align:right;">Redeemed</th><th>Status</th></tr></thead>
                <tbody>${accounts || '<tr><td colspan="6" style="text-align:center; color:#9ca3af;">No accounts</td></tr>'}</tbody></table></div>
            <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
                <button class="btn btn-ghost btn-sm btn-ghost-danger" onclick="blockSelectedOnIp('${_esc(d.ip_bucket)}')">Block selected</button>
                <button class="btn btn-primary btn-sm" style="background:#991b1b;" ${blockable.length ? '' : 'disabled'} onclick="openFraudBlock({ipBucket:'${_esc(d.ip_bucket)}', label:'all ${blockable.length} accounts on ${_esc(d.ip_bucket)}'})">Block all on this IP</button>
                ${(d.flags || []).filter(f => f.status === 'open').map(f => `<button class="btn btn-ghost btn-sm" onclick="dismissFraudFlag('${f.id}', true)">Dismiss “${_esc(FRAUD_RULE_LABELS[f.rule] || f.rule)}”</button>`).join('')}
            </div>
            <h4 style="margin:18px 0 8px;">Activity (latest ${Math.min(60, (d.events || []).length)})</h4>
            <table style="width:100%; border-collapse:collapse;">${events}</table>`;
    } catch (error) {
        body.innerHTML = `<p style="color:#c62828; padding:20px;">Error: ${_esc(error.message)}</p>`;
    }
}

function blockSelectedOnIp(bucket) {
    const ids = [...document.querySelectorAll('.fraud-ip-user:checked')].map(c => c.value);
    if (!ids.length) { showToast('Select at least one account', 'error'); return; }
    openFraudBlock({ userIds: ids, ipBucket: null, networkHint: bucket, label: `${ids.length} selected account${ids.length === 1 ? '' : 's'}` });
}

// ── user detail modal ────────────────────────────────────
async function openFraudUser(userId) {
    const modal = document.getElementById('fraudUserModal');
    const body = document.getElementById('fraudUserModalBody');
    modal.style.display = 'flex';
    body.innerHTML = '<p style="padding:30px; text-align:center; color:#9ca3af;">Loading…</p>';
    try {
        const d = await (await _fraudFetch(`/api/v1/admin/fraud/users/${userId}`)).json();
        const u = d.user;
        const nets = (d.networks || []).map(n => `<tr style="cursor:pointer;" onclick="closeFraudModal('fraudUserModal'); openFraudIp('${_esc(n.ip_bucket)}')">
            <td style="font-family:monospace; font-size:12px;">${_esc(n.ip_bucket)}</td>
            <td>${_fraudClassBadge(n.ip_class, n.provider, n.country)}</td>
            <td style="text-align:right;">${n.events}</td>
            <td style="text-align:right; ${n.other_accounts ? 'color:#991b1b; font-weight:600;' : ''}">${n.other_accounts}</td>
            <td style="font-size:12px; color:#6b7280;">${_fmtDate(n.last_seen)}</td></tr>`).join('');
        const flags = (d.flags || []).map(f => `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0;">
            <span>${_fraudRuleChip(f.rule, f.status === 'open')} <span style="font-size:11px; color:#9ca3af;">${_esc(f.status)} · ${_fmtDate(f.last_seen)}</span></span>
            ${f.status === 'open' ? `<button class="btn btn-ghost btn-sm" onclick="dismissFraudFlag('${f.id}')">Dismiss</button>` : ''}</div>`).join('');
        const ledger = (d.ledger || []).slice(0, 25).map(l => `<tr>
            <td style="font-size:11px; color:#6b7280; white-space:nowrap;">${_fmtDate(l.at)}</td>
            <td style="font-size:12px;">${_esc(l.reason)}${l.brand ? ' · ' + _esc(l.brand) : ''}${l.status ? ' ' + redemptionStatusBadge(l.status) : ''}</td>
            <td style="text-align:right; font-size:12px; ${l.delta_points < 0 ? 'color:#991b1b;' : 'color:#166534;'}">${l.delta_points > 0 ? '+' : ''}${l.delta_points}</td></tr>`).join('');
        const log = (d.moderation_log || []).map(m => `<div style="font-size:12px; padding:2px 0;">${_fmtDate(m.at)} · ${_esc(m.from || '—')} → <strong>${_esc(m.to)}</strong> · ${_esc(m.actor)} · ${_esc(m.reason || '')}</div>`).join('');
        const actions = u.account_status === 'blocked'
            ? `<button class="btn btn-secondary btn-sm" onclick="unblockFraudUser('${u.user_id}')">Unblock</button>`
            : `${u.account_status === 'under_review'
                    ? `<button class="btn btn-secondary btn-sm" onclick="approveFraudUser('${u.user_id}')">Approve</button>`
                    : `<button class="btn btn-secondary btn-sm" onclick="reviewFraudUser('${u.user_id}')">Put under review</button>`}
               <button class="btn btn-ghost btn-sm btn-ghost-danger" onclick="openFraudBlock({userIds:['${u.user_id}'], label:'${_esc(u.email)}'})">Block</button>`;
        body.innerHTML = `
            <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div>
                    <h3 style="margin:0;">${_esc(u.full_name || '—')} ${_fraudStatusBadge(u.account_status)}</h3>
                    <div style="font-size:13px; color:#6b7280;">${_esc(u.email)} · joined ${_fmtDateShort(u.created_at)} · ZIP ${_esc(u.zip_code || '—')}${u.referred_by_code ? ' · referred with ' + _esc(u.referred_by_code) : ''}</div>
                    <div style="font-size:13px; margin-top:4px;">Balance <strong>${(u.points || 0).toLocaleString()}</strong> pts · redeemed <strong>${_usd(u.redeemed_usd)}</strong> (${u.redemptions})${u.held_usd ? ` · <span style="color:#92400e;">${_usd(u.held_usd)} held</span>` : ''} · ${d.referees.length} referee${d.referees.length === 1 ? '' : 's'}</div>
                    ${u.status_reason ? `<div style="font-size:12px; color:#92400e; margin-top:4px;">${_esc(u.status_reason)}</div>` : ''}
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">${actions}
                    <button type="button" class="btn btn-secondary btn-sm" onclick="closeFraudModal('fraudUserModal')">Close</button></div>
            </div>
            <h4 style="margin:18px 0 6px;">Flags</h4>${flags || '<p style="color:#9ca3af; font-size:13px;">None</p>'}
            <h4 style="margin:18px 0 6px;">Networks used</h4>
            <div class="surveys-table-container"><table class="surveys-table"><thead><tr><th>Network</th><th>Type</th><th style="text-align:right;">Events</th><th style="text-align:right;">Other accounts</th><th>Last seen</th></tr></thead><tbody>${nets || '<tr><td colspan="5" style="color:#9ca3af; text-align:center;">No IPs recorded</td></tr>'}</tbody></table></div>
            <h4 style="margin:18px 0 6px;">Points ledger</h4><table style="width:100%; border-collapse:collapse;">${ledger}</table>
            ${log ? `<h4 style="margin:18px 0 6px;">Moderation history</h4>${log}` : ''}`;
    } catch (error) {
        body.innerHTML = `<p style="color:#c62828; padding:20px;">Error: ${_esc(error.message)}</p>`;
    }
}

function closeFraudModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

// ── block modal ──────────────────────────────────────────
function openFraudBlock(target) {
    _fraudBlockTarget = target;
    document.getElementById('fraudBlockLabel').textContent = target.label || '';
    document.getElementById('fraudBlockReason').value = '';
    document.getElementById('fraudBlockCancel').checked = true;
    document.getElementById('fraudBlockForfeit').checked = false;
    document.getElementById('fraudBlockEmail').checked = true;
    document.getElementById('fraudBlockNetwork').checked = false;
    document.getElementById('fraudBlockModal').style.display = 'flex';
    setTimeout(() => document.getElementById('fraudBlockReason').focus(), 50);
}

async function submitFraudBlock() {
    const t = _fraudBlockTarget;
    const reason = document.getElementById('fraudBlockReason').value.trim();
    if (reason.length < 3) { showToast('Enter a reason', 'error'); return; }
    const count = t.ipBucket ? 'every account on this network' : `${t.userIds.length} account${t.userIds.length === 1 ? '' : 's'}`;
    if (!confirm(`Block ${count}? They will be logged out and can't use PopCue until unblocked.`)) return;
    const opts = {
        reason,
        cancel_pending_redemptions: document.getElementById('fraudBlockCancel').checked,
        forfeit_points: document.getElementById('fraudBlockForfeit').checked,
        blacklist_email: document.getElementById('fraudBlockEmail').checked,
        blacklist_network: document.getElementById('fraudBlockNetwork').checked,
    };
    const btn = document.getElementById('fraudBlockSubmit');
    btn.disabled = true; btn.textContent = 'Blocking…';
    try {
        let result;
        if (t.ipBucket || t.userIds.length > 1) {
            result = await _fraudPost('/api/v1/admin/users/block-bulk', { ...opts, user_ids: t.userIds || [], ip_bucket: t.ipBucket || null });
            showToast(`Blocked ${result.blocked.length} account${result.blocked.length === 1 ? '' : 's'}${result.skipped.length ? ` (${result.skipped.length} skipped)` : ''}`, 'success');
        } else {
            result = await _fraudPost(`/api/v1/admin/users/${t.userIds[0]}/block`, opts);
            const nc = (result.not_cancelable || []).length;
            showToast(`Account blocked${nc ? ` · ${nc} redemption(s) already placed with Tremendous — cancel there` : ''}`, 'success');
        }
        closeFraudModal('fraudBlockModal');
        closeFraudModal('fraudIpModal');
        closeFraudModal('fraudUserModal');
        await refreshFraudPage();
    } catch (error) {
        showToast(`Block failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Block';
    }
}

// ── other actions ────────────────────────────────────────
async function _fraudAction(fn, okMessage) {
    try {
        await fn();
        showToast(okMessage, 'success');
        closeFraudModal('fraudUserModal');
        await refreshFraudPage();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function approveFraudUser(userId) {
    if (!confirm('Approve this account? It becomes active again and its held redemptions are sent to Tremendous.')) return;
    _fraudAction(() => _fraudPost(`/api/v1/admin/users/${userId}/approve`, {}), 'Account approved');
}

function reviewFraudUser(userId) {
    const note = prompt('Reason for putting this account under review:', 'Manual review');
    if (note === null) return;
    _fraudAction(() => _fraudPost(`/api/v1/admin/users/${userId}/review`, { note }), 'Account put under review');
}

function unblockFraudUser(userId) {
    if (!confirm('Unblock this account? Its blacklist entries are removed too.')) return;
    _fraudAction(() => _fraudPost(`/api/v1/admin/users/${userId}/unblock`, {}), 'Account unblocked');
}

function releaseFraudRedemption(id) {
    if (!confirm('Release this redemption? The order is placed with Tremendous now.')) return;
    _fraudAction(() => _fraudPost(`/api/v1/admin/fraud/redemptions/${id}/release`, {}), 'Redemption released');
}

function cancelFraudRedemption(id) {
    const refund = confirm('Cancel this redemption.\n\nOK = refund the points to the user\nCancel = keep deciding');
    if (!refund) return;
    _fraudAction(() => _fraudPost(`/api/v1/admin/fraud/redemptions/${id}/cancel`, { refund_points: true }), 'Redemption canceled, points refunded');
}

async function dismissFraudFlag(flagId, reopenIp) {
    try {
        await _fraudPost(`/api/v1/admin/fraud/flags/${flagId}/dismiss`, {});
        showToast('Flag dismissed', 'success');
        if (!reopenIp) closeFraudModal('fraudUserModal');
        closeFraudModal('fraudIpModal');
        await refreshFraudPage();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function removeFraudIdentifier(id) {
    if (!confirm('Remove this blacklist entry?')) return;
    try {
        await _fraudFetch(`/api/v1/admin/fraud/blocked-identifiers/${id}`, { method: 'DELETE' });
        showToast('Removed', 'success');
        await switchFraudTab('blocked');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// ── cloud ranges, detection, export ──────────────────────
async function loadFraudCloudStatus() {
    const el = document.getElementById('fraudCloudStatus');
    if (!el) return;
    try {
        const d = await (await _fraudFetch('/api/v1/admin/fraud/cloud-ranges/status')).json();
        el.innerHTML = `<div style="font-size:13px; margin-bottom:6px;"><strong>${(d.total_ranges || 0).toLocaleString()}</strong> published cloud ranges</div>` +
            (d.providers || []).map(p => `<span title="${_esc(p.last_error || '')}" style="display:inline-block; margin:2px 4px 2px 0; padding:3px 8px; border-radius:6px; font-size:11px; background:${p.last_status === 'failed' ? '#fee2e2' : '#f3f4f6'}; color:${p.last_status === 'failed' ? '#991b1b' : '#374151'};">${_esc(p.provider)} ${p.ranges.toLocaleString()}${p.last_run ? ' · ' + _fmtDateShort(p.last_run) : ' · never'}</span>`).join('');
    } catch (error) {
        el.innerHTML = `<span style="color:#c62828; font-size:12px;">${_esc(error.message)}</span>`;
    }
}

async function syncFraudCloudRanges(btn) {
    btn.disabled = true; btn.textContent = 'Syncing…';
    try {
        const d = await _fraudPost('/api/v1/admin/fraud/cloud-ranges/sync', {});
        const failed = Object.entries(d.results || {}).filter(([, r]) => r.status !== 'ok').map(([p]) => p);
        showToast(failed.length ? `Synced, but failed: ${failed.join(', ')}` : 'Cloud ranges synced', failed.length ? 'error' : 'success');
        await loadFraudCloudStatus();
    } catch (error) {
        showToast(`Sync failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Sync now';
    }
}

async function runFraudDetection(btn) {
    btn.disabled = true; btn.textContent = 'Running…';
    try {
        const d = await _fraudPost('/api/v1/admin/fraud/detect', {});
        const flags = Object.entries(d.flags || {}).map(([k, v]) => `${v} ${FRAUD_RULE_LABELS[k] || k}`).join(', ');
        showToast(`Detection done${flags ? ': ' + flags : ''}`, 'success');
        await refreshFraudPage();
    } catch (error) {
        showToast(`Detection failed: ${error.message}`, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Run detection';
    }
}

async function exportFraudCsv() {
    const type = document.getElementById('fraudExportType').value;
    try {
        const response = await _fraudFetch(`/api/v1/admin/fraud/export.csv?type=${encodeURIComponent(type)}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `popcue_fraud_${type}_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (error) {
        showToast(`Export failed: ${error.message}`, 'error');
    }
}
