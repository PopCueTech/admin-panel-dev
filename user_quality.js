// ═════════════════════════════════════════════════════════
// USER QUALITY
// Platform-wide respondent-quality rollup across ALL users, plus a
// per-user drill-in (their score history across every survey).
// Depends on globals from app.js / redemptions.js: API_BASE_URL,
// fetchWithAuth, showToast, hideAllSections, setActiveTab, _esc
// ═════════════════════════════════════════════════════════

let _uqFiltersWired = false;

function _uqTierBadge(tier) {
    const map = {
        trusted: ['#dcfce7', '#166534'],
        watch:   ['#fef3c7', '#92400e'],
        flagged: ['#fee2e2', '#991b1b'],
    };
    const [bg, fg] = map[tier] || ['#f3f4f6', '#6b7280'];
    return `<span style="display:inline-block; padding:3px 9px; border-radius:999px; font-size:11px; font-weight:600; background:${bg}; color:${fg};">${_esc(tier || 'unknown')}</span>`;
}

function _uqFlagChip(label, count) {
    return `<span style="display:inline-block; padding:3px 9px; border-radius:999px; font-size:11px; font-weight:500; background:#f3f4f6; color:#374151; margin:2px 4px 2px 0;">${_esc(label)}${count != null ? ` × ${count}` : ''}</span>`;
}

// ── section entry ────────────────────────────────────────
async function showUserQuality() {
    hideAllSections();
    const sec = document.getElementById('userQualitySection');
    if (sec) sec.style.display = 'block';
    setActiveTab('user-quality');
    wireUpUserQualityFilters();
    await loadUserQuality();
}

function wireUpUserQualityFilters() {
    if (_uqFiltersWired) return;
    const search = document.getElementById('uqSearch');
    const tier = document.getElementById('uqTierFilter');
    const sort = document.getElementById('uqSort');
    let t;
    if (search) search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadUserQuality, 250); });
    if (tier) tier.addEventListener('change', loadUserQuality);
    if (sort) sort.addEventListener('change', loadUserQuality);
    _uqFiltersWired = true;
}

