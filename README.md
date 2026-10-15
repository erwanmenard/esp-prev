# 🛡️ Sentinelle — Centre de Contrôle IoT

Interface web épurée, claire et performante pour la surveillance acoustique et vibratoire de machines tournantes (CTA).
Le projet est conçu avec un code **simple, lisible et facile à modifier**, sans usine à gaz (Python Flask + HTML / CSS / JS Vanilla + Chart.js).

---

## 📁 Structure du projet

```
site/
├── server.js              # Serveur web Node.js & API REST (Express + Firebase)
├── package.json           # Dépendances Node.js (express, cors, firebase-admin)
├── serviceAccountKey.json # Clé privée Firebase (à ajouter une fois créée)
├── raspberry_sender.py    # Passerelle pour le Raspberry Pi (Mode réel ou Simulation)
├── render.yaml            # Fichier de déploiement automatique sur Render (runtime Node)
├── templates/
│   └── index.html         # Page unique moderne, réactive et sombre
└── static/
    ├── css/
    │   └── style.css      # Thème sombre / clair inspiré fidèlement de Sentinelle
    └── js/
        └── app.js         # Logique temps réel, graphiques Chart.js et menu compte
```

---

## 🚀 1. Lancement en local sur votre PC

### Étape 1 : Démarrer le serveur Node.js
Dans un terminal, placez-vous dans le dossier `site` :
```bash
npm start
# ou : node server.js
```
Le site démarre sur **http://localhost:5000**. Ouvrez-le dans votre navigateur.

### Étape 2 : Lancer le flux de mesures (Raspberry Pi ou Simulation)
Dans un **deuxième terminal** :
```bash
python raspberry_sender.py
```
- Si un ESP32 est branché en USB, il transmet les paquets radio ESP-NOW.
- Sans ESP32 branché, il active le **mode Simulation** et envoie des données de CTA toutes les 5 secondes.
- Vous verrez instantanément les valeurs changer, la courbe s'animer et le profil réagir !

---

## 🔥 2. Guide Pas-à-Pas : Créer sa base de données Firebase (Firestore)

1. Rendez-vous sur la [Console Firebase](https://console.firebase.google.com/) et connectez-vous avec votre compte Google.
2. Cliquez sur **Créer un projet** (ex: `sentinelle-cta`).
3. Dans le menu de gauche, allez dans **Build** $\rightarrow$ **Firestore Database**.
4. Cliquez sur **Créer une base de données** :
   - Choisissez l'emplacement : `europe-west9` (Paris) ou `europe-west1` (Belgique).
   - Règles de sécurité : Choisissez **Démarrer en mode test** (pour les 30 premiers jours).
5. **Générer la clé secrète pour le serveur** :
   - Cliquez sur l'icône **⚙ (Paramètres du projet)** en haut à gauche à côté de "Vue d'ensemble du projet".
   - Allez dans l'onglet **Comptes de service** (*Service accounts*).
   - Cliquez sur le bouton bleu **Générer une nouvelle clé privée** (*Generate new private key*).
   - Un fichier `.json` est téléchargé sur votre ordinateur.
6. **Liaison avec le projet** :
   - Renommez ce fichier téléchargé en : `serviceAccountKey.json`.
   - Déposez-le simplement dans le dossier `site/`.
   - Redémarrez le serveur : il affichera automatiquement :
     `🔥 Connecté à Firebase Firestore avec succès (fichier clé)`.

---

## 🌐 3. Déploiement sur Render

1. Poussez votre dossier sur GitHub (sans commiter `serviceAccountKey.json` pour la sécurité).
2. Sur [render.com](https://render.com) : **New +** $\rightarrow$ **Web Service**.
3. Choisissez l'environnement **Node**.
   - **Build Command** : `npm install`
   - **Start Command** : `node server.js`
4. *(Optionnel avec Firebase)* : Dans **Environment Variables** sur Render, ajoutez `FIREBASE_CONFIG_JSON` et collez le contenu textuel de votre `serviceAccountKey.json`.
5. Votre site est en ligne partout dans le monde !
