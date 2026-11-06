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
const lastArchivedTs = {};
const updatingDiagnosticDevices = new Set();
const deviceNameByMac = {};

// Utilitaires de nommage pour la branche Historique ({nom_esclave}/{Alerte_... ou Donnees_...})
function getCleanDeviceKey(deviceName) {
    if (!deviceName) return "Capteur_1";
    return String(deviceName).replace(/[\/.#$\[\]]/g, '_').trim();
}

function getFormattedDateTimeKey(d = new Date()) {
    // Forcer le fuseau horaire Europe/Paris (UTC+1 en hiver, UTC+2 en été)
    // pour garantir une clé strictement identique que le serveur tourne en local sur Windows
    // ou dans le cloud sur Render (qui tourne en UTC par défaut)
    const formatter = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(d);
    const p = {};
    for (const item of parts) {
        p[item.type] = item.value;
    }
    const HH = p.hour === '24' ? '00' : p.hour;
    return `${p.year}${p.month}${p.day}_${HH}${p.minute}${p.second}`;
}

function generateHistoryEntryKey(val, ts) {
    const dateObj = ts ? new Date(ts) : new Date();
    const dtStr = getFormattedDateTimeKey(dateObj);

    const isAlert = (val && (val.status === 'ALERTE' || val.status === 1 || (val.anomaly_score && val.anomaly_score >= (val.anomaly_threshold || 8.0))));

    if (isAlert) {
        let causeId = (val && (val.cause || val.origin || val.cause_id));
        if (!causeId && val && val.alert_origin) {
            const org = String(val.alert_origin).toUpperCase();
            if (org.includes('VIBRATION') && org.includes('SON')) causeId = 3;
            else if (org.includes('VIBRATION')) causeId = 2;
            else if (org.includes('SON')) causeId = 1;
            else causeId = val.alert_origin;
        }
        if (!causeId) causeId = 1;
        return `Alerte_${causeId}_${dtStr}`;
    } else {
        return `Donnees_${dtStr}`;
    }
}

// Migration et synchronisation complète de l'Historique (et des branches associées) lors du renommage d'un capteur/ESP32
async function migrerHistoriqueAppareil(oldNameOrId, newName, mac) {
    if (!db || !isFirebaseConnected || !newName) return;

    const newClean = getCleanDeviceKey(newName);

    // Toutes les variantes possibles de l'ancien nom pour être certain de trouver la branche
    const candidates = new Set();
    if (oldNameOrId) {
        candidates.add(String(oldNameOrId).trim());
        candidates.add(getCleanDeviceKey(oldNameOrId));
        candidates.add(String(oldNameOrId).replace(/[:.]/g, '_').trim());
        candidates.add(String(oldNameOrId).replace(/_/g, ' ').trim());
        candidates.add(String(oldNameOrId).replace(/ /g, '_').trim());
    }
    candidates.add(newName.replace(/_/g, ' ').trim());
    candidates.add(newName.replace(/ /g, '_').trim());

    try {
        const histSnap = await db.ref('Historique').once('value');
        const histVal = histSnap.val() || {};

        // Trouver toutes les branches dans Historique correspondant à l'ancien appareil
        const branchesToMigrate = [];

        for (const branchKey of Object.keys(histVal)) {
            if (branchKey === newClean) continue; // Ne pas migrer la branche cible sur elle-même

            let isMatch = candidates.has(branchKey) || 
                          branchKey.replace(/_/g, ' ') === newName.replace(/_/g, ' ') ||
                          branchKey.replace(/ /g, '_') === newName.replace(/ /g, '_');

            // Si une adresse MAC est connue, vérifier si les entrées de cette branche appartiennent à cette MAC
            if (!isMatch && mac) {
                const targetMacUpper = String(mac).toUpperCase().trim();
                const branchEntries = histVal[branchKey];
                if (branchEntries && typeof branchEntries === 'object') {
                    for (const entry of Object.values(branchEntries)) {
                        if (entry && entry.mac && String(entry.mac).toUpperCase().trim() === targetMacUpper) {
                            isMatch = true;
                            break;
                        }
                    }
                }
            }

            if (isMatch) {
                branchesToMigrate.push(branchKey);
            }
        }

        for (const oldBranch of branchesToMigrate) {
            console.log(`🔄 [MIGRATION HISTORIQUE] Déplacement des données de 'Historique/${oldBranch}' vers 'Historique/${newClean}'...`);
            const oldEntries = histVal[oldBranch];
            if (oldEntries && typeof oldEntries === 'object') {
                let count = 0;
                for (const [entryKey, entryData] of Object.entries(oldEntries)) {
                    if (!entryData || typeof entryData !== 'object') continue;
                    const { id: _unusedId, key: _unusedKey, ...cleanData } = entryData;
                    await db.ref('Historique').child(newClean).child(entryKey).set({
                        ...cleanData,
                        device_name: newName
                    });
                    count++;
                }
                await db.ref('Historique').child(oldBranch).remove().catch(() => {});
                console.log(`✅ [MIGRATION HISTORIQUE] ${count} mesures transférées avec succès de '${oldBranch}' vers '${newClean}' !`);
            }
        }

        // Nettoyage / migration dans Donnees_temps_reel
        for (const oldBranch of branchesToMigrate) {
            const dtrSnap = await db.ref('Donnees_temps_reel').child(oldBranch).once('value');
            if (dtrSnap.exists()) {
                const dtrVal = dtrSnap.val();
                if (dtrVal && typeof dtrVal === 'object') {
                    await db.ref('Donnees_temps_reel').child(newClean).set({
                        ...dtrVal,
                        device_name: newName
                    });
                }
                await db.ref('Donnees_temps_reel').child(oldBranch).remove().catch(() => {});
                console.log(`🧹 [DONNEES_TEMPS_REEL] Ancienne clé '${oldBranch}' migrée vers '${newClean}'.`);
            }
        }

        // Nettoyage / migration dans Alertes
        for (const oldBranch of branchesToMigrate) {
            const alerteSnap = await db.ref('Alertes').child(oldBranch).once('value');
            if (alerteSnap.exists()) {
                const alerteVal = alerteSnap.val();
                if (alerteVal && typeof alerteVal === 'object') {
                    await db.ref('Alertes').child(newClean).set(alerteVal);
                }
                await db.ref('Alertes').child(oldBranch).remove().catch(() => {});
                console.log(`🧹 [ALERTES] Ancienne branche '${oldBranch}' migrée vers '${newClean}'.`);
            }
        }

        // Nettoyage / migration dans latest
        for (const oldBranch of branchesToMigrate) {
            const latSnap = await db.ref('latest').child(oldBranch).once('value');
            if (latSnap.exists()) {
                const latVal = latSnap.val();
                if (latVal && typeof latVal === 'object') {
                    await db.ref('latest').child(newClean).set({
                        ...latVal,
                        device_name: newName
                    });
                }
                await db.ref('latest').child(oldBranch).remove().catch(() => {});
            }
        }
    } catch (err) {
        console.error("Erreur lors de la migration d'historique de l'appareil:", err);
    }
}

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

        // Déduplonnage automatique de Historique (supprime les doublons générés par l'écart de fuseau horaire UTC vs Paris et les alertes dupliquées)
        const dedupliquerHistorique = async () => {
            try {
                const histSnap = await db.ref('Historique').once('value');
                const histVal = histSnap.val();
                if (!histVal || typeof histVal !== 'object') return;

                for (const [devKey, entries] of Object.entries(histVal)) {
                    if (!entries || typeof entries !== 'object') continue;
                    const items = Object.entries(entries).map(([eKey, val]) => ({
                        key: eKey,
                        val: val,
                        ts: val && typeof val === 'object' ? (typeof val.timestamp_ts === 'number' ? val.timestamp_ts : parseTsSafe(val.timestamp)) : 0
                    })).filter(x => x.ts > 0);

                    // Trier par timestamp croissant
                    items.sort((a, b) => a.ts - b.ts);

                    for (let i = 0; i < items.length - 1; i++) {
                        for (let j = i + 1; j < items.length; j++) {
                            // Même timestamp physique à moins de 2000ms
                            if (Math.abs(items[i].ts - items[j].ts) < 2000) {
                                let toDelete = null;

                                const itemI = items[i];
                                const itemJ = items[j];

                                const isAlertI = itemI.key.startsWith('Alerte_');
                                const isAlertJ = itemJ.key.startsWith('Alerte_');

                                // Cas 1 : Deux alertes pour le même événement (ex: Alerte_1_... créée par l'IA vs Alerte_2_... créée par server.js)
                                if (isAlertI && isAlertJ) {
                                    const hasDiagI = !!(itemI.val && (itemI.val.Diagnostic || itemI.val.Heure || itemI.val.Jour));
                                    const hasDiagJ = !!(itemJ.val && (itemJ.val.Diagnostic || itemJ.val.Heure || itemJ.val.Jour));

                                    if (hasDiagI && !hasDiagJ) {
                                        toDelete = itemJ.key; // Supprimer le doublon non qualifié créé par server.js
                                    } else if (hasDiagJ && !hasDiagI) {
                                        toDelete = itemI.key; // Supprimer le doublon non qualifié créé par server.js
                                    } else {
                                        // Si l'une des deux a un nom de diagnostic qualifié (ex: Alerte_Panne_moteur_...) et l'autre un simple ID (Alerte_1_...)
                                        const isNamedI = !itemI.key.match(/^Alerte_\d+_/);
                                        const isNamedJ = !itemJ.key.match(/^Alerte_\d+_/);
                                        if (isNamedI && !isNamedJ) {
                                            toDelete = itemJ.key;
                                        } else if (isNamedJ && !isNamedI) {
                                            toDelete = itemI.key;
                                        } else if (itemI.key !== itemJ.key) {
                                            toDelete = itemI.key < itemJ.key ? itemI.key : itemJ.key;
                                        }
                                    }
                                } 
                                // Cas 2 : Une alerte et une donnée normale au même timestamp -> garder l'alerte prioritaire
                                else if (isAlertI && !isAlertJ) {
                                    toDelete = itemJ.key;
                                } else if (isAlertJ && !isAlertI) {
                                    toDelete = itemI.key;
                                } 
                                // Cas 3 : Deux données normales 'Donnees_...'
                                else if (itemI.key !== itemJ.key) {
                                    const expectedKey = generateHistoryEntryKey(itemI.val, itemI.ts);
                                    if (itemI.key === expectedKey && itemJ.key !== expectedKey) {
                                        toDelete = itemJ.key;
                                    } else if (itemJ.key === expectedKey && itemI.key !== expectedKey) {
                                        toDelete = itemI.key;
                                    } else {
                                        toDelete = itemI.key < itemJ.key ? itemI.key : itemJ.key;
                                    }
                                }

                                if (toDelete) {
                                    console.log(`🧹 [DÉDOUBLONNAGE HISTORIQUE] Suppression du doublon '${toDelete}' pour '${devKey}'`);
                                    await db.ref('Historique').child(devKey).child(toDelete).remove().catch(() => {});
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("Erreur dédoublonnage Historique:", err);
            }
        };
        dedupliquerHistorique();

        // Mise en cache temps réel des noms d'appareils par adresse MAC pour une cohérence absolue
        db.ref('devices').on('value', snap => {
            const val = snap.val();
            if (val && typeof val === 'object') {
                for (const [k, d] of Object.entries(val)) {
                    if (d && d.mac) {
                        deviceNameByMac[String(d.mac).toUpperCase()] = d.name || k;
                    }
                }
            }
        });

        // Synchronisation automatique au démarrage : si un appareil a été renommé mais que son Historique
        // est encore sous l'ancien nom (ex: "Esclave test" vs "Esclave_test")
        const synchroniserHistoriqueAppareilsAuDemarrage = async () => {
            try {
                const devSnap = await db.ref('devices').once('value');
                const devVal = devSnap.val() || {};
                const histSnap = await db.ref('Historique').once('value');
                const histVal = histSnap.val() || {};

                for (const [dKey, dItem] of Object.entries(devVal)) {
                    if (!dItem) continue;
                    const curName = dItem.name || dKey;
                    const curClean = getCleanDeviceKey(curName);
                    const mac = dItem.mac;

                    for (const histKey of Object.keys(histVal)) {
                        if (histKey === curClean) continue;

                        const isSpaceUnderscoreMatch = 
                            histKey.replace(/_/g, ' ') === curClean.replace(/_/g, ' ') ||
                            histKey.replace(/ /g, '_') === curClean.replace(/ /g, '_');
                        
                        let isMacMatch = false;
                        if (mac && histVal[histKey] && typeof histVal[histKey] === 'object') {
                            for (const entry of Object.values(histVal[histKey])) {
                                if (entry && entry.mac && String(entry.mac).toUpperCase() === String(mac).toUpperCase()) {
                                    isMacMatch = true;
                                    break;
                                }
                            }
                        }

                        if (isSpaceUnderscoreMatch || isMacMatch) {
                            console.log(`🔄 [AUTO-SYNC RENOMMAGE] Synchronisation détectée : '${histKey}' doit être migré vers '${curClean}'`);
                            await migrerHistoriqueAppareil(histKey, curName, mac);
                        }
                    }
                }
            } catch (err) {
                console.error("Erreur synchronisation Historique au démarrage:", err);
            }
        };
        synchroniserHistoriqueAppareilsAuDemarrage();

        // Dédoublonnage automatique de Donnees_temps_reel basé sur l'adresse MAC
        db.ref('Donnees_temps_reel').on('value', async (snapshot) => {
            const data = snapshot.val();
            if (!data) return;
            const byMac = {};
            for (const [key, val] of Object.entries(data)) {
                if (!val || !val.mac) continue;
                const mac = String(val.mac).toUpperCase().trim();
                if (!byMac[mac]) byMac[mac] = [];
                byMac[mac].push({ key, ts: val.timestamp_ts || 0 });
            }
            for (const [mac, items] of Object.entries(byMac)) {
                if (items.length > 1) {
                    items.sort((a, b) => b.ts - a.ts);
                    for (let i = 1; i < items.length; i++) {
                        console.log(`🧹 [DÉDOUBLONNAGE] Suppression de l'ancienne entrée obsolète '${items[i].key}' pour MAC ${mac} (conservée : '${items[0].key}')`);
                        await db.ref('Donnees_temps_reel').child(items[i].key).remove().catch(() => {});
                    }
                }
            }
        });

        // Archivage automatique transparent de Donnees_temps_reel vers Historique/{nom_esclave}/{entree}
        const archiverMesure = async (key, val) => {
            if (!val || typeof val !== 'object') return;

            let devName = val.device_name || key;
            if (val.mac && deviceNameByMac[String(val.mac).toUpperCase()]) {
                devName = deviceNameByMac[String(val.mac).toUpperCase()];
            }
            const safeDev = getCleanDeviceKey(devName);

            // Horodatage réel du capteur (ne JAMAIS utiliser Date.now() pour éviter les fausses mesures en boucle)
            const ts = typeof val.timestamp_ts === 'number' ? val.timestamp_ts : parseTsSafe(val.timestamp);
            if (!ts || isNaN(ts) || ts <= 0) return;

            // Détection alerte : les alertes sont déjà gérées et archivées dans /Historique par le système d'analyse IA externe
            // (avec son ID officiel Anomalie_inconnu_X, ses champs Diagnostic, Heure, Jour, et son lien dans /Anomalies).
            // Ne JAMAIS archiver de seconde alerte depuis server.js pour éliminer définitivement les doublons !
            const isAlert = (val && (val.status === 'ALERTE' || val.status === 1 || (val.anomaly_score !== undefined && val.anomaly_score >= (val.anomaly_threshold !== undefined ? val.anomaly_threshold : 100))));
            if (isAlert) {
                return;
            }

            const isDuplicate = (lastArchivedTs[key] && Math.abs(lastArchivedTs[key] - ts) < 2000) ||
                                (lastArchivedTs[safeDev] && Math.abs(lastArchivedTs[safeDev] - ts) < 2000);

            // Si cette modification provient de l'édition d'un diagnostic et que le timestamp n'a pas changé : on ignore
            if (updatingDiagnosticDevices.has(key) || updatingDiagnosticDevices.has(safeDev)) {
                if (isDuplicate) {
                    return;
                }
                // Si le timestamp a changé, c'est une VRAIE nouvelle mesure de l'ESP32 arrivée en même temps : on la traite !
                updatingDiagnosticDevices.delete(key);
                updatingDiagnosticDevices.delete(safeDev);
            }

            // Détection stricte de doublon : si la mesure a déjà été archivée pour ce capteur, on ignore
            if (isDuplicate) {
                return;
            }
            lastArchivedTs[key] = ts;
            lastArchivedTs[safeDev] = ts;

            const entryKey = generateHistoryEntryKey(val, ts);
            const { id: _unusedId, key: _unusedKey, ...cleanVal } = val;
            await db.ref('Historique').child(safeDev).child(entryKey).set({
                ...cleanVal,
                device_name: devName,
                timestamp_ts: ts,
                timestamp: new Date(ts).toISOString()
            }).catch(err => console.error("Erreur archivage Historique:", err));

            // Détection et suppression immédiate de tout doublon résiduel en temps réel (ex: écrit par Render ou un serveur en UTC)
            setTimeout(async () => {
                try {
                    const snap = await db.ref('Historique').child(safeDev).limitToLast(10).once('value');
                    const entries = snap.val();
                    if (entries && typeof entries === 'object') {
                        for (const [eKey, eVal] of Object.entries(entries)) {
                            if (eKey === entryKey) continue;
                            if (eKey.startsWith('Alerte_')) continue; // Ne JAMAIS supprimer une alerte lors de l'archivage d'une donnée normale !
                            const eTs = (eVal && typeof eVal === 'object') ? (eVal.timestamp_ts || parseTsSafe(eVal.timestamp)) : 0;
                            if (eTs && Math.abs(eTs - ts) < 2000) {
                                console.log(`🧹 [ANTI-DOUBLON TEMPS RÉEL] Suppression du doublon obsolète '${eKey}' pour '${safeDev}' (conservé : '${entryKey}')`);
                                await db.ref('Historique').child(safeDev).child(eKey).remove().catch(() => {});
                            }
                        }
                    }
                } catch (err) {
                    console.error("Erreur nettoyage doublon temps réel:", err);
                }
            }, 500);
        };
        db.ref('Donnees_temps_reel').on('child_added', snapshot => archiverMesure(snapshot.key, snapshot.val()));
        db.ref('Donnees_temps_reel').on('child_changed', snapshot => archiverMesure(snapshot.key, snapshot.val()));
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
                    machine_name: item.machine_name || "",
                    anomaly_threshold: item.anomaly_threshold !== undefined ? item.anomaly_threshold : 8.0,
                    mac: item.mac || (key.includes('_') ? key.replace(/_/g, ':') : ""),
                    is_online,
                    last_seen_ts: lastSeenTime,
                    last_seen: formatParisFull(lastSeenTime)
                };
            });

            // Détection automatique de TOUS les appareils récents dans /Donnees_temps_reel et /telemetry
            const seenDevices = {};

            // 1. Priorité aux mesures directes en temps réel dans /Donnees_temps_reel
            const dtrSnap = await db.ref('Donnees_temps_reel').once('value');
            const dtrData = dtrSnap.val() || {};
            for (const k of Object.keys(dtrData)) {
                const item = dtrData[k];
                if (!item) continue;
                const dName = item.device_name || k;
                const tTs = parseTsSafe(item.timestamp, item.timestamp_ts);
                seenDevices[dName] = { item: { ...item, device_name: dName }, ts: tTs };
            }

            // 2. Complément avec Historique ({nom_esclave}/{entree})
            const telSnap = await db.ref('Historique').once('value');
            const telData = telSnap.val() || {};
            for (const dev of Object.keys(telData)) {
                const devEntries = telData[dev];
                if (!devEntries || typeof devEntries !== 'object') continue;
                for (const k of Object.keys(devEntries)) {
                    const item = devEntries[k];
                    if (!item || typeof item !== 'object') continue;
                    const dName = item.device_name || dev;
                    const tTs = parseTsSafe(item.timestamp, item.timestamp_ts);
                    if (!seenDevices[dName] || tTs > seenDevices[dName].ts) {
                        seenDevices[dName] = { item, ts: tTs };
                    }
                }
            }

            for (const dName of Object.keys(seenDevices)) {
                const { item, ts } = seenDevices[dName];
                const is_online = (now - ts) < 180000;
                // Recherche intelligente : par ID, par nom OU par adresse MAC
                const existing = list.find(d => 
                    d.id === dName || 
                    d.name === dName || 
                    (item.mac && d.mac && d.mac.toUpperCase() === item.mac.toUpperCase())
                );
                if (existing) {
                    if (ts > (existing.last_seen_ts || 0)) {
                        existing.is_online = is_online;
                        existing.last_seen_ts = ts;
                        existing.last_seen = formatParisFull(ts);
                        if (item.connection_type) existing.connection_type = item.connection_type;
                    }
                    if (item.mac && !existing.mac) existing.mac = item.mac;
                    if (item.machine_name && !existing.machine_name) existing.machine_name = item.machine_name;

                    // Lecture du seuil actif pour affichage en mémoire (100% lecture seule, AUCUNE écriture intempestive sur Firebase)
                    if (item.anomaly_threshold !== undefined && existing.anomaly_threshold === undefined) {
                        existing.anomaly_threshold = parseFloat(item.anomaly_threshold);
                    }
                } else {
                    list.push({
                        id: dName,
                        name: dName,
                        machine_name: item.machine_name || "",
                        location: item.location || "Passerelle 4G LTE",
                        connection_type: item.connection_type || "4G",
                        anomaly_threshold: item.anomaly_threshold !== undefined ? item.anomaly_threshold : 8.0,
                        mac: item.mac || "",
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
    const rawId = req.params.id;
    const safeId = String(rawId).replace(/[:.]/g, '_');
    const { name, machine_name, location, anomaly_threshold, mac } = req.body;

    const updates = {
        name: name || rawId,
        machine_name: machine_name || "",
        location: location || "Emplacement non précisé",
        updated_at: new Date().toISOString()
    };
    if (anomaly_threshold !== undefined && !isNaN(parseFloat(anomaly_threshold))) {
        updates.anomaly_threshold = parseFloat(anomaly_threshold);
    }
    if (mac) {
        updates.mac = mac;
    }

    if (isFirebaseConnected) {
        // 1. Mettre à jour dans /devices (avec migration de la clé si le nom a changé)
        const oldSnap = await db.ref('devices').child(safeId).once('value');
        const oldVal = oldSnap.val() || {};
        const oldName = oldVal.name || rawId;

        const newKey = String(updates.name || safeId).replace(/[:.]/g, '_').trim();
        if (newKey && newKey !== safeId) {
            await db.ref('devices').child(newKey).set({ ...oldVal, ...updates });
            await db.ref('devices').child(safeId).remove();
            console.log(`🔄 [FIREBASE] Appareil migré de /devices/${safeId} vers /devices/${newKey}`);
        } else {
            await db.ref('devices').child(safeId).update(updates);
        }

        // Migration immédiate de tout l'historique et des branches associées vers le nouveau nom
        const targetMac = mac || updates.mac || oldVal.mac || rawId;
        await migrerHistoriqueAppareil(oldName, updates.name, targetMac);
        if (safeId !== oldName) {
            await migrerHistoriqueAppareil(safeId, updates.name, targetMac);
        }

        // 2. Mettre à jour dans /latest pour affichage temps réel immédiat
        const latestKey = updates.name || rawId;
        const latestSnap = await db.ref('latest').child(latestKey).once('value');
        if (latestSnap.exists()) {
            const latestUpdate = {
                device_name: updates.name,
                location: updates.location
            };
            if (updates.machine_name) latestUpdate.machine_name = updates.machine_name;
            if (updates.anomaly_threshold !== undefined) latestUpdate.anomaly_threshold = updates.anomaly_threshold;
            await db.ref('latest').child(latestKey).update(latestUpdate);
        }

        // 3. Créer un ordre dans /commands pour que la passerelle 4G synchronise le nom, la machine, le lieu et le seuil IA
        const cmdKey = String(targetMac).replace(/[:.]/g, '_');
        const cmdPayload = {
            mac: targetMac,
            device_name: updates.name,
            machine_name: updates.machine_name || "",
            location: updates.location || "Emplacement non précisé",
            timestamp: Date.now()
        };
        if (updates.anomaly_threshold !== undefined) {
            cmdPayload.anomaly_threshold = updates.anomaly_threshold;
        }
        await db.ref('commands').child(cmdKey).set(cmdPayload);
        console.log(`📡 [ORDRE 4G GÉNÉRÉ] Synchronisation appareil ${updates.name} (MAC: ${targetMac}) : Machine='${updates.machine_name}', Lieu='${updates.location}', Seuil=${updates.anomaly_threshold}`);

        return res.json({ success: true, updates });
    }

    const dev = localDevices.find(d => String(d.id) === String(rawId) || String(d.id) === safeId);
    if (dev) Object.assign(dev, updates);
    res.json({ success: true, updates });
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

// Nettoyage strict des diagnostics pour Firebase (espaces -> underscores, pas d'accents ni caractères spéciaux)
function sanitizeDiagnostic(diag) {
    if (!diag) return "Anomalie";
    return String(diag)
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Supprime les accents
        .replace(/[^a-zA-Z0-9_-]/g, '_')   // Remplace espaces et caractères spéciaux par '_'
        .replace(/_+/g, '_')               // Évite les underscores multiples
        .replace(/^_+|_+$/g, '') || "Anomalie";
}

// -------------------------------------------------------------
// API : ÉDITION ET ENREGISTREMENT DU DIAGNOSTIC SUR FIREBASE
// -------------------------------------------------------------
app.post('/api/devices/:id/diagnostic', async (req, res) => {
    const rawId = req.params.id;
    const { diagnostic, history_key, timestamp } = req.body;
    if (!diagnostic) return res.status(400).json({ error: "Diagnostic requis" });

    const safeDev = getCleanDeviceKey(rawId);
    const cleanDiag = sanitizeDiagnostic(diagnostic);
    console.log(`📝 [DIAGNOSTIC ENREGISTRÉ] Mise à jour du diagnostic pour '${safeDev}' : "${cleanDiag}"`);

    if (isFirebaseConnected) {
        let targetKey = null;
        let entryData = null;
        let isRootKey = false;

        // 1. Recherche directe sous /Historique/<safeDev>/<cle_entree> si fournie
        if (history_key) {
            const histRef = db.ref('Historique').child(safeDev).child(history_key);
            const histSnap = await histRef.once('value');
            if (histSnap.exists()) {
                targetKey = history_key;
                entryData = histSnap.val() || {};
            } else {
                // Rétrocompatibilité : si l'ancienne clé était directement sous Historique/<cle>
                const rootHistRef = db.ref('Historique').child(history_key);
                const rootHistSnap = await rootHistRef.once('value');
                if (rootHistSnap.exists()) {
                    targetKey = history_key;
                    entryData = rootHistSnap.val() || {};
                    isRootKey = true;
                }
            }
        }

        // 2. Si la clé directe n'a pas été trouvée, recherche sous /Historique/<safeDev> par date
        if (!targetKey) {
            const histSnap = await db.ref('Historique').child(safeDev).limitToLast(100).once('value');
            const histData = histSnap.val() || {};

            if (timestamp) {
                const targetTs = typeof timestamp === 'number' ? timestamp : parseTsSafe(timestamp);
                let minDiff = Infinity;
                for (const [k, item] of Object.entries(histData)) {
                    if (!item || typeof item !== 'object') continue;
                    const itemTs = item.timestamp_ts || parseTsSafe(item.timestamp);
                    if (itemTs) {
                        const diff = Math.abs(itemTs - targetTs);
                        if (diff < minDiff && diff < 120000) { // dans les 2 minutes
                            minDiff = diff;
                            targetKey = k;
                            entryData = item;
                        }
                    }
                }
            }

            // Si toujours pas trouvé, prendre la toute dernière entrée existante de cet esclave
            if (!targetKey) {
                const keys = Object.keys(histData);
                if (keys.length > 0) {
                    targetKey = keys[keys.length - 1];
                    entryData = histData[targetKey];
                }
            }
        }

        if (!targetKey || !entryData) {
            return res.status(404).json({ error: "Entrée d'historique introuvable pour ce capteur" });
        }

        // 3. Extraction de l'ancien identifiant et renommage global des alertes partageant cet ID (Option 1 Globale)
        // Ex: Alerte_4_20261103_143740 et Alerte_4_20261103_144130 -> Alerte_panne_ventillateur_...
        let newKey = targetKey;
        let oldAnomalyId = null;

        const alerteMatch = targetKey.match(/^Alerte_(.+)_(\d{8}_\d{6})$/);
        if (alerteMatch) {
            oldAnomalyId = alerteMatch[1]; // ex: "4" ou "inconnu_4" ou précédent diagnostic
            const dtStr = alerteMatch[2];
            newKey = `Alerte_${cleanDiag}_${dtStr}`;
        } else {
            const donneesMatch = targetKey.match(/^Donnees_(\d{8}_\d{6})$/);
            if (donneesMatch) {
                const dtStr = donneesMatch[1];
                newKey = `Alerte_${cleanDiag}_${dtStr}`;
            }
        }

        // Si oldAnomalyId n'a pas été capturé dans la clé, vérifier les propriétés de la donnée
        if (!oldAnomalyId && entryData) {
            oldAnomalyId = entryData.cause_id || entryData.cause || entryData.alert_id || null;
            if (!oldAnomalyId && entryData.Diagnostic) {
                const dMatch = String(entryData.Diagnostic).match(/(\d+)$/);
                if (dMatch) oldAnomalyId = dMatch[1];
            }
        }

        // 3. Mise à jour et renommage STRICTEMENT et UNIQUEMENT de l'alerte ciblée dans Historique
        const { id: _tId, key: _tKey, ...cleanEntryData } = entryData;
        const updatedEntry = {
            ...cleanEntryData,
            diagnostic: cleanDiag,
            Diagnostic: cleanDiag
        };

        if (newKey !== targetKey) {
            await db.ref('Historique').child(safeDev).child(newKey).set(updatedEntry);
            if (isRootKey) {
                await db.ref('Historique').child(targetKey).remove().catch(() => {});
            } else {
                await db.ref('Historique').child(safeDev).child(targetKey).remove().catch(() => {});
            }
            console.log(`🔄 [HISTORIQUE] Alerte ciblée renommée avec succès : '${safeDev}/${targetKey}' ➔ '${safeDev}/${newKey}' (diagnostic: "${cleanDiag}")`);
        } else {
            await db.ref('Historique').child(safeDev).child(targetKey).update({ 
                diagnostic: cleanDiag,
                Diagnostic: cleanDiag 
            });
            console.log(`✅ [HISTORIQUE] Diagnostic mis à jour pour '${safeDev}/${targetKey}' : "${cleanDiag}"`);
        }

        // 4. Mise à jour de la branche /Anomalies (Option A : Anomalies/<cleanDiag> avec Nom: "<cleanDiag>")
        let updatedAnomalyNode = null;
        try {
            const anomaliesRef = db.ref('Anomalies');
            const anomaliesSnap = await anomaliesRef.once('value');
            const anomaliesVal = anomaliesSnap.val() || {};

            let targetAnomalyKey = null;

            // 4.1 Recherche par identifiant direct (ex: "4", "Anomalie_inconnu_4", etc.)
            if (oldAnomalyId) {
                const candidates = [
                    `Anomalie_inconnu_${oldAnomalyId}`,
                    `Anomalie_inconnue_${oldAnomalyId}`,
                    `Anomalie_${oldAnomalyId}`,
                    String(oldAnomalyId)
                ];
                for (const c of candidates) {
                    if (anomaliesVal[c] !== undefined) {
                        targetAnomalyKey = c;
                        break;
                    }
                }

                // Recherche insensible à la casse
                if (!targetAnomalyKey) {
                    const lowerSearch = `anomalie_inconnu_${oldAnomalyId}`.toLowerCase();
                    for (const k of Object.keys(anomaliesVal)) {
                        if (k.toLowerCase() === lowerSearch || k.toLowerCase() === String(oldAnomalyId).toLowerCase()) {
                            targetAnomalyKey = k;
                            break;
                        }
                    }
                }
            }

            // 4.2 Recherche par précédent diagnostic dans Nom ou dans Donnees_en_cours_enregistrement
            if (!targetAnomalyKey && entryData && entryData.diagnostic) {
                const prevDiagClean = sanitizeDiagnostic(entryData.diagnostic);
                for (const [k, item] of Object.entries(anomaliesVal)) {
                    if (!item || typeof item !== 'object') continue;
                    if (item.Nom === entryData.diagnostic || sanitizeDiagnostic(item.Nom) === prevDiagClean || k === prevDiagClean) {
                        targetAnomalyKey = k;
                        break;
                    }
                    if (item.Donnees_en_cours_enregistrement && item.Donnees_en_cours_enregistrement.diagnostic === entryData.diagnostic) {
                        targetAnomalyKey = k;
                        break;
                    }
                }
            }

            // 4.3 Recherche par correspondance exacte des mesures / horodatage dans Donnees_en_cours_enregistrement
            if (!targetAnomalyKey && entryData) {
                const targetTs = entryData.timestamp_ts || parseTsSafe(entryData.timestamp);
                let minDiff = Infinity;
                let bestKey = null;

                for (const [k, item] of Object.entries(anomaliesVal)) {
                    if (!item || typeof item !== 'object') continue;
                    const rec = item.Donnees_en_cours_enregistrement;
                    if (rec && typeof rec === 'object') {
                        const recTs = rec.timestamp_ts || parseTsSafe(rec.timestamp);
                        if (recTs && targetTs) {
                            const diff = Math.abs(recTs - targetTs);
                            const sameDev = (!rec.device_name || rec.device_name === safeDev || rec.device_name === entryData.device_name);
                            const sameMac = (!rec.mac || !entryData.mac || rec.mac.toUpperCase() === entryData.mac.toUpperCase());
                            if (diff < minDiff && diff < 15000 && (sameDev || sameMac)) {
                                minDiff = diff;
                                bestKey = k;
                            }
                        }
                    }
                }
                if (bestKey) {
                    targetAnomalyKey = bestKey;
                    console.log(`🎯 [ANOMALIES] Nœud trouvé par correspondance de mesures/timestamp : '${bestKey}'`);
                }
            }

            const newAnomalyNodeKey = cleanDiag; // Option A : ex "Vibration_anormale"
            let existingAnomalyData = {};

            if (targetAnomalyKey && anomaliesVal[targetAnomalyKey] && typeof anomaliesVal[targetAnomalyKey] === 'object') {
                existingAnomalyData = anomaliesVal[targetAnomalyKey];
            }

            // Conservation absolue de Donnees_en_cours_enregistrement
            let donneesEnreg = existingAnomalyData.Donnees_en_cours_enregistrement;

            // Si non trouvé dans l'ancien nœud, on le récupère depuis les vraies données physiques de l'alerte !
            if (!donneesEnreg && entryData) {
                donneesEnreg = {
                    alert_origin: entryData.alert_origin || "GENERAL",
                    anomaly_score: entryData.anomaly_score !== undefined ? entryData.anomaly_score : 0,
                    anomaly_threshold: entryData.anomaly_threshold !== undefined ? entryData.anomaly_threshold : 8.0,
                    connection_type: entryData.connection_type || "4G",
                    device_name: entryData.device_name || safeDev,
                    diagnostic: cleanDiag,
                    mac: entryData.mac || "",
                    sound_rms: entryData.sound_rms !== undefined ? entryData.sound_rms : (entryData.sound_mean || 0),
                    status: entryData.status || "ALERTE",
                    timestamp_ts: entryData.timestamp_ts || parseTsSafe(entryData.timestamp) || Date.now(),
                    vibration_peak: entryData.vibration_peak !== undefined ? entryData.vibration_peak : 0,
                    vibration_rms: entryData.vibration_rms !== undefined ? entryData.vibration_rms : (entryData.vibration_mean || 0)
                };
            } else if (donneesEnreg) {
                // Si déjà présent, on actualise le diagnostic avec le nouveau libellé
                donneesEnreg.diagnostic = cleanDiag;
            }

            const newAnomalyPayload = {
                ...existingAnomalyData,
                Nom: cleanDiag
            };

            if (donneesEnreg) {
                newAnomalyPayload.Donnees_en_cours_enregistrement = donneesEnreg;
            }

            // Écriture du nœud complet sous Anomalies/<cleanDiag>
            await anomaliesRef.child(newAnomalyNodeKey).set(newAnomalyPayload);
            console.log(`🏷️ [ANOMALIES] Nœud '${newAnomalyNodeKey}' enregistré avec Nom: "${cleanDiag}" et Donnees_en_cours_enregistrement conservées !`);

            // Suppression de l'ancien nœud si son nom était différent
            if (targetAnomalyKey && targetAnomalyKey !== newAnomalyNodeKey) {
                await anomaliesRef.child(targetAnomalyKey).remove().catch(() => {});
                console.log(`🗑️ [ANOMALIES] Ancien nœud '${targetAnomalyKey}' supprimé`);
            }
            updatedAnomalyNode = newAnomalyNodeKey;
        } catch (anomErr) {
            console.error("Erreur lors de la mise à jour d'Anomalies:", anomErr);
        }

        // NOTE IMPORTANTE :
        // - Donnees_temps_reel n'est PAS modifié (consigne utilisateur)
        // - Nous n'écrivons JAMAIS dans /Alertes ni dans /Historique

        return res.json({ 
            success: true, 
            device: safeDev, 
            diagnostic: cleanDiag, 
            oldKey: targetKey, 
            key: newKey, 
            anomalyKey: updatedAnomalyNode 
        });
    }

    res.json({ success: true, device: safeDev, diagnostic: cleanDiag });
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
        // Enregistrer la mesure dans Historique sous {nom_esclave}/{entree} (si ce n'est pas une alerte déjà gérée par l'IA) et dans latest
        const safeDev = getCleanDeviceKey(deviceName);
        if (record.status !== 'ALERTE') {
            const entryKey = generateHistoryEntryKey(record, nowTs);
            await db.ref('Historique').child(safeDev).child(entryKey).set({
                ...record
            }).catch(err => console.error("Erreur écriture Historique:", err));
        }
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
            const devKey = String(deviceName).replace(/[:.]/g, '_').trim();
            await db.ref('devices').child(devKey).set({
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

            // 1. Lecture des mesures temps réel directes depuis /Donnees_temps_reel (source principale)
            const dtrSnap = await db.ref('Donnees_temps_reel').once('value');
            const dtrData = dtrSnap.val() || {};
            for (const k of Object.keys(dtrData)) {
                const rec = dtrData[k];
                if (!rec) continue;
                const dName = rec.device_name || k;
                latestMap[dName] = { ...rec, device_name: dName };
            }

            // 2. Complément avec la branche latest si présente
            const latestSnap = await db.ref('latest').once('value');
            const oldLatest = latestSnap.val() || {};
            for (const k of Object.keys(oldLatest)) {
                if (!latestMap[k]) latestMap[k] = oldLatest[k];
            }

            // 3. Complément avec Historique ({nom_esclave}/{entree}) pour inclure d'autres appareils
            const telSnap = await db.ref('Historique').once('value');
            const telData = telSnap.val() || {};
            for (const dev of Object.keys(telData)) {
                const devEntries = telData[dev];
                if (!devEntries || typeof devEntries !== 'object') continue;
                for (const k of Object.keys(devEntries)) {
                    const rec = devEntries[k];
                    if (!rec || typeof rec !== 'object') continue;
                    const dName = rec.device_name || dev;
                    const rTs = parseTsSafe(rec.timestamp, rec.timestamp_ts);
                    const curTs = latestMap[dName] ? parseTsSafe(latestMap[dName].timestamp, latestMap[dName].timestamp_ts) : 0;
                    if (!latestMap[dName] || rTs >= curTs) {
                        latestMap[dName] = { ...rec, device_name: dName };
                    }
                }
            }

            // 4. Alertes ouvertes (depuis /alerts et /Alertes)
            const alSnap = await db.ref('alerts').once('value');
            const alData = alSnap.val() || {};
            openAlerts = Object.keys(alData)
                .map(k => ({ id: k, ...alData[k] }))
                .filter(a => a.status === 'open');

            // Intégrer également les alertes actives de la branche /Alertes (API Cloud)
            const altSnap = await db.ref('Alertes').once('value');
            const altData = altSnap.val() || {};
            for (const k of Object.keys(altData)) {
                const item = altData[k];
                if (item && item.Diagnostic && item.Diagnostic !== '""' && item.Diagnostic !== 'null') {
                    openAlerts.push({
                        id: k,
                        device_name: k,
                        status: 'open',
                        message: item.Diagnostic,
                        timestamp_ts: Date.now()
                    });
                }
            }

            // Intégrer les capteurs actuellement marqués en statut ALERTE dans Donnees_temps_reel
            for (const k of Object.keys(dtrData)) {
                const item = dtrData[k];
                if (item && item.status === 'ALERTE') {
                    const devN = item.device_name || k;
                    if (!openAlerts.some(a => a.device_name === devN)) {
                        openAlerts.push({
                            id: 'dtr_' + k,
                            device_name: devN,
                            status: 'open',
                            message: item.Diagnostic || item.diagnostic || 'Anomalie détectée en temps réel',
                            anomaly_score: item.anomaly_score,
                            timestamp_ts: item.timestamp_ts || Date.now()
                        });
                    }
                }
            }
        } else {
            devices = localDevices;
            if (localTelemetry.length > 0) {
                const lastRec = localTelemetry[localTelemetry.length - 1];
                latestMap[lastRec.device_name || "Appareil"] = lastRec;
            }
            openAlerts = localAlerts.filter(a => a.status === 'open');
        }

        // Fusionner tous les appareils de latestMap dans devices s'ils n'y sont pas
        for (const dName of Object.keys(latestMap)) {
            const existing = devices.find(d => d.name === dName || d.id === dName);
            const rRec = latestMap[dName];
            const rTs = parseTsSafe(rRec.timestamp, rRec.timestamp_ts);
            if (existing) {
                if (rTs > parseTsSafe(existing.last_seen, existing.last_seen_ts)) {
                    existing.last_seen_ts = rTs;
                    existing.last_seen = formatParisFull(rTs);
                }
            } else {
                devices.push({
                    id: dName,
                    name: dName,
                    last_seen_ts: rTs,
                    last_seen: formatParisFull(rTs),
                    connection_type: rRec.connection_type || "4G"
                });
            }
        }

        let onlineCount = 0;
        devices.forEach(d => {
            const lastSeenTs = parseTsSafe(d.last_seen, d.last_seen_ts);
            if ((now - lastSeenTs) < 180000) onlineCount++;
        });

        const cards = [];

        // Construire les cartes de mesures pour chaque appareil ayant des données
        for (const devName of Object.keys(latestMap)) {
            const latest = latestMap[devName];
            if (!latest) continue;

            const devObj = devices.find(d => 
                d.id === devName || 
                d.name === devName || 
                (latest.mac && d.mac && d.mac.toUpperCase() === latest.mac.toUpperCase())
            );
            const displayName = devObj ? (devObj.name || devName) : devName;
            const activeThreshold = (latest.anomaly_threshold !== undefined) 
                ? latest.anomaly_threshold 
                : (devObj && devObj.anomaly_threshold !== undefined ? devObj.anomaly_threshold : 8.0);

            cards.push({
                device_name: displayName,
                raw_device_name: devName,
                mac: latest.mac || (devObj ? devObj.mac : ""),
                machine_name: devObj ? devObj.machine_name : "",
                location: devObj ? devObj.location : "",
                timestamp: latest.timestamp_ts || latest.timestamp || "",
                time_display: formatParisCard(latest.timestamp_ts || latest.timestamp),
                anomaly_score: latest.anomaly_score !== undefined ? latest.anomaly_score : 0,
                anomaly_threshold: activeThreshold,
                status: latest.status || "NORMAL",
                connection_type: latest.connection_type || "4G",
                alert_origin: latest.alert_origin || "",
                diagnostic: latest.Diagnostic || latest.diagnostic || "",
                vibration_pic: latest.vibration_peak || 0,
                vibration_moyenne: latest.vibration_rms || latest.vibration_mean || 0,
                sound_peak: latest.sound_peak || 0,
                sound_moyenne: latest.sound_rms || latest.sound_mean || 0,
                kurtosis: latest.kurtosis || 0,
                rms: latest.vibration_rms || latest.rms || 0
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
            last_sync: now
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
            rows = [];
            const queryName = req.query.device_name ? req.query.device_name.trim() : null;

            if (queryName) {
                // Recherche des identifiants d'esclaves possibles
                let targetDevKeys = [getCleanDeviceKey(queryName)];
                const devSnap = await db.ref('devices').once('value');
                const devData = devSnap.val() || {};
                for (const k of Object.keys(devData)) {
                    const d = devData[k];
                    if (k === queryName || d.name === queryName || (d.mac && d.mac.toUpperCase() === queryName.toUpperCase())) {
                        targetDevKeys.push(getCleanDeviceKey(k));
                        if (d.name) targetDevKeys.push(getCleanDeviceKey(d.name));
                    }
                }
                targetDevKeys = [...new Set(targetDevKeys)];

                for (const dKey of targetDevKeys) {
                    const snap = await db.ref('Historique').child(dKey).once('value');
                    const devVal = snap.val() || {};
                    for (const [k, item] of Object.entries(devVal)) {
                        if (!item || typeof item !== 'object') continue;
                        rows.push({
                            ...item,
                            _key: k,
                            id: item.id || k,
                            device_name: item.device_name || queryName
                        });
                    }
                }
            } else {
                const snap = await db.ref('Historique').once('value');
                const allVal = snap.val() || {};
                for (const [devKey, devEntries] of Object.entries(allVal)) {
                    if (!devEntries || typeof devEntries !== 'object') continue;
                    for (const [k, item] of Object.entries(devEntries)) {
                        if (!item || typeof item !== 'object') continue;
                        rows.push({
                            ...item,
                            _key: k,
                            id: item.id || k,
                            device_name: item.device_name || devKey
                        });
                    }
                }
            }
        }

        const getTsSafe = (item) => {
            if (!item) return 0;
            if (typeof item.timestamp_ts === 'number' && !isNaN(item.timestamp_ts)) return item.timestamp_ts;
            return parseTsSafe(item.timestamp, item.timestamp_ts);
        };

        // Tri chronologique rigoureux (ordre croissant temporel)
        rows.sort((a, b) => getTsSafe(a) - getTsSafe(b));

        // Dédoublonnage intelligent des mesures pour Chart.js (priorité absolue aux alertes sur les données normales)
        const uniqueRows = [];
        const seenKeys = new Set();
        const isAlertPoint = (p) => !!(p && (p.status === 'ALERTE' || p.status === 1 || (p.anomaly_score !== undefined && p.anomaly_score >= (p.anomaly_threshold !== undefined ? p.anomaly_threshold : 100)) || (p._key && p._key.startsWith('Alerte_')) || (p.id && String(p.id).startsWith('Alerte_'))));

        for (const r of rows) {
            const rKey = r._key || r.id;
            const rTs = getTsSafe(r);

            if (rKey && seenKeys.has(rKey)) continue;

            if (uniqueRows.length > 0) {
                const prev = uniqueRows[uniqueRows.length - 1];
                const prevTs = getTsSafe(prev);

                if (rTs && prevTs && Math.abs(rTs - prevTs) < 2000) {
                    const currIsAlert = isAlertPoint(r);
                    const prevIsAlert = isAlertPoint(prev);

                    if (currIsAlert && !prevIsAlert) {
                        // L'alerte prime absolument sur une mesure normale arrivée au même instant : on la remplace !
                        uniqueRows[uniqueRows.length - 1] = r;
                        if (rKey) seenKeys.add(rKey);
                        continue;
                    } else if (!currIsAlert && prevIsAlert) {
                        // L'alerte précédente prime sur la mesure normale : ignorer la normale
                        continue;
                    } else if (currIsAlert && prevIsAlert) {
                        // Deux alertes au même instant (doublon d'événement) : garder celle qui a un diagnostic qualifié
                        const getBestDiag = (item) => (item && item.Diagnostic && item.Diagnostic !== '""' && item.Diagnostic !== 'null' ? item.Diagnostic : (item ? item.diagnostic : ''));
                        const currDiag = getBestDiag(r);
                        const prevDiag = getBestDiag(prev);
                        const currNamed = currDiag && currDiag !== 'Anomalie' && currDiag !== 'Vibration cyclique excessive';
                        const prevNamed = prevDiag && prevDiag !== 'Anomalie' && prevDiag !== 'Vibration cyclique excessive';
                        if (currNamed && !prevNamed) {
                            uniqueRows[uniqueRows.length - 1] = r;
                        }
                        continue;
                    } else {
                        // Deux mesures normales à moins de 2s : ignorer le doublon
                        continue;
                    }
                }
            }

            if (rKey) seenKeys.add(rKey);
            uniqueRows.push(r);
        }
        rows = uniqueRows;

        // Fenêtre glissante dynamique : toujours extraire les 'limit' (ex: 200) points les plus récents dans le temps
        const slice = rows.slice(-limit);
        const labels = slice.map(r => formatParisTime(r.timestamp_ts || r.timestamp));
        const values = slice.map(r => r[metric] !== undefined ? r[metric] : 0);
        const points = slice.map(r => ({
            key: r._key || r.id,
            id: r.id || r._key,
            timestamp: r.timestamp_ts || r.timestamp,
            time_display: formatParisTime(r.timestamp_ts || r.timestamp),
            score: r.anomaly_score !== undefined ? r.anomaly_score : 0,
            threshold: r.anomaly_threshold !== undefined ? r.anomaly_threshold : 100,
            status: r.status || "NORMAL",
            alert_origin: r.alert_origin || "",
            diagnostic: r.Diagnostic || r.diagnostic || "",
            vibration_rms: r.vibration_rms !== undefined ? r.vibration_rms : (r.vibration_mean || 0),
            vibration_peak: r.vibration_peak !== undefined ? r.vibration_peak : 0,
            sound_rms: r.sound_rms !== undefined ? r.sound_rms : (r.sound_mean || 0),
            device_name: r.device_name || "Capteur"
        }));

        res.json({
            metric,
            labels,
            values,
            points,
            count: values.length
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Routes et alias officiels pointant vers Historique
app.get('/api/historique', (req, res, next) => {
    req.url = '/api/telemetry/history';
    app.handle(req, res, next);
});
app.get('/api/historique/history', (req, res, next) => {
    req.url = '/api/telemetry/history';
    app.handle(req, res, next);
});
app.get('/api/historique/latest', (req, res, next) => {
    req.url = '/api/telemetry/latest';
    app.handle(req, res, next);
});

// -------------------------------------------------------------
// API : DÉCLENCHEMENT DE CALIBRATION À DISTANCE
// -------------------------------------------------------------
app.post('/api/devices/:id/calibrate', async (req, res) => {
    const rawId = req.params.id;
    const { mac } = req.body;
    const targetMac = mac || rawId;
    const cmdKey = String(targetMac).replace(/[:.]/g, '_');

    if (isFirebaseConnected) {
        await db.ref('commands').child(cmdKey).set({
            mac: targetMac,
            cmd: "START_CALIB",
            timestamp: Date.now()
        });
        console.log(`🎯 [CALIBRATION DISTANTE] Ordre START_CALIB transmis pour MAC ${targetMac}`);
        return res.json({ success: true, message: "Ordre de calibration transmis avec succès" });
    }
    res.json({ success: true, message: "Mode local (simulation calibration)" });
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

        // Lecture des alertes actives issues de la branche /Alertes (API Cloud)
        const altSnap = await db.ref('Alertes').once('value');
        const altData = altSnap.val() || {};
        for (const k of Object.keys(altData)) {
            const item = altData[k];
            if (item && item.Diagnostic && item.Diagnostic !== '""' && item.Diagnostic !== 'null') {
                list.push({
                    id: 'alt_' + k,
                    device_name: k,
                    message: item.Diagnostic,
                    status: 'open',
                    metric: 'Diagnostic IA',
                    value: item.scoreIA || 'Anomalie',
                    timestamp: formatParisFull(item.timestamp_ts || Date.now())
                });
            }
        }

        // Lecture des appareils en état ALERTE dans /Donnees_temps_reel
        const dtrSnap = await db.ref('Donnees_temps_reel').once('value');
        const dtrData = dtrSnap.val() || {};
        for (const k of Object.keys(dtrData)) {
            const item = dtrData[k];
            if (item && item.status === 'ALERTE') {
                const devN = item.device_name || k;
                if (!list.some(a => a.device_name === devN && a.status === 'open')) {
                    list.push({
                        id: 'dtr_' + k,
                        device_name: devN,
                        message: item.Diagnostic || item.diagnostic || 'Anomalie en cours',
                        status: 'open',
                        metric: 'Score IA',
                        value: item.anomaly_score !== undefined ? `${item.anomaly_score} pts` : 'Alerte',
                        timestamp: formatParisFull(item.timestamp_ts || Date.now())
                    });
                }
            }
        }

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
        if (id.startsWith('alt_')) {
            const cleanKey = id.replace('alt_', '');
            await db.ref('Alertes/' + cleanKey + '/Diagnostic').set("").catch(() => {});
        } else if (id.startsWith('dtr_')) {
            const cleanKey = id.replace('dtr_', '');
            await db.ref('Donnees_temps_reel/' + cleanKey + '/status').set("NORMAL").catch(() => {});
        } else {
            await db.ref('alerts/' + id).update({ status: 'resolved' }).catch(() => {});
        }
        return res.json({ success: true });
    }
    const alert = localAlerts.find(a => String(a.id) === String(id));
    if (alert) alert.status = 'resolved';
    res.json({ success: true });
});

// Démarrage du serveur
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Serveur Acoustique&Vibration démarré sur http://localhost:${PORT}`);
    console.log(`🔥 Mode Base de données : ${isFirebaseConnected ? 'Firebase Realtime Database' : 'Mémoire (prêt pour clé Firebase)'}`);
    console.log(`====================================================`);
});
