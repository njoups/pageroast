# Menjalankan CivicSignal di Laptop

Panduan ini untuk mencoba CivicSignal di laptop sendiri (Windows, macOS atau Linux) **tanpa perlu menginstal Node, PostgreSQL atau Redis**. Semuanya berjalan di dalam Docker.
Setup ini hanya untuk percobaan lokal. Jangan dibuka ke jaringan publik. Untuk staging dan production, lihat [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Yang dibutuhkan
- **Docker Desktop**: https://www.docker.com/products/docker-desktop/. Instal, buka, lalu tunggu sampai statusnya *running*.
  - Windows: Docker Desktop akan meminta mengaktifkan WSL 2. Ikuti saja.
- **RAM:** minimal 8 GB (disarankan 16 GB). Di Docker Desktop → Settings → Resources, beri minimal 4 GB memory.
- **Disk kosong:** sekitar 6 GB.
- **Internet:** untuk build pertama (mengunduh dependensi) dan untuk mengambil berita dari feed RSS.
- **Browser:** Chrome, Edge atau Firefox. Safari kadang menolak cookie login di `http://localhost`.

## 2. Ambil kode
Pilih salah satu:
- **Dengan Git:** `git clone https://github.com/njoups/pageroast.git`, lalu `cd pageroast`, lalu `git checkout claude/youthful-darwin-rk5mhl`.
- **Tanpa Git:**
  1. Buka repo di GitHub dan pilih branch `claude/youthful-darwin-rk5mhl`.
  2. Klik **Code → Download ZIP**, lalu ekstrak.

Kalau repo sudah dijadikan private, Anda harus login GitHub dulu.

Masuk ke folder `civicsignal` di dalamnya. Semua perintah di bawah dijalankan dari folder itu.

## 3. Jalankan (satu perintah)
**macOS / Linux** (Terminal):
```bash
bash scripts/local-up.sh
```
**Windows** (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-up.ps1
```

Yang dilakukan script:
- membuat file `.env` berisi password acak khusus laptop ini. File ini jangan dibagikan atau di-commit;
- memilih port lain secara otomatis kalau port 3000, 5432 atau 8025 sudah dipakai aplikasi lain;
- mem-build aplikasi. Build pertama butuh **5–10 menit**; berikutnya cepat;
- menunggu sampai semua layanan sehat, lalu menampilkan alamatnya.

Setelah selesai:

| Alamat | Isi |
|---|---|
| http://localhost:3000 | Aplikasi CivicSignal |
| http://localhost:8025 | **Kotak masuk email lokal (Mailpit).** Semua email dari aplikasi (alert, laporan, reset password) masuk ke sini, tidak ke email sungguhan |

Kalau script memilih port lain, alamat yang benar tertulis di akhir output.

## 4. Mencoba alurnya (±15 menit)
1. **Daftar:** buka aplikasi, klik **Register**, isi email (boleh fiktif, misalnya `saya@contoh.test`), nama dan password (minimal 12 karakter).
2. **Buat organisasi:** isi nama organisasi. Organisasi baru otomatis memakai paket **trial 14 hari**. Setelah trial habis, akses menjadi baca-saja; lihat langkah 9 untuk memperpanjangnya.
3. **Atur zona waktu:** Admin → Organization → Timezone (misalnya `Asia/Jakarta`). Zona waktu ini menentukan batas hari di analytics dan laporan.
4. **Ikuti halaman *Getting started*:** checklist onboarding di dalam aplikasi menunjukkan langkah berikutnya.
5. **Tambah sumber berita:** Sources → Add source, isi URL feed RSS. Dua feed ini pernah diuji berhasil:
   - `https://www.antaranews.com/rss/terkini.xml` (ANTARA, berita terkini)
   - `https://www.cnnindonesia.com/nasional/rss` (CNN Indonesia, nasional)

   Isi *authorization basis* dengan keterangan bahwa ini untuk uji coba internal. Untuk pelanggan sungguhan, ketentuan penerbit harus ditinjau dulu (DATA_GOVERNANCE.md). Aktifkan sumbernya, lalu klik **Collect now**.
6. **Buat project dan kata kunci:** Projects → buat project, lalu tambahkan query dengan kata kunci yang sedang ramai, misalnya `banjir OR macet`. Berita yang cocok muncul di **Mentions**, dan grafik muncul di **Overview/Analytics**.
7. **Alert:** Alerts → buat rule tipe keyword. Klik **Dry run on current data** untuk melihat apa yang akan terdeteksi. Setelah rule aktif, worker mengevaluasinya setiap menit. Saat rule terpicu oleh berita baru, issue muncul di aplikasi, dan email alert masuk ke http://localhost:8025 (sesuai pengaturan notifikasi Anda).
8. **Laporan:** Reports → buat definisi laporan (misalnya mingguan), klik **Generate previous period** atau **Generate custom period**, lalu unduh PDF/CSV setelah selesai.
9. **Konsol platform (opsional):** jadikan akun Anda platform administrator:
   ```bash
   docker compose run --rm migrate node apps/api/dist/database/promote-platform-admin-cli.js saya@contoh.test
   ```
   Lalu buka http://localhost:3000/platform. Dari sini Anda bisa melihat tenant, paket, biaya, dan memperpanjang atau mengganti paket organisasi.

**Tentang analisis AI:** tanpa API key, analisis memakai *baseline* berbasis aturan. Hasilnya diberi label, dan perkiraan sentimennya masih kasar. Untuk mencoba model AI, isi `ANTHROPIC_API_KEY` di `.env` lalu jalankan ulang. **Ini memakai kredit API berbayar.**

## 5. Sehari-hari

| Mau apa | Perintah |
|---|---|
| Menghentikan (data tetap tersimpan) | `docker compose stop` |
| Menyalakan lagi | `bash scripts/local-up.sh --no-build` (Windows: `... local-up.ps1 -NoBuild`) |
| Memperbarui setelah menarik kode baru | `bash scripts/local-up.sh` (build ulang) |
| Melihat log kalau ada error | `docker compose logs --tail 100 api worker web` |
| Menghapus semua data dan mulai dari nol | `docker compose down -v`, lalu hapus file `.env`, lalu jalankan script lagi |

## 6. Kalau ada masalah

| Gejala | Solusi |
|---|---|
| "Docker is not running" | Buka Docker Desktop dan tunggu sampai *running* |
| Build gagal saat mengunduh (`npm ci`, `apt-get`) | Periksa internet, VPN atau proxy kantor, lalu jalankan ulang |
| "Some services did not become healthy" | Jalankan `docker compose logs --tail 100 api worker web`. Biasanya memory Docker kurang: naikkan di Settings → Resources |
| Login berhasil tapi langsung keluar lagi | Gunakan Chrome, Edge atau Firefox, bukan Safari |
| Berita tidak masuk | Pastikan sumber diaktifkan, lalu klik Collect now dan cek status run di halaman Sources. Beberapa situs memblokir atau mengubah feed-nya |
| Email tidak terlihat | Buka http://localhost:8025 (atau port yang tertulis di output script) |

## 7. Batasan
- Setup lokal ini tidak memakai HTTPS. Itu hanya aman di `localhost`; jangan dibuka ke jaringan lain.
- Data ada di Docker volume di laptop Anda, tanpa backup. Jangan simpan data penting di sini.
- Integrasi YouTube, WhatsApp dan pembayaran tidak aktif kecuali dikonfigurasi. Pembayaran memang belum ada.
- Kode yang sama sudah diuji otomatis (CI). Setup lokal ini sudah dicoba berjalan penuh di container development (lihat bagian verifikasi di [PILOT_DEPLOYMENT_AUDIT.md](PILOT_DEPLOYMENT_AUDIT.md)), tetapi belum dicoba di laptop Windows atau macOS sungguhan.
