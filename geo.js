// ═════════════════════════════════════════════════════════
// GEOGRAPHIC DISTRIBUTION
// Where users are located, derived from user_profiles.zip_code
// (resolved server-side to US state / city / ZIP).
// Depends on globals from app.js: API_BASE_URL, fetchWithAuth,
// showToast, hideAllSections, setActiveTab. Reuses _esc() from
// redemptions.js. Uses Chart.js + chartjs-chart-geo (index.html).
// ═════════════════════════════════════════════════════════

let _geoData = null;            // last payload from /users/by-location
let _geoMap = null;             // Chart.js choropleth instance
let _usTopo = null;             // cached us-states TopoJSON
let _geoGranularity = 'state';  // 'state' | 'city' | 'zip'
let _geoSort = { key: 'count', dir: 'desc' };
let _geoControlsWired = false;

const GEO_BRAND_RGB = [83, 74, 183];   // #534AB7

function _geoLerpColor(t) {
    t = Math.max(0, Math.min(1, t));
    const eased = Math.sqrt(t);          // lift the low end so small counts stay visible
    const c = [255, 255, 255].map((w, i) => Math.round(w + (GEO_BRAND_RGB[i] - w) * eased));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function _geoPct(n) {
    const total = _geoData && _geoData.total_users ? _geoData.total_users : 0;
    if (!total) return '0.0%';
    return `${(n / total * 100).toFixed(1)}%`;
}

// ── page entry ───────────────────────────────────────────
async function showGeoDistribution() {
    hideAllSections();
    document.getElementById('geoSection').style.display = 'block';
    setActiveTab('geo');
    wireUpGeoControls();
    await loadGeoDistribution();
}

async function loadGeoDistribution(url) {
    const tbody = document.getElementById('geoTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:40px;">Loading…</td></tr>';

    try {
        const response = await fetchWithAuth(url || `${API_BASE_URL}/api/v1/admin/users/by-location`);

        if (response.status === 403) {
            showToast('Admin access required to view geographic distribution', 'error');
            if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:40px; color:#c62828;">Admin access required</td></tr>';
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        _geoData = await response.json();
        renderGeoKpis();
        renderGeoTable();
        await renderGeoMap();
    } catch (error) {
        showToast(`Failed to load geographic distribution: ${error.message}`, 'error');
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:40px; color:#c62828;">Error: ${_esc(error.message)}</td></tr>`;
    }
}

async function refreshGeoDistribution() {
    await loadGeoDistribution(`${API_BASE_URL}/api/v1/admin/users/by-location/refresh`);
    showToast('Geographic distribution refreshed', 'success');
}

// ── KPI strip ────────────────────────────────────────────
function renderGeoKpis() {
    const el = document.getElementById('geoKpis');
    if (!el || !_geoData) return;
    const d = _geoData;
    const resolvedPct = d.total_users ? (d.resolved / d.total_users * 100).toFixed(0) : 0;
    const card = (label, value) =>
        `<div class="kpi-card"><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div>`;
    el.innerHTML =
        card('Total users', (d.total_users || 0).toLocaleString()) +
        card('Resolved', `${(d.resolved || 0).toLocaleString()} · ${resolvedPct}%`) +
        card('Unknown / no ZIP', (d.unknown || 0).toLocaleString()) +
        card('States', (d.distinct_states || 0).toLocaleString()) +
        card('Cities', (d.distinct_cities || 0).toLocaleString());
}

// ── choropleth map ───────────────────────────────────────
async function renderGeoMap() {
    const canvas = document.getElementById('geoMap');
    if (!canvas || !_geoData) return;

    if (typeof Chart === 'undefined' || typeof ChartGeo === 'undefined') {
        const wrap = canvas.parentElement;
        if (wrap) wrap.innerHTML = '<p style="padding:24px; color:#9ca3af; font-size:13px;">Map library unavailable — table below still works.</p>';
        return;
    }

    try {
        Chart.register(
            ChartGeo.ChoroplethController, ChartGeo.GeoFeature,
            ChartGeo.ColorScale, ChartGeo.ProjectionScale,
        );
    } catch (_) { /* already registered */ }

    if (!_usTopo) {
        const r = await fetch('assets/us-states-10m.json');
        if (!r.ok) throw new Error(`map data HTTP ${r.status}`);
        _usTopo = await r.json();
    }

    const features = ChartGeo.topojson.feature(_usTopo, _usTopo.objects.states).features;
    const countByState = {};
    (_geoData.by_state || []).forEach(row => { countByState[row.state] = row.count; });

    if (_geoMap) { _geoMap.destroy(); _geoMap = null; }

    _geoMap = new Chart(canvas, {
        type: 'choropleth',
        data: {
            labels: features.map(f => f.properties.name),
            datasets: [{
                label: 'Users',
                outline: features,
                borderColor: 'rgba(0,0,0,0.15)',
                borderWidth: 0.5,
                data: features.map(f => ({
                    feature: f,
                    value: countByState[f.properties.name] || 0,
                })),
            }],
        },
        options: {
            maintainAspectRatio: false,
            showOutline: true,
            showGraticule: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const v = ctx.raw.value || 0;
                            return `${ctx.raw.feature.properties.name}: ${v.toLocaleString()} (${_geoPct(v)})`;
                        },
                    },
                },
            },
            scales: {
                projection: { axis: 'x', projection: 'albersUsa' },
                color: {
                    axis: 'x',
                    quantize: 5,
                    interpolate: _geoLerpColor,
                    missing: '#f3f4f6',
                    legend: { position: 'bottom-right', align: 'right' },
                },
            },
            onClick: (_e, els) => {
                if (!els.length) return;
                const f = _geoMap.data.datasets[0].data[els[0].index].feature;
                setGeoStateFilter(f.properties.name);
            },
        },
    });
}

