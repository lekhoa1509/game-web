# NES Web Player (HTML/CSS/JS)

Trang web tĩnh chạy game bằng Nostalgist.

- Trang chủ: [index.html](index.html)
- NES: [platforms/nes/nes.html](platforms/nes/nes.html)
- SNES: [platforms/snes/snes.html](platforms/snes/snes.html)
- GBA: [platforms/gba/gba.html](platforms/gba/gba.html)
- PSX: [platforms/psx/psx.html](platforms/psx/psx.html)
- NDS: [platforms/nds/nds.html](platforms/nds/nds.html)
- Windows 95 (WASM): [platforms/dos/dos.html](platforms/dos/dos.html)

Ghi chú: Trang đang load Nostalgist từ CDN: `https://unpkg.com/nostalgist`.

## SNES / GBA

- SNES chạy bằng Nostalgist + core `snes9x`.
- GBA chạy bằng Nostalgist + core `mgba`.
- App sẽ lọc theo cột `Platforms`/`Platform` trong Google Sheet nếu có (SNES: `snes`/`sfc`/"super nintendo"; GBA: `gba`/"game boy advance"). Nếu sheet không có cột platform thì sẽ hiện tất cả.

## NDS

Trang [platforms/nds/nds.html](platforms/nds/nds.html) chạy Nintendo DS bằng EmulatorJS.

- Không kèm ROM/BIOS.
- Bạn chọn ROM `.nds` từ máy.
- Nhiều game cần thêm các file BIOS/firmware (ví dụ `bios7.bin`, `bios9.bin`, `firmware.bin`).

## Màu sắc

Màu hiển thị sẽ giống Nostalgist (libretro core `fceumm`) vì app dùng đúng engine đó.

## 1) Chạy local

Vì `fetch()` không chạy ổn khi mở file trực tiếp (`file://`), hãy chạy bằng 1 server tĩnh.

- Nếu bạn có Node.js:

  - `npx serve`

- Nếu bạn có Python:
  - `python -m http.server 5173`

Sau đó mở `http://localhost:5173`.

## Chạy với Drive Proxy (khuyến nghị)

Nếu bạn có nhiều link Google Drive (nhất là link folder) và hay bị Google chặn kiểu **"We're sorry / unusual traffic"**, hãy chạy bằng proxy server đi kèm để:

- Trình duyệt KHÔNG gọi `googleapis.com` trực tiếp
- API key nằm ở server (không lộ trên client)
- Có throttle + retry + cache list folder

### 1) Cài và chạy

- Cài Node.js (LTS)
- Mở terminal tại thư mục project và chạy:

  - `npm install`
  - PowerShell (Windows):
    - `$env:DRIVE_API_KEY="YOUR_KEY"; npm start`

Bạn cũng có thể tạo file `.env` (khuyến nghị) dựa theo `.env.example` để:

- không phải set biến môi trường mỗi lần
- cấu hình bảo mật (origin allowlist / allowlist Drive IDs / rate limit)

Mặc định server chạy tại `http://localhost:5173` và serve luôn trang web (NES/PSX).

Nếu bạn gặp lỗi `EADDRINUSE` (port 5173 đang bị dùng), hãy đổi `PORT` trong `.env` (ví dụ 5180) hoặc tắt tiến trình đang dùng port đó.

### 2) Cấu hình trên client

Mặc định đã bật proxy:

- [app.js](app.js): `USE_DRIVE_PROXY = true`
- [psx-app.js](psx-app.js): `USE_DRIVE_PROXY = true`

Nếu bạn host frontend ở domain khác (không cùng origin với server), hãy set `DRIVE_PROXY_BASE` thành URL server (ví dụ `http://localhost:5173`).

## Public lên website: bảo mật tối đa (khuyến nghị)

Mục tiêu: không lộ API key, giảm nguy cơ bị người khác abuse proxy để ăn quota.

1. **Không nhúng key vào client**

- `app.js` và `psx-app.js` đã để `DRIVE_API_KEY = ""` (đúng).
- Chỉ set `DRIVE_API_KEY` ở server qua `.env`/env.

2. **Khóa API key trong Google Cloud Console**

