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
// UTILITAIRES DE DATE & HEURE (FUSEAU EUROPE/PARIS UTC+2)
// -------------------------------------------------------------
function parseTsSafe(ts, ts_num) {
    if (ts_num) return ts_num;
    if (!ts) return 0;
    let s = String(ts).trim();
    if (!s.includes('Z') && !s.includes('+') && !s.slice(10).includes('-')) s = s.replace(' ', 'T') + 'Z';
    const t = new Date(s).getTime();
    return isNaN(t) ? 0 : t;
}

function formatParisTime(ts) {
    if (!ts) return '';
    const t = typeof ts === 'number' ? ts : parseTsSafe(ts);
    if (!t) return String(ts);
    return new Date(t).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatParisFull(ts) {
    const t = typeof ts === 'number' ? ts : parseTsSafe(ts);
    if (!t) return 'jamais';
    const d = new Date(t);
    const date = d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${date} à ${time}`;
}

function formatParisCard(ts) {
    const t = typeof ts === 'number' ? ts : parseTsSafe(ts);
    if (!t) return '--:--';
    const d = new Date(t);
    const dayMonth = d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    return `${dayMonth}, ${time}`;
}

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
            let list = Object.keys(data).map(key => {
                const item = data[key];
                const lastSeenTime = parseTsSafe(item.last_seen, item.last_seen_ts);
                const is_online = (now - lastSeenTime) < 180000;
                // SÉCURITÉ : Ne jamais renvoyer la clé secrète au frontend public
                const { api_key, ...safeItem } = item;
                return { 
                    id: key, 
                    ...safeItem, 
                    is_online,
                    last_seen_ts: lastSeenTime,
                    last_seen: formatParisFull(lastSeenTime)
                };
            });

            // Détection automatique de TOUS les appareils récents dans /telemetry
            const telSnap = await db.ref('telemetry').limitToLast(100).once('value');
            const telData = telSnap.val() || {};
            const seenDevices = {};
            for (const k of Object.keys(telData)) {
                const item = telData[k];
                const dName = item.device_name || "ESP32_4G_Master";
                const tTs = parseTsSafe(item.timestamp, item.timestamp_ts);
                if (!seenDevices[dName] || tTs > seenDevices[dName].ts) {
                    seenDevices[dName] = { item, ts: tTs };
                }
            }

            for (const dName of Object.keys(seenDevices)) {
                const { item, ts } = seenDevices[dName];
                const is_online = (now - ts) < 180000;
                const existing = list.find(d => d.name === dName || d.id === dName);
                if (existing) {
                    if (ts > (existing.last_seen_ts || 0)) {
                        existing.is_online = is_online;
                        existing.last_seen_ts = ts;
                        existing.last_seen = formatParisFull(ts);
                        if (item.connection_type) existing.connection_type = item.connection_type;
                    }
                } else {
                    list.push({
                        id: dName,
                        name: dName,
                        location: "Passerelle 4G LTE",
                        connection_type: item.connection_type || "4G",
                        is_active: 1,
                        is_online: is_online,
                        last_seen_ts: ts,
                        last_seen: formatParisFull(ts)
                    });
                }
            }

            return res.json(list);
        }

        const devices = localDevices.map(d => {
            const lastSeenTime = parseTsSafe(d.last_seen, d.last_seen_ts);
            const { api_key, ...safeItem } = d;
            return { 
                ...safeItem, 
                is_online: (now - lastSeenTime) < 180000,
                last_seen_ts: lastSeenTime,
                last_seen: formatParisFull(lastSeenTime)
            };
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
        return res.status(201).json({ success: true, id: ref.key });
    }

    newDevice.id = "dev_" + (localDevices.length + 1);
    localDevices.push(newDevice);
    res.status(201).json({ success: true, id: newDevice.id });
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
    const nowIso = new Date().toISOString();
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
                        timestamp_ts: nowTs,
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
                        timestamp_ts: nowTs,
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

            // Synchronisation avec les dernières mesures reçues dans /telemetry (pour inclure automatiquement les ESP32 4G)
            const telSnap = await db.ref('telemetry').limitToLast(50).once('value');
            const telData = telSnap.val() || {};
            for (const k of Object.keys(telData)) {
                const rec = telData[k];
                const dName = rec.device_name || "ESP32_4G_Master";
                const rTs = parseTsSafe(rec.timestamp, rec.timestamp_ts);
                const curTs = latestMap[dName] ? parseTsSafe(latestMap[dName].timestamp, latestMap[dName].timestamp_ts) : 0;
                if (!latestMap[dName] || rTs >= curTs) {
                    latestMap[dName] = rec;
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

        if (devices.length === 0 && Object.keys(latestMap).length > 0) {
            for (const dName of Object.keys(latestMap)) {
                devices.push({
                    name: dName,
                    last_seen: latestMap[dName].timestamp,
                    last_seen_ts: latestMap[dName].timestamp_ts
                });
            }
        }

        let onlineCount = 0;
        devices.forEach(d => {
            const lastSeenTs = parseTsSafe(d.last_seen, d.last_seen_ts);
            if ((now - lastSeenTs) < 60000) onlineCount++;
        });

        const cards = [];

        // Construire les cartes de mesures pour chaque appareil ayant des données
        for (const devName of Object.keys(latestMap)) {
            const latest = latestMap[devName];
            if (!latest) continue;

            cards.push({
                device_name: devName,
                timestamp: latest.timestamp_ts || latest.timestamp || "",
                time_display: formatParisCard(latest.timestamp_ts || latest.timestamp),
                anomaly_score: latest.anomaly_score !== undefined ? latest.anomaly_score : 0,
                anomaly_threshold: latest.anomaly_threshold !== undefined ? latest.anomaly_threshold : 8.0,
                status: latest.status || "NORMAL",
                connection_type: latest.connection_type || "4G",
                vibration_pic: latest.vibration_peak || 0,
                vibration_moyenne: latest.vibration_mean || 0,
                sound_peak: latest.sound_peak || 0,
                sound_moyenne: latest.sound_mean || 0,
                kurtosis: latest.kurtosis || 0,
                rms: latest.rms || 0
            });
        }

        res.json({
            kpis: {
                devices_online_ratio: `${onlineCount} / ${devices.length}`,
                sensors_tracked: devices.length,
                open_alerts: openAlerts.length
            },
            cards: cards,
            alerts: openAlerts.slice(0, 5),
            last_sync: formatParisTime(now)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// -------------------------------------------------------------
// API : HISTORIQUE POUR CHART.JS
// -------------------------------------------------------------
app.get('/api/telemetry/history', async (req, res) => {
    const metric = req.query.metric || 'anomaly_score';
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
        const labels = slice.map(r => formatParisTime(r.timestamp_ts || r.timestamp));
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
        let list = Object.keys(data).map(k => {
            const item = data[k];
            return {
                id: k,
                ...item,
                timestamp: formatParisFull(item.timestamp_ts || item.timestamp)
            };
        });
        if (status) {
            list = list.filter(a => a.status === status);
        }
        return res.json(list.reverse());
    }
    const safeLocal = localAlerts.map(a => ({
        ...a,
        timestamp: formatParisFull(a.timestamp_ts || a.timestamp)
    }));
    if (status) return res.json(safeLocal.filter(a => a.status === status));
    res.json(safeLocal);
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