async function loadUserQuality() {
    const macroEl = document.getElementById('uqMacro');
    const body = document.getElementById('uqUsersBody');
    if (body) body.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:40px; color:#6b7280;">Loading…</td></tr>';

    const search = (document.getElementById('uqSearch')?.value || '').trim();
    const tier = document.getElementById('uqTierFilter')?.value || '';
    const sort = document.getElementById('uqSort')?.value || 'exclude_rate';
    const params = new URLSearchParams({ sort, limit: '100' });
    if (search) params.set('search', search);
    if (tier) params.set('tier', tier);

    try {
        const res = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/quality/users?${params.toString()}`);
        if (res.status === 403) { showToast('Admin access required', 'error'); return; }
        const data = await res.json();
        renderUserQualityMacro(data.macro);
        renderUserQualityUsers(data.users || []);
    } catch (e) {
        console.error('[UserQuality] load failed', e);
        if (macroEl) macroEl.innerHTML = '';
        if (body) body.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:40px; color:#991b1b;">Failed to load user quality.</td></tr>';
    }
}

function renderUserQualityMacro(m) {
    const el = document.getElementById('uqMacro');
    if (!el) return;
    if (!m || !m.users_scored) {
        el.innerHTML = '<p style="color:#6b7280; padding:8px 0;">No respondents have been scored yet. Complete or backfill some surveys first.</p>';
        return;
    }
    const td = m.tier_distribution || { trusted: 0, watch: 0, flagged: 0 };
    const total = (td.trusted + td.watch + td.flagged) || 1;
    const pct = (n) => `${(n / total * 100).toFixed(0)}%`;
    const card = (label, value, sub, color) => `
        <div style="background:var(--color-background-secondary,#f7f7f5); border-radius:8px; padding:14px 16px; min-width:0;">
            <div style="font-size:13px; color:#6b7280;">${_esc(label)}</div>
            <div style="font-size:24px; font-weight:600; ${color ? `color:${color};` : ''}">${value}</div>
            ${sub ? `<div style="font-size:11px; color:#9ca3af;">${_esc(sub)}</div>` : ''}
        </div>`;

    const signals = (m.top_signals || []).slice(0, 6)
        .map(s => _uqFlagChip(`${s.label} · ${s.pct_of_responses}%`)).join('') || '<span style="color:#9ca3af; font-size:12px;">none</span>';

    el.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px,1fr)); gap:12px; margin-bottom:16px;">
            ${card('Users scored', m.users_scored.toLocaleString())}
            ${card('Ever flagged', m.ever_flagged.toLocaleString(), `${m.ever_flagged_pct}% of users`, '#991b1b')}
            ${card('Repeat offenders', m.repeat_offenders.toLocaleString(), 'excluded ≥ 3 surveys', '#991b1b')}
            ${card('Platform exclude rate', `${m.platform_exclude_rate}%`)}
        </div>
        <div style="background:#fff; border:0.5px solid #e5e7eb; border-radius:12px; padding:14px 18px; margin-bottom:16px;">
            <div style="font-size:13px; color:#6b7280; margin-bottom:8px;">Users by quality tier</div>
            <div style="display:flex; height:16px; border-radius:8px; overflow:hidden; margin-bottom:8px;">
                <div style="width:${pct(td.trusted)}; background:#1D9E75;" title="trusted ${td.trusted}"></div>
                <div style="width:${pct(td.watch)}; background:#EF9F27;" title="watch ${td.watch}"></div>
                <div style="width:${pct(td.flagged)}; background:#E24B4A;" title="flagged ${td.flagged}"></div>
            </div>
            <div style="display:flex; gap:16px; font-size:12px; color:#374151;">
                <span>● Trusted ${td.trusted}</span>
                <span style="color:#92400e;">● Watch ${td.watch}</span>
                <span style="color:#991b1b;">● Flagged ${td.flagged}</span>
            </div>
            <div style="margin-top:12px; font-size:13px; color:#6b7280;">Most common signals platform-wide</div>
            <div style="margin-top:6px;">${signals}</div>
        </div>`;
}

function renderUserQualityUsers(users) {
    const body = document.getElementById('uqUsersBody');
    if (!body) return;
    if (!users.length) {
        body.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:40px; color:#6b7280;">No users match.</td></tr>';
        return;
    }
    body.innerHTML = users.map(u => `
        <tr style="border-top:0.5px solid #eee; cursor:pointer;" onclick="openUserQualityDetail('${_esc(u.user_id)}')">
            <td style="padding:10px 8px;">
                <div style="font-weight:500;">${_esc(u.full_name || u.email || '—')}</div>
                <code style="font-size:11px; color:#9ca3af;">${_esc(u.user_id)}</code>
            </td>
            <td style="text-align:center;">${u.surveys_scored}</td>
            <td style="text-align:center; font-weight:600; ${u.exclude_rate >= 40 ? 'color:#991b1b;' : (u.exclude_rate >= 10 ? 'color:#92400e;' : '')}">${u.exclude_rate}%</td>
            <td style="text-align:center;">${u.mean_quality_score == null ? '—' : u.mean_quality_score}</td>
            <td style="text-align:center;">${u.times_excluded}</td>
            <td style="text-align:right;">${_uqTierBadge(u.tier)}</td>
        </tr>`).join('');
}

// ── per-user detail modal ────────────────────────────────
async function openUserQualityDetail(userId) {
    const modal = document.getElementById('uqModal');
    const body = document.getElementById('uqModalBody');
    if (!modal || !body) return;
    modal.style.display = 'flex';
    body.innerHTML = '<p style="padding:30px; text-align:center; color:#6b7280;">Loading…</p>';
    try {
        const res = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/users/${userId}/quality`);
        const d = await res.json();
        renderUserQualityDetail(d);
    } catch (e) {
        console.error('[UserQuality] detail failed', e);
        body.innerHTML = '<p style="padding:30px; text-align:center; color:#991b1b;">Failed to load.</p>';
    }
}

function closeUserQualityDetail() {
    const modal = document.getElementById('uqModal');
    if (modal) modal.style.display = 'none';
}

function renderUserQualityDetail(d) {
    const body = document.getElementById('uqModalBody');
    if (!body) return;
    const stat = (label, value, color) => `
        <div style="background:#f7f7f5; border-radius:8px; padding:12px 14px;">
            <div style="font-size:12px; color:#6b7280;">${_esc(label)}</div>
            <div style="font-size:20px; font-weight:600; ${color ? `color:${color};` : ''}">${value}</div>
        </div>`;

    const flags = Object.entries(d.recurring_flags || {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => _uqFlagChip(k.replace(/_/g, ' '), n)).join('') || '<span style="color:#9ca3af; font-size:12px;">none</span>';

    const rows = (d.history || []).map(h => `
        <tr style="border-top:0.5px solid #eee;">
            <td style="padding:8px;">${_esc(h.survey_title || h.survey_id)}</td>
            <td style="text-align:center; font-weight:600; ${h.quality_score < 40 ? 'color:#991b1b;' : ''}">${h.quality_score}</td>
            <td style="text-align:right;">${h.exclude_flag
                ? `<span style="font-size:11px; background:#fee2e2; color:#991b1b; padding:2px 8px; border-radius:999px;">${h.hard_fail_reason ? 'hard fail' : 'excluded'}</span>`
                : '<span style="font-size:11px; background:#f3f4f6; color:#6b7280; padding:2px 8px; border-radius:999px;">kept</span>'}</td>
        </tr>`).join('');

    body.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:16px;">
            <div>
                <div style="font-size:16px; font-weight:600;">${_esc(d.full_name || d.email || 'Respondent')}</div>
                <code style="font-size:11px; color:#9ca3af;">${_esc(d.user_id)}</code>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
                ${_uqTierBadge(d.tier)}
                <button class="btn btn-secondary btn-sm" onclick="closeUserQualityDetail()">Close</button>
            </div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px,1fr)); gap:10px; margin-bottom:16px;">
            ${stat('Surveys scored', d.surveys_scored)}
            ${stat('Times excluded', d.times_excluded, '#991b1b')}
            ${stat('Exclude rate', `${d.exclude_rate}%`)}
            ${stat('Mean score', d.mean_quality_score == null ? '—' : d.mean_quality_score)}
        </div>
        <div style="margin-bottom:6px; font-size:13px; color:#6b7280;">Recurring signals</div>
        <div style="margin-bottom:16px;">${flags}</div>
        <div style="margin-bottom:6px; font-size:13px; color:#6b7280;">Per-survey history</div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead><tr style="color:#9ca3af; font-size:11px; text-align:left;">
                <th style="padding:4px 8px;">Survey</th><th style="text-align:center;">Score</th><th style="text-align:right;">Status</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="3" style="padding:20px; text-align:center; color:#9ca3af;">No history</td></tr>'}</tbody>
        </table>`;
}
