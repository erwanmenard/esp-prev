// ==========================================================================
// Acoustic&Vibration - LOGIQUE CLIENT JAVASCRIPT
// ==========================================================================

let currentView = 'dashboard';
let activeHistoryMetric = 'anomaly_score';
let activeDeviceId = null;
let historyChart = null;
let currentApiKey = '';
let alertsFilter = 'open';

// Dictionnaire des libellés et unités pour l'affichage
const METRIC_CONFIG = {
    'anomaly_score': { label: 'Score anomalie IA', unit: 'pts' },
    'anomaly_threshold': { label: 'Seuil Détection IA', unit: 'seuil' },
    'vibration_peak': { label: 'Vibration pic', unit: 'm/s²' },
    'vibration_mean': { label: 'Vibration moyenne', unit: 'm/s²' },
    'sound_peak': { label: 'Sound peak', unit: 'raw' },
    'sound_mean': { label: 'Sound moyenne', unit: 'raw' }
};

// Initialisation au chargement de la page
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initChart();
    loadDashboard();
    loadDevices();
    loadThresholds();
    loadAlerts();

    // Actualisation automatique toutes les 4 secondes
    setInterval(() => {
        if (currentView === 'dashboard') {
            loadDashboard();
        } else if (currentView === 'devices') {
            loadDevices();
        } else if (currentView === 'alerts') {
            loadAlerts();
        }
    }, 4000);
});

// -------------------------------------------------------------
// NAVIGATION ONGLETS
// -------------------------------------------------------------
function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-item');
    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const viewTarget = btn.getAttribute('data-view');
            switchView(viewTarget);
        });
    });
}

function switchView(viewName) {
    currentView = viewName;

    // Mise a jour des boutons
    document.querySelectorAll('.nav-item').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-view') === viewName);
    });

    // Affichage de la vue
    document.querySelectorAll('.content-view').forEach(v => {
        v.classList.remove('active');
    });

    const activeSection = document.getElementById(`view-${viewName}`);
    if (activeSection) {
        activeSection.classList.add('active');
    }

    if (viewName === 'dashboard') {
        loadDashboard();
    } else if (viewName === 'devices') {
        loadDevices();
    } else if (viewName === 'alerts') {
        loadThresholds();
        loadAlerts();
    }
}

let currentHistoryPoints = [];

