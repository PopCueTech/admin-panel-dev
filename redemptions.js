// ═════════════════════════════════════════════════════════
// REDEMPTIONS
// Admin view of voucher redemptions across all users, plus a
// per-user reward-ledger drill-in (where the coins came from).
// Depends on globals from app.js: API_BASE_URL, fetchWithAuth,
// showToast, hideAllSections, setActiveTab
// ═════════════════════════════════════════════════════════

let allRedemptions = [];
let _redemptionFiltersWired = false;
let _currentRedemptionId = null;

// ── small helpers ────────────────────────────────────────
function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function _fmtDateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString();
}

function redemptionStatusBadge(status) {
    const map = {
        PENDING:   ['#fef3c7', '#92400e'],
        DELIVERED: ['#dcfce7', '#166534'],
        FAILED:    ['#fee2e2', '#991b1b'],
        CANCELED:  ['#f3f4f6', '#6b7280'],
    };
    const [bg, fg] = map[status] || ['#f3f4f6', '#6b7280'];
    return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:600; background:${bg}; color:${fg};">${_esc(status || 'UNKNOWN')}</span>`;
}

// ── list view ────────────────────────────────────────────
async function showRedemptions() {
    hideAllSections();
    document.getElementById('redemptionsSection').style.display = 'block';
    setActiveTab('redemptions');
    wireUpRedemptionFilters();
    await loadRedemptionsList();
}

async function loadRedemptionsList() {
    const tbody = document.getElementById('redemptionsTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px;">Loading redemptions…</td></tr>';

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/redemptions`);

        if (response.status === 403) {
            showToast('Admin access required to view redemptions', 'error');
            if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:#c62828;">Admin access required</td></tr>';
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        allRedemptions = data.redemptions || [];
        // Re-apply any active filters rather than dumping the raw list
        filterRedemptions();
    } catch (error) {
        showToast(`Failed to load redemptions: ${error.message}`, 'error');
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:40px; color:#c62828;">Error: ${_esc(error.message)}</td></tr>`;
    }
}

function updateRedemptionsCount(n) {
    const el = document.getElementById('redemptionsCountDisplay');
    if (el) el.textContent = n;
}

function renderRedemptionsTable(items) {
    const tbody = document.getElementById('redemptionsTableBody');
    if (!tbody) return;

    if (!items || items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:#999;">No redemptions found</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(r => `
        <tr>
            <td><strong>${_esc(r.user_name)}</strong></td>
            <td style="color:#666;">${_esc(r.user_email)}</td>
            <td>${_esc(r.brand)}</td>
            <td>$${Number(r.voucher_value_usd || 0).toFixed(2)}</td>
            <td>${Number(r.points_redeemed || 0).toLocaleString()}</td>
            <td>${redemptionStatusBadge(r.delivery_status)}${r.refunded ? ' <span style="font-size:10px; color:#991b1b;">(refunded)</span>' : ''}</td>
            <td style="white-space:nowrap;">${_fmtDateShort(r.redeemed_at)}</td>
            <td><button type="button" class="btn btn-ghost btn-sm" onclick="viewRedemptionDetail('${r.id}')">View</button></td>
        </tr>
    `).join('');
}

function filterRedemptions() {
    const q = (document.getElementById('redemptionsSearch')?.value || '').toLowerCase().trim();
    const status = document.getElementById('redemptionsStatusFilter')?.value || '';

    const filtered = allRedemptions.filter(r => {
        const matchQ = !q
            || (r.user_name || '').toLowerCase().includes(q)
            || (r.user_email || '').toLowerCase().includes(q);
        const matchS = !status || r.delivery_status === status;
        return matchQ && matchS;
    });

    renderRedemptionsTable(filtered);
    updateRedemptionsCount(filtered.length);
}

function wireUpRedemptionFilters() {
    if (_redemptionFiltersWired) return;
    const search = document.getElementById('redemptionsSearch');
    const statusSel = document.getElementById('redemptionsStatusFilter');

    let t;
    if (search) {
        search.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(filterRedemptions, 200);
        });
    }
    if (statusSel) statusSel.addEventListener('change', filterRedemptions);
    _redemptionFiltersWired = true;
}

// ── detail modal (redemption + user reward-ledger) ───────
async function viewRedemptionDetail(redemptionId) {
    const item = allRedemptions.find(r => r.id === redemptionId);
    if (!item) {
        showToast('Redemption not found', 'error');
        return;
    }
    _currentRedemptionId = redemptionId;

    document.getElementById('redemptionUserName').textContent = item.user_name || '—';
    document.getElementById('redemptionUserEmail').textContent = item.user_email || '—';
    document.getElementById('redemptionUserBalance').textContent = Number(item.current_balance || 0).toLocaleString();
    renderRedemptionDetailBody(item);

    document.getElementById('redemptionDetailModal').style.display = 'flex';

    const ledgerBody = document.getElementById('redemptionLedgerBody');
    if (ledgerBody) ledgerBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px;">Loading…</td></tr>';
    document.getElementById('redemptionLedgerSummary').textContent = '';
    await loadUserLedger(item.user_id);
}

function renderRedemptionDetailBody(item) {
    const row = (label, value) =>
        `<div><div style="color:#888; font-size:11px;">${label}</div><div>${value}</div></div>`;

    const link = item.delivery_link
        ? `<a href="${_esc(item.delivery_link)}" target="_blank" rel="noopener" style="color:#2563eb;">Open link ↗</a>`
        : '—';

    const body = document.getElementById('redemptionDetailBody');
    body.innerHTML = [
        row('Reward', _esc(item.brand) + (item.voucher_name && item.voucher_name !== item.brand ? ` — ${_esc(item.voucher_name)}` : '')),
        row('Value', `$${Number(item.voucher_value_usd || 0).toFixed(2)}`),
        row('Points redeemed', Number(item.points_redeemed || 0).toLocaleString()),
        row('Delivery status', redemptionStatusBadge(item.delivery_status)),
        row('Order status', _esc(item.order_status || '—')),
        row('Refunded', item.refunded ? 'Yes' : 'No'),
        row('Redeemed at', _fmtDate(item.redeemed_at)),
        row('Delivered at', _fmtDate(item.delivered_at)),
        row('Expires at', _fmtDate(item.expires_at)),
        row('Voucher code', item.voucher_code ? `<code>${_esc(item.voucher_code)}</code>` : '—'),
        row('Delivery link', link),
        row('Clicks', `${Number(item.total_clicks || 0)}${item.first_clicked_at ? ` (first ${_fmtDateShort(item.first_clicked_at)})` : ''}`),
        row('Recipient email', _esc(item.recipient_email || '—')),
        row('Order ID', `<span style="font-size:11px;">${_esc(item.order_id || '—')}</span>`),
        item.error_message ? row('Error', `<span style="color:#991b1b;">${_esc(item.error_message)}</span>`) : '',
    ].join('');
}

async function loadUserLedger(userId) {
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/users/${userId}/reward-ledger`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        renderUserLedger(data);
    } catch (error) {
        const body = document.getElementById('redemptionLedgerBody');
        if (body) body.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:24px; color:#c62828;">Failed to load ledger: ${_esc(error.message)}</td></tr>`;
    }
}

