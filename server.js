/**
 * =============================================================================
 * SENTINELLE - SERVEUR NODE.JS (EXPRESS + FIREBASE REALTIME DATABASE)
 * =============================================================================
 * Connecté à Firebase Realtime Database avec sécurisation via variables d'env (.env).
 * =============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_URL = process.env.FIREBASE_DATABASE_URL || "https://detection-son-vibration-default-rtdb.europe-west1.firebasedatabase.app";

// Middlewares
app.use(cors());
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'static')));

// -------------------------------------------------------------
// INITIALISATION FIREBASE (REALTIME DATABASE)
// -------------------------------------------------------------
let db = null;
let isFirebaseConnected = false;

try {
    const admin = require('firebase-admin');
    const serviceAccountPath = path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'serviceAccountKey.json');

    if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: DB_URL
        });
        db = admin.database();
        isFirebaseConnected = true;
        console.log("🔥 Connecté à Firebase Realtime Database avec succès !");
        console.log(`📡 URL : ${DB_URL}`);
    } else if (process.env.FIREBASE_CONFIG_JSON) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: DB_URL
        });
        db = admin.database();
        isFirebaseConnected = true;
        console.log("🔥 Connecté à Firebase Realtime Database via variable d'environnement !");
    } else {
        console.log("ℹ️ En attente de serviceAccountKey.json : mode mémoire temporaire actif.");
    }
} catch (err) {
    console.error("Erreur d'initialisation Firebase :", err.message);
}

// -------------------------------------------------------------
// DONNÉES EN MÉMOIRE (MODE SECOURS SI PAS ENCORE DE CLÉ)
// -------------------------------------------------------------
let localDevices = [
    {
        id: "loc67",
        name: "Local 67",
        location: "Emplacement non précisé",
        connection_type: "WiFi",
        api_key: "sentinelle_loc67_master",
        is_active: 1,
        last_seen: new Date().toISOString().replace('T', ' ').substring(0, 19)
    }
];

let localThresholds = [
    {
        id: "th1",
        device_id: "loc67",
        device_name: "Local 67",
        metric: "sound_peak",
        condition: "supérieur à",
        threshold_value: 2000.0,
        is_active: 1
    }
];

let localTelemetry = [];
let localAlerts = [];

// Données de démonstration initiales
(function initDemoData() {
    const now = Date.now();
    for (let i = 40; i >= 0; i--) {
        const t = new Date(now - i * 30000);
        const tStr = t.toISOString().replace('T', ' ').substring(0, 19);
        const vib_peak = (i === 1) ? 1.95 : (i === 20 ? 1.25 : +(0.05 + (i % 5) * 0.02).toFixed(2));
        localTelemetry.push({
            id: "tel_" + (localTelemetry.length + 1),
            device_name: "Local 67",
            timestamp: tStr,
            vibration_peak: vib_peak,
            vibration_mean: 0.17,
            sound_peak: (i === 1) ? 529.9 : +(150 + (i % 7) * 20).toFixed(1),
            sound_mean: 137.1,
            kurtosis: 2.8,
            rms: 1.12,
            anomaly_score: 12.0,
            status: "NORMAL"
        });
    }
})();

// -------------------------------------------------------------
// ROUTE PRINCIPALE
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

// -------------------------------------------------------------
// API : APPAREILS
// -------------------------------------------------------------
app.get('/api/devices', async (req, res) => {
    try {
        const now = Date.now();
        if (isFirebaseConnected) {
            const snapshot = await db.ref('devices').once('value');
            const data = snapshot.val() || {};
            const list = Object.keys(data).map(key => {
                const item = data[key];
                const lastSeenTime = item.last_seen ? new Date(item.last_seen).getTime() : 0;
                return { id: key, ...item, is_online: (now - lastSeenTime) < 60000 };
            });
            // Si aucun appareil dans Firebase, on insère le device par défaut
            if (list.length === 0) {
                const defaultDev = localDevices[0];
                const ref = db.ref('devices').push();
                await ref.set(defaultDev);
                return res.json([{ id: ref.key, ...defaultDev, is_online: true }]);
            }
            return res.json(list);
        }

        const devices = localDevices.map(d => {
            const lastSeenTime = d.last_seen ? new Date(d.last_seen).getTime() : 0;
            return { ...d, is_online: (now - lastSeenTime) < 60000 };
        });
        res.json(devices);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/devices', async (req, res) => {
    const { name, location, connection_type } = req.body;
    if (!name) return res.status(400).json({ error: "Nom requis" });

    const newDevice = {
        name,
        location: location || "Emplacement non précisé",
        connection_type: connection_type || "WiFi",
        api_key: "sentinelle_" + Math.random().toString(36).substring(2, 10),
        is_active: 1,
        last_seen: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };

    if (isFirebaseConnected) {
        const ref = db.ref('devices').push();
        await ref.set(newDevice);
        return res.status(201).json({ success: true, id: ref.key, api_key: newDevice.api_key });
    }

    newDevice.id = "dev_" + (localDevices.length + 1);
    localDevices.push(newDevice);
    res.status(201).json({ success: true, id: newDevice.id, api_key: newDevice.api_key });
});

app.put('/api/devices/:id', async (req, res) => {
    const id = req.params.id;
    const updates = req.body;

    if (isFirebaseConnected) {
        await db.ref('devices').child(id).update(updates);
        return res.json({ success: true });
    }

    const dev = localDevices.find(d => String(d.id) === String(id));
    if (dev) Object.assign(dev, updates);
    res.json({ success: true });
});

app.delete('/api/devices/:id', async (req, res) => {
    const id = req.params.id;

    if (isFirebaseConnected) {
        await db.ref('devices').child(id).remove();
        return res.json({ success: true });
    }

    localDevices = localDevices.filter(d => String(d.id) !== String(id));
    res.json({ success: true });
});

// -------------------------------------------------------------
// API : TELEMETRIE (Raspberry Pi -> Serveur -> Firebase)
// -------------------------------------------------------------
app.post('/api/telemetry', async (req, res) => {
    const data = req.body || {};
    const apiKey = req.headers['x-api-key'] || data.api_key;
    const deviceName = data.device_name || "Local 67";
    const nowIso = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const record = {
        device_name: deviceName,
        api_key: apiKey || "none",
        timestamp: nowIso,
        vibration_peak: parseFloat(data.vibration_peak || 0),
        vibration_mean: parseFloat(data.vibration_mean || 0),
        sound_peak: parseFloat(data.sound_peak || 0),
        sound_mean: parseFloat(data.sound_mean || 0),
        kurtosis: parseFloat(data.kurtosis || 0),
        rms: parseFloat(data.rms || 0),
        anomaly_score: parseFloat(data.anomaly_score || 0),
        status: data.status || "NORMAL"
    };

    const alertsTriggered = [];

    if (isFirebaseConnected) {
        // Enregistrer dans Firebase
        await db.ref('telemetry').push(record);
        await db.ref('latest/' + deviceName).set(record);

        // Mettre à jour last_seen de l'appareil
        const devSnap = await db.ref('devices').once('value');
        const devVal = devSnap.val() || {};
        for (const devKey of Object.keys(devVal)) {
            if (devVal[devKey].name === deviceName) {
                await db.ref('devices/' + devKey).update({ last_seen: nowIso });
                break;
            }
        }

        // Vérification des seuils
        const thSnap = await db.ref('thresholds').once('value');
        const thVal = thSnap.val() || {};
        for (const k of Object.keys(thVal)) {
            const th = thVal[k];
            if (!th.is_active) continue;
            const val = record[th.metric];
            if (val !== undefined) {
                let isExceeded = false;
                if (th.condition === "supérieur à" && val > th.threshold_value) isExceeded = true;
                if (th.condition === "inférieur à" && val < th.threshold_value) isExceeded = true;
                if (isExceeded) {
                    await db.ref('alerts').push({
                        device_name: deviceName,
                        timestamp: nowIso,
                        metric: th.metric,
                        value: val,
                        threshold_value: th.threshold_value,
                        condition: th.condition,
                        status: 'open'
                    });
                    alertsTriggered.push(th.metric);
                }
            }
        }
    } else {
        // Mode mémoire local
        const dev = localDevices.find(d => d.name === deviceName || d.api_key === apiKey);
        if (dev) dev.last_seen = nowIso;

        localThresholds.forEach(th => {
            if (!th.is_active) return;
            const val = record[th.metric];
            if (val !== undefined) {
                let isExceeded = false;
                if (th.condition === "supérieur à" && val > th.threshold_value) isExceeded = true;
                if (th.condition === "inférieur à" && val < th.threshold_value) isExceeded = true;
                if (isExceeded) {
                    localAlerts.unshift({
                        id: "al_" + (localAlerts.length + 1),
                        device_name: deviceName,
                        timestamp: nowIso,
                        metric: th.metric,
                        value: val,
                        threshold_value: th.threshold_value,
                        condition: th.condition,
                        status: 'open'
                    });
                    alertsTriggered.push(th.metric);
                }
            }
        });
        localTelemetry.push({ id: "tel_" + (localTelemetry.length + 1), ...record });
        if (localTelemetry.length > 500) localTelemetry.shift();
    }

    res.json({
        success: true,
        timestamp: nowIso,
        alerts_triggered: alertsTriggered
    });
});

// -------------------------------------------------------------
// API : VALEURS RÉCENTES DU TABLEAU DE BORD
// -------------------------------------------------------------
app.get('/api/telemetry/latest', async (req, res) => {
    try {
        const now = Date.now();
        let devices = localDevices;
        let latest = localTelemetry[localTelemetry.length - 1] || {};
        let openAlerts = localAlerts.filter(a => a.status === 'open');

        if (isFirebaseConnected) {
            // Lecture des appareils
            const devSnap = await db.ref('devices').once('value');
            const devData = devSnap.val() || {};
            devices = Object.keys(devData).map(k => ({ id: k, ...devData[k] }));

            // Lecture de la dernière mesure
            const telSnap = await db.ref('telemetry').limitToLast(1).once('value');
            const telData = telSnap.val() || {};
            const keys = Object.keys(telData);
            if (keys.length > 0) latest = telData[keys[0]];

            // Alertes ouvertes (lecture directe et filtrage en mémoire pour éviter le warning d'index)
            const alSnap = await db.ref('alerts').once('value');
            const alData = alSnap.val() || {};
            openAlerts = Object.keys(alData)
                .map(k => ({ id: k, ...alData[k] }))
                .filter(a => a.status === 'open');
        }

        let onlineCount = 0;
        devices.forEach(d => {
            const lastSeen = d.last_seen ? new Date(d.last_seen).getTime() : 0;
            if ((now - lastSeen) < 60000) onlineCount++;
        });

        const cards = [];
        if (devices.length > 0) {
            const d = devices[0];
            const mois = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
            const dt = latest.timestamp ? new Date(latest.timestamp) : new Date();
            const timeDisplay = `${dt.getDate()} ${mois[dt.getMonth()]}, ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;

            cards.push({
                device_id: d.id,
                device_name: d.name,
                timestamp: latest.timestamp,
                time_display: timeDisplay,
                vibration_pic: latest.vibration_peak || 0,
                vibration_moyenne: latest.vibration_mean || 0,
                sound_peak: latest.sound_peak || 0,
                sound_moyenne: latest.sound_mean || 0,
                kurtosis: latest.kurtosis || 0,
                rms: latest.rms || 0,
                anomaly_score: latest.anomaly_score || 0
            });
        }

        const syncTime = new Date().toTimeString().split(' ')[0];

        res.json({
            kpis: {
                devices_online_ratio: `${onlineCount} / ${devices.length}`,
                sensors_tracked: devices.length * 4,
                open_alerts: openAlerts.length
            },
            cards: cards,
            alerts: openAlerts.slice(0, 5),
            last_sync: syncTime
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// -------------------------------------------------------------
// API : HISTORIQUE POUR CHART.JS
// -------------------------------------------------------------
app.get('/api/telemetry/history', async (req, res) => {
    const metric = req.query.metric || 'vibration_peak';
    const limit = parseInt(req.query.limit || '200');

    try {
        let rows = localTelemetry;
        if (isFirebaseConnected) {
            const snap = await db.ref('telemetry').limitToLast(limit).once('value');
            const data = snap.val() || {};
            rows = Object.keys(data).map(k => data[k]);
        }

        const slice = rows.slice(-limit);
        const labels = slice.map(r => r.timestamp ? (r.timestamp.split(' ')[1] || r.timestamp) : '');
        const values = slice.map(r => r[metric] !== undefined ? r[metric] : 0);

        res.json({
            metric,
            labels,
            values,
            count: values.length
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// -------------------------------------------------------------
// API : SEUILS & ALERTES
// -------------------------------------------------------------
app.get('/api/thresholds', async (req, res) => {
    if (isFirebaseConnected) {
        const snap = await db.ref('thresholds').once('value');
        const data = snap.val() || {};
        const list = Object.keys(data).map(k => ({ id: k, ...data[k] }));
        return res.json(list);
    }
    res.json(localThresholds);
});

app.post('/api/thresholds', async (req, res) => {
    const { device_id, metric, condition, threshold_value } = req.body;
    const newTh = {
        device_id: device_id || "loc67",
        device_name: "Local 67",
        metric,
        condition,
        threshold_value: parseFloat(threshold_value),
        is_active: 1
    };

    if (isFirebaseConnected) {
        const ref = db.ref('thresholds').push();
        await ref.set(newTh);
        return res.status(201).json({ success: true, id: ref.key });
    }

    newTh.id = "th_" + (localThresholds.length + 1);
    localThresholds.push(newTh);
    res.status(201).json({ success: true, id: newTh.id });
});

app.put('/api/thresholds/:id', async (req, res) => {
    const id = req.params.id;
    if (isFirebaseConnected) {
        await db.ref('thresholds/' + id).update({ is_active: req.body.is_active ? 1 : 0 });
        return res.json({ success: true });
    }
    const th = localThresholds.find(t => String(t.id) === String(id));
    if (th && req.body.is_active !== undefined) th.is_active = req.body.is_active ? 1 : 0;
    res.json({ success: true });
});

app.delete('/api/thresholds/:id', async (req, res) => {
    const id = req.params.id;
    if (isFirebaseConnected) {
        await db.ref('thresholds/' + id).remove();
        return res.json({ success: true });
    }
    localThresholds = localThresholds.filter(t => String(t.id) !== String(id));
    res.json({ success: true });
});

app.get('/api/alerts', async (req, res) => {
    const status = req.query.status;
    if (isFirebaseConnected) {
        const snap = await db.ref('alerts').once('value');
        const data = snap.val() || {};
        let list = Object.keys(data).map(k => ({ id: k, ...data[k] }));
        if (status) {
            list = list.filter(a => a.status === status);
        }
        return res.json(list.reverse());
    }
    if (status) return res.json(localAlerts.filter(a => a.status === status));
    res.json(localAlerts);
});

app.post('/api/alerts/:id/resolve', async (req, res) => {
    const id = req.params.id;
    if (isFirebaseConnected) {
        await db.ref('alerts/' + id).update({ status: 'resolved' });
        return res.json({ success: true });
    }
    const alert = localAlerts.find(a => String(a.id) === String(id));
    if (alert) alert.status = 'resolved';
    res.json({ success: true });
});

// Démarrage du serveur
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Serveur Sentinelle démarré sur http://localhost:${PORT}`);
    console.log(`🔥 Mode Base de données : ${isFirebaseConnected ? 'Firebase Realtime Database' : 'Mémoire (prêt pour clé Firebase)'}`);
    console.log(`====================================================`);
});