// -------------------------------------------------------------
// GRAPHIQUE HISTORIQUE (CHART.JS)
// -------------------------------------------------------------
function initChart() {
    const ctx = document.getElementById('historyChart').getContext('2d');

    // Dégradé sous la courbe
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

    historyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Mesure',
                data: [],
                borderColor: '#10b981',
                backgroundColor: gradient,
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#10b981',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 2,
                fill: true,
                tension: 0.35
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            onClick: (e) => {
                if (!historyChart) return;
                const points = historyChart.getElementsAtEventForMode(e, 'nearest', { intersect: false }, true);
                if (points.length > 0) {
                    const idx = points[0].index;
                    const ptData = currentHistoryPoints[idx];
                    if (ptData) {
                        openAlertDetailsModal(ptData);
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#111724',
                    titleColor: '#94a3b8',
                    bodyColor: '#f8fafc',
                    borderColor: '#1e293b',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: function(context) {
                            const conf = METRIC_CONFIG[activeHistoryMetric] || { unit: 'pts' };
                            const idx = context.dataIndex;
                            const pt = currentHistoryPoints[idx];
                            if (pt && (pt.status === 'ALERTE' || pt.score >= pt.threshold)) {
                                return [
                                    `🚨 ALERTE : ${context.parsed.y} ${conf.unit}`,
                                    `Origine : ${pt.alert_origin || 'Vibration/Son'}`,
                                    `Diagnostic : ${pt.diagnostic || 'Anomalie'}`,
                                    `👉 Cliquez pour voir les détails RMS`
                                ];
                            }
                            return `${context.parsed.y} ${conf.unit}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.03)' },
                    ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 11 } }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#64748b', font: { size: 11 } }
                }
            }
        }
    });
}

function updateChart(labels, data, metricName, pointsMetadata) {
    if (!historyChart) return;
    currentHistoryPoints = pointsMetadata || [];
    const conf = METRIC_CONFIG[metricName] || { label: 'Score IA', unit: 'pts' };

    // Détection des alertes pour les afficher en rouge vif cliquable
    const pointRadii = currentHistoryPoints.map(p => (p && (p.status === 'ALERTE' || p.score >= p.threshold)) ? 6 : 0);
    const pointColors = currentHistoryPoints.map(p => (p && (p.status === 'ALERTE' || p.score >= p.threshold)) ? '#ef4444' : '#10b981');
    const pointHoverRadii = currentHistoryPoints.map(p => (p && (p.status === 'ALERTE' || p.score >= p.threshold)) ? 9 : 6);

    historyChart.data.labels = labels;
    historyChart.data.datasets[0].label = `${conf.label} (${conf.unit})`;
    historyChart.data.datasets[0].data = data;
    historyChart.data.datasets[0].pointRadius = pointRadii;
    historyChart.data.datasets[0].pointBackgroundColor = pointColors;
    historyChart.data.datasets[0].pointHoverRadius = pointHoverRadii;
    historyChart.update('none'); // mise a jour sans saccade
}

function openAlertDetailsModal(p) {
    if (!p) return;
    document.getElementById('alertDetailDevice').textContent = p.device_name || 'Capteur';
    document.getElementById('alertDetailTime').textContent = formatFullDateTime(p.timestamp);

    const isAlert = (p.status === 'ALERTE' || p.score >= p.threshold);
    const badge = document.getElementById('alertDetailOriginBadge');
    badge.textContent = p.alert_origin ? p.alert_origin.toUpperCase() : (isAlert ? 'ALERTE IA' : 'NORMAL');
    badge.style.background = isAlert ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)';
    badge.style.color = isAlert ? '#ef4444' : '#10b981';
    badge.style.borderColor = isAlert ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)';

    document.getElementById('alertDetailScore').textContent = `${formatNumber(p.score)} pts`;
    document.getElementById('alertDetailThreshold').textContent = `${p.threshold} pts`;
    document.getElementById('alertDetailDiagnostic').textContent = p.diagnostic || (isAlert ? 'Anomalie détectée' : 'Fonctionnement nominal');

    document.getElementById('alertDetailVibRms').textContent = (p.vibration_rms !== undefined && p.vibration_rms > 0) ? `${p.vibration_rms.toFixed(4)} m/s²` : '--';
    document.getElementById('alertDetailVibPeak').textContent = (p.vibration_peak !== undefined && p.vibration_peak > 0) ? `${p.vibration_peak.toFixed(4)} m/s²` : '--';
    document.getElementById('alertDetailSoundRms').textContent = (p.sound_rms !== undefined && p.sound_rms > 0) ? `${p.sound_rms.toFixed(1)} raw` : '--';

    openModal('modalAlertDetails');
}

// Fonctions utilitaires de date/heure (fuseau horaire local automatique)
function parseDateSafe(ts) {
    if (!ts) return null;
    if (typeof ts === 'number') return new Date(ts);
    let str = String(ts).trim();
    if (!str) return null;
    // Si la chaîne est au format "YYYY-MM-DD HH:mm:ss" sans Z, on ajoute Z pour interpréter en UTC
    if (!str.includes('Z') && !str.includes('+') && !str.slice(10).includes('-')) {
        str = str.replace(' ', 'T') + 'Z';
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

function formatTime(ts) {
    const d = parseDateSafe(ts);
    if (!d) return '--:--:--';
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatCardDateTime(ts) {
    const d = parseDateSafe(ts);
    if (!d) return '--:--';
    const dayMonth = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${dayMonth}, ${time}`;
}

function formatFullDateTime(ts) {
    const d = parseDateSafe(ts);
    if (!d) return 'jamais';
    const date = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${date} à ${time}`;
}

// -------------------------------------------------------------
// TABLEAU DE BORD : CHARGEMENT DES DONNÉES
// -------------------------------------------------------------
async function loadDashboard() {
    try {
        const response = await fetch('/api/telemetry/latest');
        const data = await response.json();

        // 1. Horodatage et badge
        document.getElementById('lastSyncTime').textContent = formatTime(data.last_sync || Date.now());

        // 2. Cartes KPI
        document.getElementById('kpiDevices').textContent = data.kpis.devices_online_ratio;
        document.getElementById('kpiSensors').textContent = data.kpis.sensors_tracked;
        document.getElementById('kpiAlerts').textContent = data.kpis.open_alerts;

        // 3. Bannière d'alerte
        const banner = document.getElementById('alertBanner');
        const bannerText = document.getElementById('alertBannerText');
        if (data.alerts && data.alerts.length > 0) {
            banner.className = 'alert-banner danger';
            bannerText.textContent = `Alerte active : ${data.alerts[0].device_name} — ${METRIC_CONFIG[data.alerts[0].metric]?.label || data.alerts[0].metric} (${data.alerts[0].value})`;
        } else {
            banner.className = 'alert-banner normal';
            bannerText.textContent = 'Aucune alerte active.';
        }

        // 4. Cartes des 4 dernières valeurs
        renderLatestCards(data.cards);

        // 5. Chargement de l'historique pour le graphique
        loadHistory();

    } catch (err) {
        console.error("Erreur de synchronisation :", err);
    }
}

let activeDeviceName = '';

function renderLatestCards(cards) {
    const grid = document.getElementById('latestValuesGrid');
    if (!cards || cards.length === 0) {
        grid.innerHTML = '<div class="empty-state">En attente des mesures envoyées par le Raspberry Pi...</div>';
        renderHistoryPills('Appareil');
        return;
    }

    // On sélectionne l'appareil actif
    const activeCard = (activeDeviceName ? cards.find(c => c.device_name === activeDeviceName) : null) || cards[0];
    activeDeviceName = activeCard.device_name;

    const isAlert = (activeCard.status === 'ALERTE' || activeCard.anomaly_score >= (activeCard.anomaly_threshold || 8.0));
    const items = [
        { key: 'anomaly_score', val: activeCard.anomaly_score, label: 'Score IA actuel', unit: 'pts', alert: isAlert },
        { key: 'anomaly_threshold', val: activeCard.anomaly_threshold || 8.0, label: 'Seuil Détection IA', unit: 'seuil' },
        { key: 'status', val: isAlert ? '🚨 ALERTE' : '✅ NORMAL', label: 'Statut Détection', unit: '', isStatus: true, alert: isAlert },
        { key: 'connection_type', val: activeCard.connection_type || '4G LTE', label: 'Liaison Réseau', unit: '', isConn: true }
    ];

    grid.innerHTML = items.map(item => `
        <div class="metric-card ${item.alert ? 'alert-active' : ''}">
            <div class="metric-top">
                <span>${activeCard.device_name}</span>
                <span class="metric-time">${formatCardDateTime(activeCard.timestamp)}</span>
            </div>
            <div class="metric-main">
                <span class="metric-number ${item.alert ? 'text-danger' : ''}">${typeof item.val === 'number' ? formatNumber(item.val) : item.val}</span>
                <span class="metric-unit">${item.unit}</span>
            </div>
            <div class="metric-label">${item.label}</div>
        </div>
    `).join('');

    renderHistoryPills(activeCard.device_name);
}

function renderHistoryPills(deviceName) {
    const container = document.getElementById('historyFilterPills');
    const pills = [
        { metric: 'anomaly_score', label: `${deviceName} · Score Anomalie IA (pts)` },
        { metric: 'anomaly_threshold', label: `${deviceName} · Seuil Détection IA` }
    ];

    container.innerHTML = pills.map(p => `
        <button class="pill-btn ${p.metric === activeHistoryMetric ? 'active' : ''}" 
                onclick="selectHistoryMetric('${p.metric}')">
            ${p.label}
        </button>
    `).join('');
}

function selectHistoryMetric(metric) {
    activeHistoryMetric = metric;
    document.querySelectorAll('.pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase().includes(METRIC_CONFIG[metric]?.label.toLowerCase()));
    });
    loadHistory();
}

async function loadHistory() {
    try {
        let url = `/api/telemetry/history?metric=${activeHistoryMetric}&limit=200`;
        if (activeDeviceName) {
            url += `&device_name=${encodeURIComponent(activeDeviceName)}`;
        }
        const res = await fetch(url);
        const data = await res.json();
        
        document.getElementById('historyPointsCount').textContent = `${data.count} points`;
        const formattedLabels = (data.labels || []).map(ts => {
            if (typeof ts === 'string' && ts.length <= 8 && ts.includes(':')) return ts;
            return formatTime(ts);
        });
        updateChart(formattedLabels, data.values, activeHistoryMetric, data.points);
    } catch (err) {
        console.error("Erreur chargement historique :", err);
    }
}

// -------------------------------------------------------------
// VUE APPAREILS
// -------------------------------------------------------------
let cachedDevices = [];
let currentEditingDevice = null;

async function loadDevices() {
    try {
        const res = await fetch('/api/devices');
        const devices = await res.json();
        cachedDevices = devices;

        // Mettre à jour le select de seuils
        const thSelect = document.getElementById('thDeviceSelect');
        if (thSelect) {
            thSelect.innerHTML = devices.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
        }

        const list = document.getElementById('devicesList');
        if (devices.length === 0) {
            list.innerHTML = '<div class="empty-state">Aucun appareil détecté. Démarrez un capteur ou la passerelle 4G pour l\'enregistrer.</div>';
            return;
        }

        list.innerHTML = devices.map(d => {
            const isOnline = d.is_online;
            const thresholdDisplay = d.anomaly_threshold !== undefined ? `${d.anomaly_threshold} pts` : '8.0 pts';
            const machineDisplay = d.machine_name ? `<div class="device-machine" style="color:#94a3b8; font-size:12px; margin-top:2px;">⚙️ Machine : <strong style="color:#e2e8f0;">${d.machine_name}</strong></div>` : '';
            const macDisplay = d.mac ? `<span style="font-family:monospace; font-size:11px; color:#64748b; margin-left:8px;">[${d.mac}]</span>` : '';

            return `
                <div class="device-card">
                    <div>
                        <div class="device-header">
                            <div class="device-title-row" style="flex-wrap: wrap; gap: 6px; align-items: center;">
                                <span class="status-dot ${isOnline ? 'online' : ''}"></span>
                                <span class="device-name">${d.name}</span>
                                ${formatConnectionTag(d.connection_type)}
                                ${macDisplay}
                            </div>
                        </div>
                        ${machineDisplay}
                        <div class="device-location" style="margin-top: 4px;">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                            ${d.location || 'Emplacement non précisé'}
                            <span style="display:inline-block; margin-left:12px; background:rgba(16,185,129,0.12); color:#10b981; border:1px solid rgba(16,185,129,0.25); border-radius:4px; padding:1px 6px; font-size:11px; font-weight:600;">
                                Seuil IA : ${thresholdDisplay}
                            </span>
                        </div>
                        <div class="device-status-text" style="margin-top: 6px;">
                            ${isOnline ? '<span style="color:#10b981; font-weight:600;">● En ligne</span> · actif maintenant' : '<span style="color:#64748b;">○ Hors ligne</span>'} · dernière mesure : ${d.last_seen || (d.last_seen_ts ? formatFullDateTime(d.last_seen_ts) : 'jamais')}
                        </div>
                    </div>
                    <div class="device-actions" style="display:flex; align-items:center; gap:8px;">
                        <button class="btn btn-secondary btn-sm" onclick="triggerCalibration('${d.id}', '${d.mac || ''}', this)" title="Lancer une calibration automatique de 10 secondes" style="padding:4px 9px; font-size:11px; display:inline-flex; align-items:center; gap:4px; border-radius:6px;">
                            🎯 Calibrer (10s)
                        </button>
                        <button class="btn-icon" onclick="openEditDeviceModal('${d.id}')" title="Modifier cet appareil" style="color:#38bdf8;">
                            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button class="btn-icon" onclick="deleteDevice('${d.id}')" title="Supprimer cet appareil" style="color:#ef4444;">
                            <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error("Erreur chargement appareils :", err);
    }
}

function formatValidMac(str) {
    if (!str) return "";
    const clean = String(str).trim();
    if (/^([0-9A-Fa-f]{2}[:_]){5}([0-9A-Fa-f]{2})$/.test(clean)) {
        return clean.replace(/_/g, ':').toUpperCase();
    }
    return "";
}

function openEditDeviceModal(id) {
    const d = cachedDevices.find(item => String(item.id) === String(id));
    if (!d) return;
    currentEditingDevice = d;

    const validMac = formatValidMac(d.mac) || formatValidMac(d.id);

    document.getElementById('editDeviceId').value = d.id;
    document.getElementById('editDeviceMac').value = validMac || (d.mac ? d.mac : "En attente de paquet ESP-NOW...");
    document.getElementById('editDeviceName').value = d.name || "";
    document.getElementById('editDeviceMachine').value = d.machine_name || "";
    document.getElementById('editDeviceLocation').value = d.location || "";
    document.getElementById('editDeviceThreshold').value = (d.anomaly_threshold !== undefined && d.anomaly_threshold !== null) ? d.anomaly_threshold : 8.0;

    openModal('modalEditDevice');
}

async function handleUpdateDevice(e) {
    e.preventDefault();
    const id = document.getElementById('editDeviceId').value;
    const name = document.getElementById('editDeviceName').value.trim();
    const machine_name = document.getElementById('editDeviceMachine').value.trim();
    const location = document.getElementById('editDeviceLocation').value.trim();
    const anomaly_threshold = parseFloat(document.getElementById('editDeviceThreshold').value);
    const mac = document.getElementById('editDeviceMac').value.trim();

    const btn = document.getElementById('btnSaveDevice');
    const oldText = btn.textContent;
    btn.textContent = "Transmission en cours...";
    btn.disabled = true;

    try {
        const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                machine_name,
                location,
                anomaly_threshold,
                mac
            })
        });

        if (res.ok) {
            closeModal('modalEditDevice');
            await loadDevices();
            await loadDashboard();
        } else {
            const err = await res.json();
            alert(err.error || "Erreur lors de la mise à jour");
        }
    } catch (err) {
        alert("Erreur de connexion : " + err.message);
    } finally {
        btn.textContent = oldText;
        btn.disabled = false;
    }
}