function renderUserLedger(data) {
    const summary = document.getElementById('redemptionLedgerSummary');
    if (summary) {
        summary.textContent =
            `Earned ${Number(data.total_earned || 0).toLocaleString()} · ` +
            `Redeemed ${Number(data.total_redeemed || 0).toLocaleString()} · ` +
            `Balance ${Number(data.current_balance || 0).toLocaleString()}`;
    }

    const body = document.getElementById('redemptionLedgerBody');
    if (!body) return;

    const entries = data.entries || [];
    if (entries.length === 0) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px; color:#999;">No ledger entries</td></tr>';
        return;
    }

    body.innerHTML = entries.map(e => {
        const positive = (e.delta_points || 0) >= 0;
        const pts = `${positive ? '+' : ''}${Number(e.delta_points || 0).toLocaleString()}`;
        let detail = '—';
        if (e.survey_title) detail = _esc(e.survey_title);
        else if (e.voucher_brand) detail = `${_esc(e.voucher_brand)}${e.voucher_value_usd ? ` ($${Number(e.voucher_value_usd).toFixed(2)})` : ''}`;
        return `
            <tr>
                <td>${_esc(e.source_label)}</td>
                <td style="color:#666;">${detail}</td>
                <td style="text-align:right; font-weight:600; color:${positive ? '#166534' : '#991b1b'};">${pts}</td>
                <td style="text-align:right;">${Number(e.balance_after || 0).toLocaleString()}</td>
                <td style="white-space:nowrap;">${_fmtDateShort(e.created_at)}</td>
            </tr>
        `;
    }).join('');
}

async function refreshRedemptionStatus() {
    if (!_currentRedemptionId) return;
    const btn = document.getElementById('redemptionRefreshBtn');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }

    try {
        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/admin/redemptions/${_currentRedemptionId}/refresh-status`,
            { method: 'POST' }
        );
        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try { const d = await response.json(); detail = d.detail || detail; } catch (e) {}
            throw new Error(detail);
        }

        const updated = await response.json();
        const idx = allRedemptions.findIndex(r => r.id === updated.id);
        if (idx !== -1) allRedemptions[idx] = updated;

        renderRedemptionDetailBody(updated);
        document.getElementById('redemptionUserBalance').textContent = Number(updated.current_balance || 0).toLocaleString();
        filterRedemptions(); // re-render the table preserving active filters
        showToast(`Status: ${updated.delivery_status}`, 'success');
    } catch (error) {
        showToast(`Refresh failed: ${error.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = original || '🔄 Refresh status'; }
    }
}

function closeRedemptionDetailModal() {
    document.getElementById('redemptionDetailModal').style.display = 'none';
    _currentRedemptionId = null;
}