function setGeoStateFilter(stateName) {
    // Jump to the city view filtered to the clicked state.
    _setGranularity('city');
    const search = document.getElementById('geoSearch');
    if (search) search.value = stateName;
    renderGeoTable();
}

// ── table ────────────────────────────────────────────────
function _geoRows() {
    if (!_geoData) return [];
    if (_geoGranularity === 'state') {
        return (_geoData.by_state || [])
            .filter(r => r.count > 0)
            .map(r => ({ place: r.state, state: r.state_code || '', count: r.count }));
    }
    if (_geoGranularity === 'city') {
        return (_geoData.by_city || [])
            .map(r => ({ place: r.city, state: r.state_code || '', count: r.count }));
    }
    return (_geoData.by_zip || [])
        .map(r => ({ place: `${r.zip}${r.city ? ' · ' + r.city : ''}`, state: r.state_code || '', count: r.count }));
}

function renderGeoTable() {
    const tbody = document.getElementById('geoTableBody');
    if (!tbody || !_geoData) return;

    const q = (document.getElementById('geoSearch')?.value || '').trim().toLowerCase();
    let rows = _geoRows();
    if (q) {
        rows = rows.filter(r =>
            r.place.toLowerCase().includes(q) || r.state.toLowerCase().includes(q));
    }

    const { key, dir } = _geoSort;
    const mult = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
        let av, bv;
        if (key === 'count' || key === 'pct') { av = a.count; bv = b.count; }
        else if (key === 'state') { av = a.state; bv = b.state; }
        else { av = a.place.toLowerCase(); bv = b.place.toLowerCase(); }
        if (av < bv) return -1 * mult;
        if (av > bv) return 1 * mult;
        return 0;
    });

    const shownUsers = rows.reduce((s, r) => s + r.count, 0);
    let html = rows.map(r => `
        <tr>
            <td>${_esc(r.place)}</td>
            <td>${_esc(r.state || '—')}</td>
            <td>${r.count.toLocaleString()}</td>
            <td>${_geoPct(r.count)}</td>
        </tr>`).join('');

    const unknown = _geoData.unknown || 0;
    const showUnknown = unknown > 0 && (!q || 'unknown'.includes(q));
    if (showUnknown) {
        html += `
        <tr class="geo-unknown-row">
            <td>Unknown / no ZIP</td>
            <td>—</td>
            <td>${unknown.toLocaleString()}</td>
            <td>${_geoPct(unknown)}</td>
        </tr>`;
    }

    tbody.innerHTML = html || '<tr><td colspan="4" style="text-align:center; padding:40px;">No matches</td></tr>';

    const countEl = document.getElementById('geoRowCount');
    if (countEl) {
        countEl.textContent =
            `${rows.length.toLocaleString()} ${_geoGranularity === 'state' ? 'states' : _geoGranularity === 'city' ? 'cities' : 'ZIPs'}` +
            ` · ${(shownUsers + (showUnknown ? unknown : 0)).toLocaleString()} users shown`;
    }
}

// ── controls ─────────────────────────────────────────────
function _setGranularity(gran) {
    _geoGranularity = gran;
    document.querySelectorAll('.geo-gran-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.gran === gran));
}

function wireUpGeoControls() {
    if (_geoControlsWired) return;
    _geoControlsWired = true;

    document.querySelectorAll('.geo-gran-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _setGranularity(btn.dataset.gran);
            renderGeoTable();
        });
    });

    const search = document.getElementById('geoSearch');
    if (search) {
        let t = null;
        search.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(renderGeoTable, 250);
        });
    }

    document.querySelectorAll('.geo-sort').forEach(th => {
        th.addEventListener('click', () => {
            const key = th.dataset.key;
            if (_geoSort.key === key) {
                _geoSort.dir = _geoSort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                _geoSort.key = key;
                _geoSort.dir = (key === 'place' || key === 'state') ? 'asc' : 'desc';
            }
            renderGeoTable();
        });
    });
}
