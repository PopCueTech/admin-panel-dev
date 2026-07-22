// ═════════════════════════════════════════════════════════
// PANELS MANAGEMENT
// ═════════════════════════════════════════════════════════

async function showPanels() {
    hideAllSections();
    document.getElementById('panelsSection').style.display = 'block';
    setActiveTab('panels');
    await loadPanelsList();
}

async function loadPanelsList() {
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/panels`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const panels = await response.json();

        let html = '';
        if (panels.length === 0) {
            html = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: #999;">No panels created yet</td></tr>';
        } else {
            html = panels.map(p => `
                <tr>
                    <td><strong>${p.name}</strong></td>
                    <td><span class="panel-code-badge">${p.panel_code}</span></td>
                    <td>${p.member_count || 0}</td>
                    <td><span class="badge ${p.is_active ? 'badge-success' : 'badge-warning'}">${p.is_active ? 'Active' : 'Inactive'}</span></td>
                    <td style="font-size: 12px; display: flex; gap: 4px; flex-wrap: wrap;">
                        <button type="button" class="btn btn-ghost-brand btn-sm" onclick="showPanelQR('${p.id}', '${p.panel_code}', '${p.name.replace(/'/g, "\\'")}')" title="Show QR Code">⬛ QR</button>
                        <button type="button" class="btn btn-ghost btn-sm" onclick="regeneratePanelCode('${p.id}')" title="Regenerate Code">⟲ Code</button>
                        <button type="button" class="btn btn-ghost btn-sm" onclick="togglePanelStatus('${p.id}', ${!p.is_active})" title="${p.is_active ? 'Deactivate' : 'Activate'}">${p.is_active ? 'Deactivate' : 'Activate'}</button>
                        <button type="button" class="btn btn-ghost btn-sm" style="color: #c62828;" onclick="deletePanel('${p.id}')" title="Delete">Delete</button>
                    </td>
                </tr>
            `).join('');
        }
        document.getElementById('panelsTableBody').innerHTML = html;
    } catch (error) {
        showToast(`Failed to load panels: ${error.message}`, 'error');
        console.error(error);
    }
}

function openCreatePanelModal() {
    document.getElementById('panelModalTitle').textContent = 'Create Panel';
    document.getElementById('panelForm').reset();
    document.getElementById('panelModalSubmitBtn').textContent = 'Create';
    document.getElementById('panelModal').style.display = 'flex';
}

function closePanelModal() {
    document.getElementById('panelModal').style.display = 'none';
}

document.getElementById('panelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('panelName').value;
    const description = document.getElementById('panelDescription').value;

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/panels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description: description || null })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        closePanelModal();
        showToast('Panel created successfully', 'success');
        await loadPanelsList();
    } catch (error) {
        showToast(`Failed to create panel: ${error.message}`, 'error');
    }
});

async function regeneratePanelCode(panelId) {
    if (!confirm('Generate a new panel code? The old code will stop working.')) return;
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/panels/${panelId}/regenerate-code`, { method: 'POST' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        showToast(`New code: ${data.new_code}`, 'success');
        await loadPanelsList();
    } catch (error) {
        showToast(`Failed to regenerate code: ${error.message}`, 'error');
    }
}

async function togglePanelStatus(panelId, isActive) {
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/panels/${panelId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: isActive })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        showToast(isActive ? 'Panel activated' : 'Panel deactivated', 'success');
        await loadPanelsList();
    } catch (error) {
        showToast(`Failed to update panel: ${error.message}`, 'error');
    }
}

async function deletePanel(panelId) {
    if (!confirm('Delete this panel and all memberships?')) return;
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/panels/${panelId}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        showToast('Panel deleted', 'success');
        await loadPanelsList();
    } catch (error) {
        showToast(`Failed to delete panel: ${error.message}`, 'error');
    }
}

async function loadPanelsForSurveyForm() {
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/panels`);
        if (!response.ok) return;
        const panels = await response.json();
        const select = document.getElementById('surveyPanel');
        const currentValue = select.value;
        select.innerHTML = '<option value="">— Public survey (no panel restriction) —</option>';
        panels.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.member_count || 0} members)`;
            select.appendChild(opt);
        });
        select.value = currentValue;
    } catch (error) {
        console.error('Failed to load panels:', error);
    }
}

// Wire up tenant change to reload panels
if (document.getElementById('tenantId')) {
    document.getElementById('tenantId').addEventListener('change', loadPanelsForSurveyForm);
}


// ═════════════════════════════════════════════════════════
// QR CODE GENERATION
// ═════════════════════════════════════════════════════════

// Track the currently displayed panel code for copy/download
let _currentQRCode = '';
let _currentQRPanelName = '';

function showPanelQR(_panelId, panelCode, panelName) {
    _currentQRCode = panelCode;
    _currentQRPanelName = panelName;

    // Update modal text
    document.getElementById('panelQRTitle').textContent = panelName;
    document.getElementById('panelQRSubtitle').textContent = 'Scan with the PopCue app to join this panel';
    document.getElementById('panelQRCode').textContent = panelCode;

    // Clear previous canvas
    const container = document.getElementById('panelQRCanvas');
    container.innerHTML = '';

    // Create canvas element for QR
    const canvas = document.createElement('canvas');
    canvas.id = 'qrCanvas';
    container.appendChild(canvas);

    // Generate QR code — plain text content is just the 7-char code
    QRCode.toCanvas(canvas, panelCode, {
        width: 240,
        margin: 2,
        color: {
            dark: '#1a1a2e',   // Dark navy dots
            light: '#ffffff',  // White background
        },
        errorCorrectionLevel: 'M',
    }, (err) => {
        if (err) {
            container.innerHTML = '<p style="color: #c62828; font-size: 13px;">Failed to generate QR code.</p>';
            console.error('QR generation error:', err);
        }
    });

    // Show modal
    document.getElementById('panelQRModal').style.display = 'flex';
}

function closePanelQRModal() {
    document.getElementById('panelQRModal').style.display = 'none';
    _currentQRCode = '';
    _currentQRPanelName = '';
}

function downloadPanelQR() {
    const canvas = document.getElementById('qrCanvas');
    if (!canvas) return;

    // Create a new canvas with padding and label
    const padding = 24;
    const labelHeight = 64;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width + padding * 2;
    exportCanvas.height = canvas.height + padding * 2 + labelHeight;

    const ctx = exportCanvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    // Draw the QR code
    ctx.drawImage(canvas, padding, padding);

    // Draw panel code text below
    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(_currentQRCode, exportCanvas.width / 2, canvas.height + padding + 30);

    // Draw panel name below code
    ctx.fillStyle = '#666666';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(_currentQRPanelName, exportCanvas.width / 2, canvas.height + padding + 52);

    // Trigger download
    const link = document.createElement('a');
    link.download = `panel-qr-${_currentQRCode}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();

    showToast('QR code downloaded!', 'success');
}

function copyPanelCode() {
    if (!_currentQRCode) return;
    navigator.clipboard.writeText(_currentQRCode).then(() => {
        const btn = document.getElementById('panelQRCopyBtn');
        const original = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => btn.textContent = original, 2000);
    }).catch(() => {
        showToast('Could not copy. Code: ' + _currentQRCode, 'info');
    });
}
