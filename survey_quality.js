// ═════════════════════════════════════════════════════════
// PER-SURVEY DATA QUALITY PANEL
// Summary + respondents drill-down + "exclude low-quality from KPIs" toggle,
// shown inside the survey-details view.
// Depends on globals: API_BASE_URL, fetchWithAuth, _esc, loadSurveyMetrics,
// closeUserQualityDetail (#uqModal reuse).
// ═════════════════════════════════════════════════════════

let _dqRespondents = [];

const DQ_CLUSTERS = [
    ['speed', 'Speed', ['A1_gross_speeder', 'A2_per_question_speeder', 'A3_uniform_timing', 'A4_sleeper']],
    ['non_differentiation', 'Non-differentiation', ['B1_straightliner', 'B2_non_differentiation', 'B3_extreme_zigzag', 'B4_pickrate_position_bias', 'B5_ranking_default_inverse', 'B6_image_extreme']],
    ['text_quality', 'Text quality', ['C1_nonanswer_filler', 'C2_too_short_text', 'C3_gibberish', 'C4_copypaste_session']],
    ['instability', 'Instability', ['D1_answer_instability']],
];
const DQ_GATES = ['E1_low_completeness', 'E2_attention_check_fail', 'E3_cross_respondent_duplicate'];
const DQ_LABELS = {
    A1_gross_speeder: 'Gross speeder', A2_per_question_speeder: 'Per-question speeder',
    A3_uniform_timing: 'Uniform timing', A4_sleeper: 'Sleeper / disengaged',
    B1_straightliner: 'Straight-liner', B2_non_differentiation: 'Non-differentiation',
    B3_extreme_zigzag: 'Extreme / zig-zag', B4_pickrate_position_bias: 'Pick-rate bias',
    B5_ranking_default_inverse: 'Ranking default/inverse', B6_image_extreme: 'Image extreme',
    C1_nonanswer_filler: 'Filler text', C2_too_short_text: 'Too-short text',
    C3_gibberish: 'Gibberish', C4_copypaste_session: 'Copy-paste',
    D1_answer_instability: 'Answer instability',
    E1_low_completeness: 'Completeness', E2_attention_check_fail: 'Attention check',
    E3_cross_respondent_duplicate: 'Duplicate text',
};
const DQ_CLUSTER_BADGE = {
    speed: ['#FAEEDA', '#854F0B'],
    non_differentiation: ['#FAECE7', '#993C1D'],
    text_quality: ['#E6F1FB', '#0C447C'],
    instability: ['#FAEEDA', '#854F0B'],
};

function _dqSevColor(v) {
    if (v >= 0.7) return '#991b1b';
    if (v >= 0.4) return '#92400e';
    if (v > 0) return '#6b7280';
    return '#cbd5e1';
}

async function loadSurveyQuality(surveyId) {
    window._dqSurveyId = surveyId;
    const card = document.getElementById('dataQualityCard');
    const toggle = document.getElementById('dqExcludeToggle');
    if (toggle) toggle.checked = false;
    const note = document.getElementById('dqExcludeNote');
    if (note) note.style.display = 'none';

    try {
        const [sumRes, respRes] = await Promise.all([
            fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/quality-summary`),
            fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/quality/respondents?limit=200`),
        ]);
        const summary = await sumRes.json();
        if (!summary || !summary.raw_n) { if (card) card.style.display = 'none'; return; }
        const resp = await respRes.json();
        if (card) card.style.display = 'block';
        renderDqSummary(summary);
        _dqRespondents = resp.respondents || [];
        renderDqRespondents(_dqRespondents);
    } catch (e) {
        console.error('[SurveyQuality] load failed', e);
        if (card) card.style.display = 'none';
    }
}

