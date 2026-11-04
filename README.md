# Acoustic&Vibration

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