async function triggerCalibration(id, mac, btnElement) {
    if (!confirm("Lancer l'auto-calibration de 10 secondes sur cet appareil ?\n\nAssurez-vous que la machine tourne à son régime nominal sain pendant l'opération.")) {
        return;
    }
    try {
        if (btnElement) {
            btnElement.disabled = true;
            btnElement.innerHTML = `⏳ Envoi de l'ordre...`;
        }

        const res = await fetch(`/api/devices/${encodeURIComponent(id)}/calibrate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac })
        });
        const data = await res.json();
        if (res.ok) {
            if (btnElement) {
                let count = 15;
                btnElement.innerHTML = `⏳ Calib en cours (${count}s)...`;
                const timer = setInterval(async () => {
                    count--;
                    if (count > 0) {
                        btnElement.innerHTML = `⏳ Calib en cours (${count}s)...`;
                    } else {
                        clearInterval(timer);
                        btnElement.innerHTML = `✅ Mise à jour...`;
                        await loadDevices();
                        await loadDashboard();
                        setTimeout(() => {
                            btnElement.disabled = false;
                            btnElement.innerHTML = `🎯 Calibrer (10s)`;
                        }, 2500);
                    }
                }, 1000);
            } else {
                alert("🎯 Ordre de calibration envoyé avec succès !\nL'esclave va allumer sa LED blanche pendant 10s, mesurer les baselines saines et enregistrer le nouveau seuil en flash NVS.");
                setTimeout(() => { loadDevices(); loadDashboard(); }, 15000);
            }
        } else {
            if (btnElement) {
                btnElement.disabled = false;
                btnElement.innerHTML = `🎯 Calibrer (10s)`;
            }
            alert(data.error || "Erreur lors du déclenchement de la calibration");
        }
    } catch (err) {
        if (btnElement) {
            btnElement.disabled = false;
            btnElement.innerHTML = `🎯 Calibrer (10s)`;
        }
        alert("Erreur de connexion : " + err.message);
    }
}

async function handleCreateDevice(e) {
    e.preventDefault();
    const name = document.getElementById('newDeviceName').value;
    const location = document.getElementById('newDeviceLocation').value;
    const connection_type = document.getElementById('newDeviceType').value;

    const res = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, location, connection_type })
    });

    if (res.ok) {
        closeModal('modalAddDevice');
        document.getElementById('newDeviceName').value = '';
        document.getElementById('newDeviceLocation').value = '';
        loadDevices();
    } else {
        const err = await res.json();
        alert(err.error || "Erreur lors de la création");
    }
}

async function toggleDeviceActive(id, isActive) {
    await fetch(`/api/devices/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: isActive })
    });
}