- API restrictions: chỉ bật **Google Drive API** cho key này.
- Application restrictions: với server-side proxy thì thường để "None"; nếu bạn có IP tĩnh thì có thể hạn chế theo IP để chắc hơn.

3. **Bật allowlist cho Drive IDs (quan trọng nhất)**

Trong `.env`:

- `ALLOWED_DRIVE_FOLDER_IDS=<FOLDER_ID_1>,<FOLDER_ID_2>`
- (tuỳ chọn) `ALLOWED_DRIVE_FILE_IDS=<FILE_ID_1>,<FILE_ID_2>`

Khi set allowlist, server sẽ chặn mọi request `/api/drive/*` không nằm trong danh sách (tránh bị gọi download file Drive random).

4. **Giới hạn domain được gọi proxy (CORS allowlist)**

Nếu frontend và server khác domain, set:

- `ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com`

5. **Rate limit**

Server có rate limit in-memory cho `/api/drive/*`:

- `RATE_LIMIT_MAX` và `RATE_LIMIT_WINDOW_MS` (xem `.env.example`).

6. **TRUST_PROXY (chỉ khi có reverse proxy)**

Nếu deploy sau Cloudflare/Nginx/Vercel… set `TRUST_PROXY=1` để rate limit lấy đúng IP client.

## PSX (trang riêng)

Mở [platforms/psx/psx.html](platforms/psx/psx.html) để chạy PS1 bằng Nostalgist (core `pcsx_rearmed`).

- PSX dùng cùng kiểu UI như NES: tải danh sách game từ Google Sheet và chạy ROM từ link.
- App lọc theo cột `Platforms/Platform` (chỉ hiện các dòng có `psx` / `ps1` / `playstation`).
- BIOS: đặt file tại `bios/SCPH1001.bin` (xem thêm [bios/README.md](bios/README.md)).

## Windows 95 (WASM) local launcher

Mở [platforms/dos/dos.html](platforms/dos/dos.html) để boot Windows 95 (WASM) bằng js-dos v8 (DOSBox-X), rồi chạy `.EXE` bên trong Win95.

- Trang này dùng thư viện `js-dos` từ CDN.
- Bạn cần chuẩn bị bundle định dạng **.jsdos** (Win9x bundle). Trang không kèm game/asset.

## 2) Lấy danh sách game từ Google Sheet

App đang đọc sheet theo 2 cột **Name** và **Link** (hàng đầu là header).

Sheet id hiện được cấu hình sẵn trong `app.js`:

- `SHEET_ID = 1K2gbc06V4UxFcZWOZGk1ML7zUUc6-vzT_CaPB2Cx4Q4`
- `SHEET_TAB_NAME = Sheet1`

## 3) Vấn đề "link là folder Drive" và cách chạy ROM

Trình duyệt không thể chạy ROM "trực tiếp từ folder" nếu không có cách:

- liệt kê được file trong folder
- lấy được bytes của file `.nes`

Có 2 cách:

### Cách A (khuyến nghị): đưa Link thành URL tải ROM trực tiếp

Trong Sheet, cột **Link** để thẳng URL `.nes` (host có CORS) hoặc link download trực tiếp.

### Cách B: dùng Google Drive API để lấy ROM từ folder

Nếu cột **Link** là `https://drive.google.com/drive/folders/<FOLDER_ID>`:

1. Đảm bảo ROM trong folder được share public (Anyone with the link).
2. Vào Google Cloud Console:
   - Enable **Google Drive API**
   - Tạo **API key**
3. (Không khuyến nghị) Không nên nhúng API key vào file JS phía client vì sẽ bị lộ.

Nếu bạn cần dùng link folder Drive, hãy dùng **Cách C (Drive Proxy)** để API key nằm ở server.

App sẽ:

- list folder (Drive API)
- tìm file đầu tiên có đuôi `.nes`
- tải bằng `alt=media`

> Lưu ý: Nếu folder có nhiều ROM, hiện tại app sẽ chọn ROM `.nes` đầu tiên.

### Cách C (khuyến nghị): dùng Drive Proxy server

Chạy theo mục **Chạy với Drive Proxy** ở trên. Khi đó app vẫn dùng link folder/file như cũ trong Sheet nhưng sẽ gọi `/api/drive/*` thay vì gọi Drive API từ trình duyệt.
