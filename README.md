# BrowserBench

CPU- und GPU-Benchmark, der komplett im Browser läuft – mit Nutzerkonten, Leaderboard und Durchschnittsvergleich pro CPU-/GPU-Modell.

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)

## Features

**Benchmark**
- CPU Single-Core und Multi-Core (Web Worker, alle verfügbaren Threads)
- GPU über einen rechenintensiven WebGL2-Fragment-Shader; der GPU-Name wird automatisch erkannt
- Hinweis bei Software-Rendering (SwiftShader, llvmpipe), da der GPU-Wert dann nicht aussagekräftig ist

**Auswertung**
- Leaderboard (bester Wert pro User) für CPU Multi, CPU Single und GPU
- Durchschnittsvergleich je CPU- und GPU-Modell mit Balkendiagramm, Anzahl Messungen und User
- Persönliches Profil mit Verlauf, Durchschnitt und Bestwerten

**Konten und Sicherheit**
- Registrierung und Login mit bcrypt-Passwort-Hashing
- E-Mail-Verifizierung (Link, 24 h gültig, einmal nutzbar); Ergebnisse speichern erst nach Bestätigung
- TOTP-2FA (Authenticator-App, QR-Code) mit 8 Recovery-Codes
- Passwort ändern, Konto inklusive aller Daten löschen
- 2FA-Secrets AES-256-GCM-verschlüsselt in der Datenbank
- Serverseitige Sessions (httpOnly-Cookie, `SameSite=Strict`), Rate-Limiting, Helmet/CSP, CSRF-Header-Prüfung

**Admin-Moderation**
- User sperren, entsperren und löschen (Sperre beendet sofort alle Sitzungen)
- Ergebnisse aus- und einblenden oder löschen; ausgeblendete Werte und gesperrte User zählen nicht in Leaderboard und Durchschnitt
- Alle Admin-Aktionen werden in der Tabelle `admin_log` protokolliert

## Schnellstart

Voraussetzung: Node.js ≥ 20.

```bash
git clone https://github.com/arthurbaer/browserbench.git
cd browserbench
cp .env.example .env        # APP_SECRET setzen: openssl rand -hex 32
npm install
export $(grep -v '^#' .env | xargs) && npm start
```

Danach ist die App unter http://localhost:3000 erreichbar. Ohne HTTPS (lokaler Test) muss `COOKIE_SECURE=false` gesetzt sein, sonst werden Login-Cookies nicht gespeichert.

## Konfiguration

Alle Einstellungen erfolgen über Umgebungsvariablen (Vorlage: `.env.example`).

| Variable | Pflicht | Standard | Beschreibung |
|---|---|---|---|
| `APP_SECRET` | ja | – | Mind. 32 Zeichen; verschlüsselt die 2FA-Secrets. **Nach dem Start nicht mehr ändern**, sonst sind gespeicherte 2FA-Secrets unlesbar. |
| `PORT` | nein | `3000` | HTTP-Port |
| `DB_PATH` | nein | `./data/bench.db` | Pfad zur SQLite-Datenbank |
| `COOKIE_SECURE` | nein | `true` | Auf `false` setzen, wenn ohne HTTPS betrieben wird |
| `BASE_URL` | nein | `http://localhost:3000` | Öffentliche Adresse, wird in Verifizierungs-Links verwendet |
| `ADMIN_EMAIL` | nein | – | Wer sich mit dieser Adresse registriert und sie bestätigt, wird Admin |
| `SMTP_HOST` | nein | – | SMTP-Server; ohne Angabe wird der Link nur ins Server-Log geschrieben |
| `SMTP_PORT` | nein | `587` | Port 465 aktiviert implizites TLS |
| `SMTP_USER` / `SMTP_PASS` | nein | – | SMTP-Zugangsdaten |
| `MAIL_FROM` | nein | `BrowserBench <noreply@localhost>` | Absender der Mails |

## Betrieb mit Docker

```bash
docker build -t browserbench .
docker run -d --name browserbench -p 3000:3000 \
  -e APP_SECRET=<geheimer-string> \
  -e BASE_URL=https://bench.example.com \
  -e ADMIN_EMAIL=admin@example.com \
  -v browserbench-data:/app/data \
  browserbench
```