async function deleteDevice(id) {
    if (confirm("Supprimer cet appareil et toutes ses mesures ?")) {
        await fetch(`/api/devices/${id}`, { method: 'DELETE' });
        loadDevices();
        loadDashboard();
    }
}

// -------------------------------------------------------------
// VUE SEUILS & ALERTES
// -------------------------------------------------------------
async function loadThresholds() {
    try {
        const res = await fetch('/api/thresholds');
        const thresholds = await res.json();
        const list = document.getElementById('thresholdsList');

        if (thresholds.length === 0) {
            list.innerHTML = '<div class="empty-state">Aucun seuil défini. Ajoutez-en un ci-dessus.</div>';
            return;
        }

        list.innerHTML = thresholds.map(t => {
            const metricName = METRIC_CONFIG[t.metric]?.label || t.metric;
            return `
                <div class="threshold-item">
                    <div class="th-left">
                        <strong>${t.device_name} · ${metricName} ${t.condition} ${formatNumber(t.threshold_value)}</strong>
                        <span>${t.is_active ? 'Surveillance active' : 'Surveillance désactivée'}</span>
                    </div>
                    <div class="th-right">
                        <label class="toggle-switch">
                            <input type="checkbox" ${t.is_active ? 'checked' : ''} onchange="toggleThresholdActive(${t.id}, this.checked)">
                            <span class="slider"></span>
                        </label>
                        <button class="btn-icon" onclick="deleteThreshold(${t.id})" title="Supprimer">
                            <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error("Erreur chargement seuils :", err);
    }
}

async function handleCreateThreshold(e) {
    e.preventDefault();
    const device_id = document.getElementById('thDeviceSelect').value;
    const metric = document.getElementById('thMetricSelect').value;
    const condition = document.getElementById('thConditionSelect').value;
    const threshold_value = document.getElementById('thValueInput').value;

    const res = await fetch('/api/thresholds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id, metric, condition, threshold_value })
    });

    if (res.ok) {
        document.getElementById('thValueInput').value = '';
        loadThresholds();
    }
}

async function toggleThresholdActive(id, isActive) {
    await fetch(`/api/thresholds/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: isActive })
    });
    loadThresholds();
}

