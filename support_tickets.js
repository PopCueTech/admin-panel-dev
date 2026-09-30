// ═════════════════════════════════════════════════════════
// SUPPORT TICKETS
// Admin view of user-submitted support tickets, including structured
// in-app "report an issue" tickets (category set, metadata_json populated
// — e.g. survey text-quality reports) alongside the generic Contact
// Support form (category = null).
// Depends on globals from app.js: API_BASE_URL, fetchWithAuth,
// showToast, hideAllSections, setActiveTab
// ═════════════════════════════════════════════════════════

let allSupportTickets = [];
let _supportTicketFiltersWired = false;

function _stEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _stFmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function supportTicketStatusBadge(status) {
    const map = {
        open:        ['#fef3c7', '#92400e'],
        in_progress: ['#dbeafe', '#1e40af'],
        resolved:    ['#dcfce7', '#166534'],
        closed:      ['#f3f4f6', '#6b7280'],
    };
    const [bg, fg] = map[status] || ['#f3f4f6', '#6b7280'];
    return `<span style="display:inline-block; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:600; background:${bg}; color:${fg};">${_stEsc(status || 'unknown')}</span>`;
}

function supportTicketCategoryBadge(category) {
    if (!category) return '<span style="color:#999; font-size:11px;">General</span>';
    return `<span style="display:inline-block; padding:2px 7px; border-radius:5px; font-size:11px; background:#ede9fe; color:#5b21b6;">${_stEsc(category)}</span>`;
}

// ── list view ────────────────────────────────────────────
async function showSupportTickets() {
    hideAllSections();
    document.getElementById('supportTicketsSection').style.display = 'block';
    setActiveTab('support-tickets');
    wireUpSupportTicketFilters();
    await loadSupportTicketsList();
}

async function loadSupportTicketsList() {
    const tbody = document.getElementById('supportTicketsTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px;">Loading support tickets…</td></tr>';

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/support-tickets?limit=200`);

        if (response.status === 403) {
            showToast('Admin access required to view support tickets', 'error');
            if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:#c62828;">Admin access required</td></tr>';
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        allSupportTickets = data.tickets || [];
        filterSupportTickets();
    } catch (error) {
        showToast(`Failed to load support tickets: ${error.message}`, 'error');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:40px; color:#c62828;">Error: ${_stEsc(error.message)}</td></tr>`;
    }
}

function updateSupportTicketsCount(n) {
    const el = document.getElementById('supportTicketsCountDisplay');
    if (el) el.textContent = n;
}

function renderSupportTicketsTable(items) {
    const tbody = document.getElementById('supportTicketsTableBody');
    if (!tbody) return;

    if (!items || items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:#999;">No support tickets found</td></tr>';
        return;
    }

    tbody.innerHTML = items.map(t => `
        <tr>
            <td><strong>${_stEsc(t.user_name)}</strong><div style="color:#666; font-size:11px;">${_stEsc(t.user_email)}</div></td>
            <td>${supportTicketCategoryBadge(t.category)}</td>
            <td style="max-width:280px;">${_stEsc(t.subject)}</td>
            <td>${supportTicketStatusBadge(t.status)}</td>
            <td style="white-space:nowrap;">${_stFmtDate(t.created_at)}</td>
            <td><button type="button" class="btn btn-ghost btn-sm" onclick="viewSupportTicketDetail('${t.id}')">View</button></td>
        </tr>
    `).join('');
}

function filterSupportTickets() {
    const q = (document.getElementById('supportTicketsSearch')?.value || '').toLowerCase().trim();
    const status = document.getElementById('supportTicketsStatusFilter')?.value || '';
    const category = document.getElementById('supportTicketsCategoryFilter')?.value || '';

    const filtered = allSupportTickets.filter(t => {
        const matchQ = !q
            || (t.user_name || '').toLowerCase().includes(q)
            || (t.user_email || '').toLowerCase().includes(q)
            || (t.subject || '').toLowerCase().includes(q);
        const matchS = !status || t.status === status;
        const matchC = !category || (category === '__general__' ? !t.category : t.category === category);
        return matchQ && matchS && matchC;
    });

    renderSupportTicketsTable(filtered);
    updateSupportTicketsCount(filtered.length);
}

function wireUpSupportTicketFilters() {
    if (_supportTicketFiltersWired) return;
    const search = document.getElementById('supportTicketsSearch');
    const statusSel = document.getElementById('supportTicketsStatusFilter');
    const categorySel = document.getElementById('supportTicketsCategoryFilter');

    let t;
    if (search) {
        search.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(filterSupportTickets, 200);
        });
    }
    if (statusSel) statusSel.addEventListener('change', filterSupportTickets);
    if (categorySel) categorySel.addEventListener('change', filterSupportTickets);
    _supportTicketFiltersWired = true;
}

// ── detail modal ─────────────────────────────────────────
function viewSupportTicketDetail(ticketId) {
    const item = allSupportTickets.find(t => t.id === ticketId);
    if (!item) {
        showToast('Support ticket not found', 'error');
        return;
    }

    const row = (label, value) =>
        `<div style="margin-bottom:10px;"><div style="color:#888; font-size:11px;">${label}</div><div>${value}</div></div>`;

    const metadataKeys = Object.keys(item.metadata || {});
    const metadataHtml = metadataKeys.length
        ? `<pre style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; padding:10px; font-size:12px; white-space:pre-wrap; word-break:break-word;">${_stEsc(JSON.stringify(item.metadata, null, 2))}</pre>`
        : '<span style="color:#999;">—</span>';

    const body = document.getElementById('supportTicketDetailBody');
    body.innerHTML = [
        row('User', `${_stEsc(item.user_name)} &lt;${_stEsc(item.user_email)}&gt;`),
        row('Category', supportTicketCategoryBadge(item.category)),
        row('Subject', _stEsc(item.subject)),
        row('Message', `<div style="white-space:pre-wrap;">${_stEsc(item.message)}</div>`),
        row('Structured context', metadataHtml),
        row('Created', _stFmtDate(item.created_at)),
        row('Resolved', _stFmtDate(item.resolved_at)),
    ].join('');

    const statusSel = document.getElementById('supportTicketStatusSelect');
    if (statusSel) statusSel.value = item.status;
    document.getElementById('supportTicketDetailModal').dataset.ticketId = ticketId;
    document.getElementById('supportTicketDetailModal').style.display = 'flex';
}

async function updateSupportTicketStatus() {
    const modal = document.getElementById('supportTicketDetailModal');
    const ticketId = modal?.dataset.ticketId;
    const status = document.getElementById('supportTicketStatusSelect')?.value;
    if (!ticketId || !status) return;

    try {
        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/admin/support-tickets/${ticketId}`,
            { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }
        );
        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try { const d = await response.json(); detail = d.detail || detail; } catch (e) {}
            throw new Error(detail);
        }

        const updated = await response.json();
        const idx = allSupportTickets.findIndex(t => t.id === updated.id);
        if (idx !== -1) allSupportTickets[idx] = updated;

        filterSupportTickets();
        showToast(`Status updated to ${updated.status}`, 'success');
        closeSupportTicketDetailModal();
    } catch (error) {
        showToast(`Update failed: ${error.message}`, 'error');
    }
}

function closeSupportTicketDetailModal() {
    document.getElementById('supportTicketDetailModal').style.display = 'none';
}
