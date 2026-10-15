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
// DONNÉES EN MÉMOIRE (MODE SECOURS SI PAS DE FIREBASE)
// -------------------------------------------------------------
let localDevices = [];
let localThresholds = [];
let localTelemetry = [];
let localAlerts = [];

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
                const lastSeenTime = item.last_seen_ts || (item.last_seen ? new Date(item.last_seen.replace(' ', 'T')).getTime() : 0);
                const is_online = (now - lastSeenTime) < 45000;
                return { id: key, ...item, is_online };
            });
            return res.json(list);
        }

        const devices = localDevices.map(d => {
            const lastSeenTime = d.last_seen_ts || (d.last_seen ? new Date(d.last_seen.replace(' ', 'T')).getTime() : 0);
            return { ...d, is_online: (now - lastSeenTime) < 45000 };
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
// API : TELEMETRIE (Raspberry Pi -> Serveur -> Firebase)
// -------------------------------------------------------------
app.post('/api/telemetry', async (req, res) => {
    const data = req.body || {};
    const apiKey = req.headers['x-api-key'] || data.api_key;
    const deviceName = data.device_name ? data.device_name.trim() : "Appareil-1";
    const nowIso = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const nowTs = Date.now();

    const record = {
        device_name: deviceName,
        api_key: apiKey || "none",
        timestamp: nowIso,
        timestamp_ts: nowTs,
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
        // Enregistrer la mesure dans l'historique et dans la branche latest
        await db.ref('telemetry').push(record);
        await db.ref('latest/' + deviceName).set(record);

        // Mettre à jour ou créer automatiquement l'appareil dans /devices
        const devSnap = await db.ref('devices').once('value');
        const devVal = devSnap.val() || {};
        let foundKey = null;
        for (const devKey of Object.keys(devVal)) {
            if (devVal[devKey].name === deviceName) {
                foundKey = devKey;
                break;
            }
        }

        const connType = data.connection_type || "4G";
        if (foundKey) {
            const updates = { 
                last_seen: nowIso,
                last_seen_ts: nowTs
            };
            if (data.connection_type) updates.connection_type = data.connection_type;
            await db.ref('devices/' + foundKey).update(updates);
        } else {
            await db.ref('devices').push({
                name: deviceName,
                location: "Emplacement non précisé",
                connection_type: connType,
                api_key: apiKey || "none",
                is_active: 1,
                last_seen: nowIso,
                last_seen_ts: nowTs
            });
        }

        // Vérification des seuils
        const thSnap = await db.ref('thresholds').once('value');
        const thVal = thSnap.val() || {};
        for (const k of Object.keys(thVal)) {
            const th = thVal[k];
            if (!th.is_active || (th.device_name && th.device_name !== deviceName)) continue;
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
        let dev = localDevices.find(d => d.name === deviceName);
        if (dev) {
            dev.last_seen = nowIso;
            dev.last_seen_ts = nowTs;
            if (data.connection_type) dev.connection_type = data.connection_type;
        } else {
            localDevices.push({
                id: "dev_" + (localDevices.length + 1),
                name: deviceName,
                location: "Emplacement non précisé",
                connection_type: data.connection_type || "4G",
                api_key: apiKey || "none",
                is_active: 1,
                last_seen: nowIso,
                last_seen_ts: nowTs
            });
        }

        localThresholds.forEach(th => {
            if (!th.is_active || (th.device_name && th.device_name !== deviceName)) return;
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
        let devices = [];
        let latestMap = {};
        let openAlerts = [];

        if (isFirebaseConnected) {
            // Lecture des appareils
            const devSnap = await db.ref('devices').once('value');
            const devData = devSnap.val() || {};
            devices = Object.keys(devData).map(k => ({ id: k, ...devData[k] }));

            // Lecture des dernières mesures (branche latest)
            const latestSnap = await db.ref('latest').once('value');
            latestMap = latestSnap.val() || {};

            // Si latest est vide, fallback sur la dernière mesure de telemetry
            if (Object.keys(latestMap).length === 0) {
                const telSnap = await db.ref('telemetry').limitToLast(1).once('value');
                const telData = telSnap.val() || {};
                const keys = Object.keys(telData);
                if (keys.length > 0) {
                    const lastRec = telData[keys[0]];
                    latestMap[lastRec.device_name || "Appareil"] = lastRec;
                }
            }

            // Alertes ouvertes
            const alSnap = await db.ref('alerts').once('value');
            const alData = alSnap.val() || {};
            openAlerts = Object.keys(alData)
                .map(k => ({ id: k, ...alData[k] }))
                .filter(a => a.status === 'open');
        } else {
            devices = localDevices;
            if (localTelemetry.length > 0) {
                const lastRec = localTelemetry[localTelemetry.length - 1];
                latestMap[lastRec.device_name || "Appareil"] = lastRec;
            }
            openAlerts = localAlerts.filter(a => a.status === 'open');
        }

        let onlineCount = 0;
        devices.forEach(d => {
            const lastSeenTs = d.last_seen_ts || (d.last_seen ? new Date(d.last_seen.replace(' ', 'T')).getTime() : 0);
            if ((now - lastSeenTs) < 45000) onlineCount++;
        });

        const cards = [];
        const mois = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

        // Construire les cartes de mesures pour chaque appareil ayant des données
        for (const devName of Object.keys(latestMap)) {
            const latest = latestMap[devName];
            if (!latest) continue;
            let timeDisplay = latest.timestamp || "";
            try {
                const dt = new Date(latest.timestamp.replace(' ', 'T'));
                if (!isNaN(dt.getTime())) {
                    timeDisplay = `${dt.getDate()} ${mois[dt.getMonth()]}, ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
                }
            } catch (err) {}

            cards.push({
                device_name: devName,
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

        if (req.query.device_name) {
            rows = rows.filter(r => r.device_name === req.query.device_name);
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