async function deleteThreshold(id) {
    if (confirm("Supprimer cette règle de seuil ?")) {
        await fetch(`/api/thresholds/${id}`, { method: 'DELETE' });
        loadThresholds();
    }
}

// ALERTES
async function loadAlerts() {
    try {
        const url = alertsFilter === 'open' ? '/api/alerts?status=open' : '/api/alerts';
        const res = await fetch(url);
        const alerts = await res.json();
        const list = document.getElementById('alertsList');

        if (alerts.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none"><polyline points="20 6 9 17 4 12"/></svg>
                    Aucune alerte à afficher pour le moment.
                </div>
            `;
            return;
        }

        list.innerHTML = alerts.map(a => {
            const metricName = METRIC_CONFIG[a.metric]?.label || a.metric;
            const isResolved = a.status === 'resolved';
            return `
                <div class="alert-row ${isResolved ? 'resolved' : ''}">
                    <div>
                        <strong style="color:${isResolved ? '#94a3b8' : '#ef4444'};">
                            ${a.device_name} — Dépassement de seuil (${metricName})
                        </strong>
                        <div style="font-size:0.8rem; color:#64748b; margin-top:2px;">
                            Valeur relevée : ${formatNumber(a.value)} (${a.condition} ${formatNumber(a.threshold_value)}) · ${a.timestamp}
                        </div>
                    </div>
                    <div>
                        ${!isResolved ? `
                            <button class="btn btn-secondary btn-sm" onclick="resolveAlert(${a.id})">
                                Acquitter
                            </button>
                        ` : '<span style="font-size:0.8rem; color:#10b981;">Acquittée</span>'}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error("Erreur chargement alertes :", err);
    }
}

function filterAlerts(filter) {
    alertsFilter = filter;
    document.getElementById('tabAlertsOpen').classList.toggle('active', filter === 'open');
    document.getElementById('tabAlertsAll').classList.toggle('active', filter === 'all');
    loadAlerts();
}

async function resolveAlert(id) {
    await fetch(`/api/alerts/${id}/resolve`, { method: 'POST' });
    loadAlerts();
    loadDashboard();
}

// -------------------------------------------------------------
// MODALES & UTILITAIRES
// -------------------------------------------------------------
function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
}