function renderDqSummary(s) {
    const el = document.getElementById('dqSummary');
    if (!el) return;
    const card = (label, value, color) =>
        `<div style="background:#f7f7f5; border-radius:8px; padding:12px 14px;"><div style="font-size:12px; color:#6b7280;">${label}</div><div style="font-size:22px; font-weight:600; ${color ? `color:${color};` : ''}">${value}</div></div>`;

    const d = s.score_distribution || {};
    const dist = [['0', '#E24B4A'], ['1-39', '#E24B4A'], ['40-59', '#EF9F27'], ['60-79', '#97C459'], ['80-100', '#1D9E75']];
    const distTotal = Object.values(d).reduce((a, b) => a + b, 0) || 1;
    const distBar = dist.map(([k, c]) => `<div style="width:${((d[k] || 0) / distTotal * 100).toFixed(0)}%; background:${c};" title="${k}: ${d[k] || 0}"></div>`).join('');

    const cm = s.cluster_means || {};
    const clusterBars = DQ_CLUSTERS.map(([key, label]) => {
        const v = cm[key] || 0;
        return `<div><div style="font-size:12px; color:#6b7280;">${label}</div><div style="height:6px; background:#eee; border-radius:999px;"><div style="width:${Math.min(v * 100, 100).toFixed(0)}%; height:6px; background:#7F77DD; border-radius:999px;"></div></div><div style="font-size:11px; color:#9ca3af;">avg ${v.toFixed(2)}</div></div>`;
    }).join('');

    const hf = s.hard_fail_counts || {};
    const hfLine = Object.keys(hf).length
        ? Object.entries(hf).map(([k, n]) => `${DQ_LABELS[k] || k}: ${n}`).join(' · ')
        : 'none';

    el.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:14px;">
            ${card('Respondents', s.raw_n)}
            ${card('Excluded', s.excluded_n, '#991b1b')}
            ${card('Exclude rate', `${s.exclude_rate}%`)}
            ${card('Mean score', s.mean_quality_score == null ? '—' : s.mean_quality_score)}
        </div>
        <div style="font-size:12px; color:#6b7280; margin-bottom:6px;">Score distribution</div>
        <div style="display:flex; height:14px; border-radius:8px; overflow:hidden; margin-bottom:14px;">${distBar}</div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:10px;">${clusterBars}</div>
        <div style="font-size:12px; color:#6b7280;">Hard fails — ${hfLine}</div>`;
}

function _dqFlagBadges(r) {
    const out = [];
    const cs = r.cluster_scores || {};
    for (const [key, label] of [['speed', 'Speeder'], ['non_differentiation', 'Non-diff'], ['text_quality', 'Text'], ['instability', 'Instability']]) {
        if ((cs[key] || 0) >= 0.5) {
            const [bg, fg] = DQ_CLUSTER_BADGE[key];
            out.push(`<span style="font-size:11px; background:${bg}; color:${fg}; padding:2px 7px; border-radius:999px; margin-right:4px;">${label}</span>`);
        }
    }
    if (r.hard_fail_reason) out.push(`<span style="font-size:11px; background:#fee2e2; color:#991b1b; padding:2px 7px; border-radius:999px;">hard fail</span>`);
    return out.join('') || '<span style="color:#cbd5e1;">—</span>';
}

function renderDqRespondents(list) {
    const body = document.getElementById('dqRespondentsBody');
    if (!body) return;
    if (!list.length) {
        body.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:#9ca3af;">No respondents scored yet.</td></tr>';
        return;
    }
    body.innerHTML = list.map((r, i) => `
        <tr style="border-top:0.5px solid #eee; cursor:pointer;" onclick="openDqRespondent(${i})">
            <td style="padding:8px;"><code style="font-size:11px;">${_esc(r.respondent_id)}</code></td>
            <td style="text-align:center; font-weight:600; ${r.quality_score < 40 ? 'color:#991b1b;' : ''}">${r.quality_score}</td>
            <td>${_dqFlagBadges(r)}</td>
            <td style="text-align:right; padding-right:8px;">${r.exclude_flag
                ? '<span style="font-size:11px; background:#fee2e2; color:#991b1b; padding:2px 8px; border-radius:999px;">excluded</span>'
                : '<span style="font-size:11px; background:#f3f4f6; color:#6b7280; padding:2px 8px; border-radius:999px;">kept</span>'}</td>
        </tr>`).join('');
}

function openDqRespondent(idx) {
    const r = _dqRespondents[idx];
    if (!r) return;
    const modal = document.getElementById('uqModal');
    const body = document.getElementById('uqModalBody');
    if (!modal || !body) return;
    const sd = r.signal_detail || {};

    const clusterBlocks = DQ_CLUSTERS.map(([key, label, sigs]) => {
        const chips = sigs.map(k => {
            const v = sd[k];
            const enabled = v !== undefined;
            const val = typeof v === 'number' ? v : 0;
            const color = enabled ? _dqSevColor(val) : '#cbd5e1';
            return `<span style="font-size:11px; color:${color}; border:0.5px solid ${color}; padding:2px 7px; border-radius:999px; margin:2px 4px 2px 0; display:inline-block;">${DQ_LABELS[k]} ${enabled ? val.toFixed(2) : 'off'}</span>`;
        }).join('');
        const cscore = (r.cluster_scores || {})[key] || 0;
        return `<div style="margin-bottom:10px;"><div style="font-size:12px; color:#6b7280; margin-bottom:4px;">${label} · ${cscore.toFixed(2)}</div>${chips}</div>`;
    }).join('');

    const gates = DQ_GATES.map(k => {
        const failed = sd[k] === true;
        return `<span style="font-size:11px; color:${failed ? '#991b1b' : '#166534'}; margin-right:10px;">${failed ? '✗' : '✓'} ${DQ_LABELS[k]}</span>`;
    }).join('');

    body.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px;">
            <div><div style="font-size:15px; font-weight:600;">Respondent</div><code style="font-size:11px; color:#9ca3af;">${_esc(r.respondent_id)}</code></div>
            <div style="display:flex; gap:8px; align-items:center;">
                <span style="font-size:13px;">score <b style="${r.quality_score < 40 ? 'color:#991b1b;' : ''}">${r.quality_score}</b></span>
                ${r.exclude_flag ? '<span style="font-size:11px; background:#fee2e2; color:#991b1b; padding:2px 8px; border-radius:999px;">excluded</span>' : ''}
                <button class="btn btn-secondary btn-sm" onclick="closeUserQualityDetail()">Close</button>
            </div>
        </div>
        ${clusterBlocks}
        <div style="border-top:0.5px solid #eee; padding-top:8px;">${gates}</div>`;
    modal.style.display = 'flex';
}

function onExcludeToggle() {
    const checked = document.getElementById('dqExcludeToggle')?.checked;
    if (window._dqSurveyId && typeof loadSurveyMetrics === 'function') {
        loadSurveyMetrics(window._dqSurveyId, !!checked);
    }
}
