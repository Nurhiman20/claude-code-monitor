# Claude Code Monitor

Server lokal + dashboard real-time buat memantau sesi Claude Code kamu:
- **Budget harian** — jatah pemakaian limit mingguan per hari (default 14%), lengkap dengan sisa, pace ideal, dan riwayat 14 hari.
- Notifikasi desktop **dan** Telegram saat Claude butuh input, task selesai, atau limit usage mendekati batas.
- **Approve tool & jawab pertanyaan Claude dari Telegram** (opsional — lihat bagian 5).
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
| `Stop`            | Claude selesai merespons/menyelesaikan task | Notif desktop + Telegram **berisi ringkasan** (lihat bagian 6) |
| `SubagentStop`    | Subagent (Task tool) selesai                | Notif desktop + Telegram + ringkasan      |
| `PreToolUse`/`PostToolUse` | Setiap kali tool dipanggil/selesai   | Masuk ke live feed saja (tanpa notif, biar nggak spam) |
| `PreToolUse` (`ask.js permission`) | Sebelum tool berisiko dijalankan | Minta izin lewat Telegram/dashboard (kalau diaktifkan) |
| `Stop` (`ask.js question`)  | Claude berhenti sambil bertanya   | Pertanyaannya dikirim ke Telegram, balasanmu dikirim balik ke agent |
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

## 5. Approve & jawab dari Telegram (opsional, default mati)

Claude Code menjalankan hook `PreToolUse` dan `Stop` secara **sinkron** — selama hook belum selesai, agent-nya nunggu. `hooks/ask.js` memanfaatkan itu: dia menahan Claude, melempar pertanyaannya ke Telegram, lalu mengembalikan jawabanmu sebagai keputusan hook.

```
PreToolUse ─► ask.js ─► POST /api/ask (response ditahan)
                             │
                             ├─► Telegram: pesan + tombol [✅ Izinkan] [❌ Tolak]
                             │   (dan kartu di dashboard)
                             │
   Claude jalan/berhenti ◄───┘ jawaban → allow / deny
```

Untuk hook `Stop`, `ask.js` membaca pesan terakhir Claude dari transcript. Kalau isinya pertanyaan, pertanyaan itu dikirim ke Telegram; balasanmu dikembalikan sebagai `{"decision":"block","reason":"<jawabanmu>"}` — Claude membacanya seperti kamu mengetik langsung di terminal, lalu lanjut kerja.

### ⚠️ Baca dulu sebelum menyalakan

Menyetujui dari Telegram = mengeksekusi tool di komputer ini. Siapa pun yang bisa mengirim pesan ke bot itu bisa menjalankan `Bash` di mesinmu, jadi **bot token setara kunci SSH**. Karena itu fiturnya opt-in, dibatasi allowlist tool, dan bot hanya melayani `TELEGRAM_CHAT_ID` yang kamu set. Jangan pakai di komputer bersama, jangan commit `.env`.

### Setup

Tambahkan ke `server/.env`:

```
CCM_REMOTE_APPROVAL=1
CCM_ASK_TOOLS=Bash,Write,Edit,MultiEdit,NotebookEdit
CCM_REMOTE_QUESTIONS=1
```

Lalu di settings Claude Code, tambahkan dua entry dari `claude-settings-snippet.json` (`hooks/ask.js permission` di `PreToolUse`, `hooks/ask.js question` di `Stop`). **Field `timeout` wajib diisi** — default hook cuma 60 detik, nggak cukup buat nunggu kamu balas.

### Perilaku

- Timeout (default 4 menit untuk izin, 9 menit untuk pertanyaan) → hook diam, Claude Code balik ke prompt izin biasa di terminal. Semua jalur gagal (server mati, transcript nggak kebaca, fitur mati) juga diam — nggak pernah bikin sesi macet.
- Selama nunggu, sesi Claude Code memang **berhenti** di situ. Itu inheren: hook-nya sinkron.
- Hook `Stop` cuma ikut campur kalau pesan terakhir Claude memang mengandung tanda tanya. Mau semua Stop diteruskan: `CCM_ASK_ON_STOP=always`.
- Batas balas-balasan per sesi: `CCM_ASK_MAX_ROUNDS` (default 20), biar nggak jadi loop tanpa akhir.
- Kartu permintaan juga muncul di dashboard dengan tombol yang sama, plus hitung mundur.

### Perintah bot

| Perintah | Guna |
|----------|------|
| `/limit` | Limit & budget hari ini |
| `/pending` | Permintaan yang lagi nunggu jawaban |
| `/done` | Biarkan Claude berhenti (batal menjawab) |
| `/help` | Daftar perintah |
| _teks biasa_ | Jawaban buat pertanyaan Claude yang lagi nunggu |

## 6. Ringkasan task selesai

Waktu hook `Stop` masuk, server membaca **pesan terakhir Claude** dari transcript sesi itu, membuang Markdown-nya, lalu menempelkan jejak tool sejak Stop sebelumnya. Tanpa panggilan model tambahan — jadi nol biaya dan nol delay.

```
Task selesai — claude-monitor
Fix token expiry di auth.js. · ganti < jadi <=
2 tool · auth.js
```

| Env | Default | Guna |
|-----|---------|------|
| `CCM_STOP_SUMMARY` | `1` | `0` = balik ke teks generik |
| `CCM_SUMMARY_MAX_CHARS` | `180` | Panjang maksimal baris ringkasan |

Baris pertama diambil dari kalimat pembuka Claude (ditambah baris kedua kalau yang pertama pendek). Kalau transcript nggak kebaca, notifnya jatuh balik ke teks generik.

## API

| Endpoint | Guna |
|----------|------|
| `GET /api/daily` | Ringkasan hari ini: pemakaian, budget, sisa, pace, riwayat 14 hari |
| `PUT /api/daily/config` | Ubah `{ budgetPercent, dayStartHour }` |
| `GET /api/usage` | Snapshot per sesi (model, biaya, window terakhir) |
| `GET /api/events?limit=` | Event terakhir |
| `POST /api/ask` | Dipakai `hooks/ask.js`; response ditahan sampai dijawab atau timeout |
| `GET /api/ask/pending` | Permintaan izin/pertanyaan yang lagi nunggu |
| `POST /api/ask/:id/resolve` | Jawab dari dashboard: `{ decision: allow\|deny\|answer\|stop, answer }` |

## Struktur folder

```
claude-monitor/
├── server/
│   ├── index.js        ← backend: terima event, kirim notif, broadcast ke dashboard
│   ├── daily.js         ← akumulasi pemakaian harian + budget & alert
│   ├── store.js         ← penyimpanan event (JSONL) + status usage per sesi
│   ├── notifiers.js      ← desktop notif (node-notifier) + Telegram
│   ├── summary.js        ← ringkasan singkat saat task selesai
│   ├── transcript.js     ← baca pesan terakhir Claude dari file transcript
│   ├── bot.js            ← sisi masuk Telegram: perintah, tombol approve, jawaban
│   ├── approvals.js      ← aturan & pesan approval jarak jauh (allowlist, timeout)
│   ├── pending.js        ← permintaan yang lagi ditahan sambil nunggu jawaban
│   └── public/index.html ← dashboard
├── hooks/
│   ├── report.js         ← dipanggil hook Notification/Stop/SubagentStop/Pre/PostToolUse
│   ├── ask.js            ← hook blocking: minta izin / teruskan pertanyaan ke Telegram
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