function openAddDeviceModal() {
    openModal('modalAddDevice');
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}

function showApiKey(key) {
    currentApiKey = key;
    document.getElementById('displayApiKey').textContent = key;
    document.querySelectorAll('.code-key-placeholder').forEach(el => el.textContent = key);
    document.getElementById('modalApiKey').classList.remove('hidden');
}

function copyApiKey() {
    navigator.clipboard.writeText(currentApiKey).then(() => {
        alert("Clé API copiée dans le presse-papier !");
    });
}

function formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return Number(num).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

function formatConnectionTag(type) {
    if (!type) return '<span class="type-tag">📶 4G</span>';
    const t = type.toLowerCase();
    if (t.includes('wifi') || t.includes('wi-fi')) return '<span class="type-tag">📡 WiFi</span>';
    if (t.includes('eth')) return '<span class="type-tag">🔌 Ethernet</span>';
    if (t.includes('4g')) return '<span class="type-tag">📶 4G</span>';
    return `<span class="type-tag">📶 ${type}</span>`;
}

// -------------------------------------------------------------
// MENU UTILISATEUR & GESTION DU THÈME (CAPTURE D'ÉCRAN 5)
// -------------------------------------------------------------
function toggleUserMenu() {
    const popup = document.getElementById('userMenuPopup');
    if (popup) {
        popup.classList.toggle('hidden');
    }
}