Wichtig:
- Das Verzeichnis `/app/data` muss persistent sein (Volume oder Host-Pfad), dort liegt die SQLite-Datenbank. Der Container läuft als User `node` (UID 1000), der Pfad muss für ihn beschreibbar sein.
- Hinter einem Reverse Proxy (z. B. NPMplus) mit HTTPS betreiben und `X-Forwarded-For` weiterreichen. Die App vertraut einem Proxy-Hop (`trust proxy = 1`), das Rate-Limiting arbeitet damit pro Client-IP.
- Bei einer Custom App auf TrueNAS SCALE die oben genannten Variablen im Environment-Bereich eintragen und `/app/data` auf ein Dataset mappen.

## So wird gemessen

| Wert | Messung | Einheit |
|---|---|---|
| CPU Single | 3 s Last in einem Worker (Integer-Hash, Float-Mathematik, Sortierung) | Iterationen pro ms |
| CPU Multi | gleiche Last parallel auf `navigator.hardwareConcurrency` Workern | Summe der Iterationen pro ms |
| GPU | 4 s Fullscreen-Shader (1024×1024, 300 Iterationen je Pixel), Synchronisation per `readPixels` | Shader-Iterationen pro s ÷ 10⁸ |

Die Werte sind nur untereinander vergleichbar, nicht mit anderen Benchmarks. Für reproduzierbare Ergebnisse den Tab im Vordergrund lassen und andere Last vermeiden.

## API

Alle schreibenden Requests brauchen den Header `X-Requested-With: bench` und ein JSON-Body.

| Methode | Pfad | Zugriff | Zweck |
|---|---|---|---|
| POST | `/api/register`, `/api/login`, `/api/logout` | öffentlich | Konto und Sitzung |
| POST | `/api/login/2fa` | Zwischen-Session | TOTP- oder Recovery-Code nach Passwort-Login |
| GET | `/verify?token=…` | öffentlich | E-Mail-Bestätigung |
| POST | `/api/verify/resend` | Login | Bestätigungsmail erneut senden |
| GET / DELETE | `/api/me` | Login | Profil, Verlauf, Durchschnitt / Konto löschen |
| POST | `/api/password` | Login | Passwort ändern |
| POST | `/api/2fa/setup`, `/enable`, `/disable` | Login | 2FA einrichten, aktivieren, deaktivieren |
| POST / DELETE | `/api/scores`, `/api/scores/:id` | Login (bestätigt) | Ergebnis speichern / eigenes löschen |
| GET | `/api/leaderboard?type=cpu_multi\|cpu_single\|gpu` | öffentlich | Bestenliste |
| GET | `/api/stats/cpus`, `/api/stats/gpus` | öffentlich | Durchschnitt je Modell |
| GET / POST / DELETE | `/api/admin/users…`, `/api/admin/scores…` | Admin | Moderation |

## Projektstruktur

```
server.js          Express-Server, Auth, 2FA, Mail, Scores, Admin
public/
  index.html       Single-Page-Oberfläche
  app.js           Views, Benchmarks (CPU/GPU), API-Client
  worker.js        CPU-Last für die Web Worker
  style.css        Styling (Hell/Dunkel automatisch)
Dockerfile
.env.example
```

## Bekannte Grenzen

- **Kein Manipulationsschutz:** Die Werte werden im Browser gemessen und können gefälscht werden. Deshalb gibt es die Admin-Moderation, aber keine technische Garantie.
- **CPU-Modell manuell:** Browser können das CPU-Modell nicht auslesen. Es wird eingegeben, mit Vorschlägen aus bestehenden Einträgen; unterschiedliche Schreibweisen erzeugen getrennte Einträge im Vergleich.
- **Datenschutz der Browser:** `hardwareConcurrency` und der GPU-Name können von Browsern verschleiert oder begrenzt werden.
- **Kein Passwort-Reset per Mail:** Wer Passwort und 2FA-Gerät samt Recovery-Codes verliert, braucht einen manuellen Eingriff in die Datenbank.
- **Datenschutz-Hinweis:** Die App speichert E-Mail-Adressen und Benutzernamen. Bei öffentlichem Betrieb in der EU Datenschutzerklärung und Impressum ergänzen.
