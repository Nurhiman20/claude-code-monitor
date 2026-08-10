# Claude Code Monitor

Server lokal + dashboard real-time buat memantau sesi Claude Code kamu:
- **Budget harian** — jatah pemakaian limit mingguan per hari (default 14%), lengkap dengan sisa, pace ideal, dan riwayat 14 hari.
- Notifikasi desktop **dan** Telegram saat Claude butuh input, task selesai, atau limit usage mendekati batas.
- Live feed progress (tool apa yang sedang/sudah dijalankan Claude).
- Kartu window 5 jam & mingguan dengan progress bar dan hitung mundur reset.

## 1. Install dependency server

```bash
cd claude-monitor/server
npm install
cp .env.example .env
```

Edit `.env` kalau mau notifikasi Telegram (opsional — tanpa ini kamu tetap dapat notifikasi desktop):

```
CCM_PORT=4756
TELEGRAM_BOT_TOKEN=xxxx
TELEGRAM_CHAT_ID=xxxx
```

Cara dapat token & chat id ada di komentar dalam `.env.example`.

## 2. Jalankan server

```bash
npm start
```

Buka dashboard di **http://localhost:4756**. Biarkan proses ini jalan di background (pakai `pm2`, `tmux`, atau `nohup` kalau mau permanen).

## 3. Sambungkan Claude Code lewat Hooks

Buka (atau buat) file settings Claude Code:
- Global: `~/.claude/settings.json`
- Atau per-project: `.claude/settings.json` di root proyek

Merge isi `claude-settings-snippet.json` ke situ, lalu **ganti `/ABSOLUTE/PATH/TO/claude-monitor`** dengan path absolut ke folder ini di komputer kamu, misalnya:

```
/Users/nama-kamu/claude-monitor
```

Event yang disambungkan:

| Hook event      | Kapan terpicu                              | Efek di app ini                          |
|------------------|---------------------------------------------|-------------------------------------------|
| `Notification`   | Claude butuh input/izin dari kamu           | Notif desktop + Telegram                  |
| `Stop`            | Claude selesai merespons/menyelesaikan task | Notif desktop + Telegram                  |
| `SubagentStop`    | Subagent (Task tool) selesai                | Notif desktop + Telegram                  |
| `PreToolUse`/`PostToolUse` | Setiap kali tool dipanggil/selesai   | Masuk ke live feed saja (tanpa notif, biar nggak spam) |
| `statusLine`      | Dipanggil berkala oleh Claude Code          | Update budget harian + window 5 jam/mingguan, alert budget di 50/80/100/120% dan window di 50/75/90% |

## 4. Budget harian

Claude Code cuma melaporkan total window berjalan (`five_hour` dan `seven_day`), nggak pernah "hari ini kepakai berapa". Jadi server mengambil sampel `seven_day.used_percentage` tiap kali hook `statusLine` jalan, lalu **menjumlahkan kenaikannya** ke dalam ember per hari. Angka itulah yang dibandingkan dengan budget harian.

- Default budget **14%** limit mingguan per hari (≈ habis pas 7 hari). Ubah lewat input di kartu "Budget harian" — langsung tersimpan, tanpa tombol save.
- Batas hari default jam `00:00` lokal; bisa digeser (misal jam 04:00) lewat dropdown di kartu yang sama.
- Notifikasi desktop + Telegram di **50%, 80%, 100%, dan 120%** budget harian. Kalau satu sampel melompati dua ambang sekaligus, yang dinotifikasi cuma yang tertinggi.
- **Pace ideal** = sisa limit mingguan ÷ sisa hari sampai window mingguan reset. Ditandai garis biru di bar — kalau isian bar belum melewatinya, kamu masih di jalur aman.
- Status bar Claude Code ikut menampilkan `hari 6/14%` (hijau/kuning/merah). Matikan dengan `CCM_STATUSLINE_SUFFIX=0`.

Catatan: sampel **pertama** setelah tracking dimulai cuma dipakai sebagai baseline (tidak dihitung sebagai pemakaian hari itu), supaya total window yang sudah berjalan sebelum server nyala tidak salah dibebankan ke hari pertama. Data tersimpan di `server/data/daily-usage.json` dan tahan restart; riwayat disimpan 60 hari.

### Kalau angkanya kosong

Skema `rate_limits` bisa berbeda antar versi Claude Code. Kalau kartu usage tidak terisi:
- Update Claude Code ke versi terbaru (`claude update` atau lewat npm).
- Cek event bertipe `usage` di `server/data/events.log` — kalau nama fieldnya beda, sesuaikan `normWindow()` di `server/index.js`.
- Sebagai fallback, kamu tetap bisa cek manual dengan `/usage` di dalam Claude Code.

## API

| Endpoint | Guna |
|----------|------|
| `GET /api/daily` | Ringkasan hari ini: pemakaian, budget, sisa, pace, riwayat 14 hari |
| `PUT /api/daily/config` | Ubah `{ budgetPercent, dayStartHour }` |
| `GET /api/usage` | Snapshot per sesi (model, biaya, window terakhir) |
| `GET /api/events?limit=` | Event terakhir |

## Struktur folder

```
claude-monitor/
├── server/
│   ├── index.js        ← backend: terima event, kirim notif, broadcast ke dashboard
│   ├── daily.js         ← akumulasi pemakaian harian + budget & alert
│   ├── store.js         ← penyimpanan event (JSONL) + status usage per sesi
│   ├── notifiers.js      ← desktop notif (node-notifier) + Telegram
│   └── public/index.html ← dashboard
├── hooks/
│   ├── report.js         ← dipanggil hook Notification/Stop/SubagentStop/Pre/PostToolUse
│   ├── statusline.js     ← hook statusLine: kirim usage + render status bar
│   └── statusline-wrapper.js ← sama, tapi tetap pakai status bar dari plugin lain
└── claude-settings-snippet.json
```

## Menjalankan otomatis saat startup (opsional)

```bash
npm install -g pm2
cd server
pm2 start index.js --name claude-monitor
pm2 save
pm2 startup   # ikuti instruksi yang muncul
```