// Fermer le menu si clic en dehors
document.addEventListener('click', (e) => {
    const popup = document.getElementById('userMenuPopup');
    const userPill = document.querySelector('.user-pill.clickable');
    if (popup && !popup.classList.contains('hidden')) {
        if (!popup.contains(e.target) && !userPill.contains(e.target)) {
            popup.classList.add('hidden');
        }
    }
});

function handleMenuClick(action) {
    const popup = document.getElementById('userMenuPopup');
    if (popup) popup.classList.add('hidden');

    if (action === 'devices') {
        switchView('devices');
    } else if (action === 'alerts') {
        switchView('alerts');
    }
}

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    const label = document.getElementById('themeLabel');
    const icon = document.getElementById('themeIcon');

    if (isLight) {
        label.textContent = 'Thème sombre';
        // Icone lune
        icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
        localStorage.setItem('Acoustic&Vibration_theme', 'light');
    } else {
        label.textContent = 'Thème clair';
        // Icone soleil
        icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
        localStorage.setItem('Acoustic&Vibration_theme', 'dark');
    }

    // Réinitialiser le dégradé du graphique selon le thème
    if (historyChart) {
        historyChart.update();
    }
}

// Restaurer la préférence de thème au chargement
(function checkSavedTheme() {
    if (localStorage.getItem('Acoustic&Vibration_theme') === 'light') {
        document.body.classList.add('light-theme');
        const label = document.getElementById('themeLabel');
        const icon = document.getElementById('themeIcon');
        if (label && icon) {
            label.textContent = 'Thème sombre';
            icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
        }
    }
})();

