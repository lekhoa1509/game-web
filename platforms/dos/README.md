# Windows 95 (WASM) – Chuẩn bị bundle để chạy (js-dos v8)

Trang Win95 trong project này chạy bằng **js-dos v8** (WASM) với backend **DOSBox-X**. Bạn sẽ boot Windows 95 trong browser, sau đó mở và chạy **`.EXE`** ngay bên trong Win95.

## 1) Cần đuôi file gì?

**Khuyến nghị dùng:** `*.jsdos` (bundle)

- `.jsdos` thực chất là **một file ZIP** nhưng đổi đuôi thành `.jsdos`.
- Bên trong `.jsdos` phải có ít nhất file cấu hình bắt buộc: **`.jsdos/dosbox.conf`**

> Lưu ý: js-dos **sẽ không chạy** nếu thiếu `.jsdos/dosbox.conf`.

## 2) Trong bundle `.jsdos` cần những file gì?

Tối thiểu (bắt buộc):

- `.jsdos/dosbox.conf` (BẮT BUỘC)

Với **Windows 95**, bundle thường là:

- Một **base image Win95/Win98** (đã cài OS sẵn) được tạo từ Game Studio
- Game/program files được copy/cài vào trong Windows

Tuỳ chọn:

- `.jsdos/jsdos.json` (không bắt buộc) – cấu hình bổ sung riêng của js-dos (ví dụ mobile controls, layer, v.v.).

Ví dụ bundle Win9x (khái niệm):

```
win95-game.jsdos  (ZIP renamed)
├─ .jsdos/
│  ├─ dosbox.conf
│  └─ jsdos.json          (optional)
└─ (các file hệ thống/ổ đĩa ảo do Game Studio tạo)
```

## 3) Boot Win95 và chạy `.EXE` như nào?

Với Win9x bundle kiểu Game Studio, cách phổ biến là cấu hình `[autoexec]` để **boot ổ C:** (ổ đã cài Windows):

```ini
[autoexec]
@echo off
boot c:
```

Sau khi Windows 95 boot xong:

- Bạn mở `My Computer` / `Explorer`
- Tìm tới thư mục game/program
- Chạy file **`.EXE`** (hoặc chạy `SETUP.EXE` để cài)

## 4) Cách tạo bundle Win95 `.jsdos`

### Cách dễ nhất (khuyên dùng): Game Studio (Win95 base image)

- Vào: https://v8.js-dos.com/studio
- Tải base image Windows (Win95/Win98)
- Load base image → Run
- Upload file/folder game, mount vào `D:` (ví dụ: `mount d .` hoặc `imgmount d cd.iso`)
- Boot Windows: `boot c:`
- Cài game / copy file vào ổ `C:` trong Windows
- Restart → set `[autoexec]` thành `boot c:` → test → Export ra `.jsdos`

### Cách nâng cao: tự cài OS (nếu bạn có bộ cài hợp pháp)

Nếu bạn muốn tự tạo Windows 95/98 image từ đầu (không dùng base image), xem hướng dẫn “Install OS” của js-dos.

Lưu ý bản quyền: bạn **phải** có quyền sử dụng ISO/bộ cài Windows.

## 5) Upload lên Google Drive như thế nào?

- Upload file `win95-game.jsdos` lên Drive
- Đặt quyền chia sẻ: **Anyone with the link – Viewer**
- Nếu bạn muốn “play trực tiếp từ link”, cần đảm bảo CORS/Range hoạt động. Cách ổn định nhất thường là host tĩnh (không phải Drive).
- Với project này hiện tại, bạn có thể tải `.jsdos` về máy rồi chọn bằng nút chọn file.

Gợi ý:

- Nếu bạn dùng link kiểu `drive.google.com/file/d/<ID>/view` thì hệ thống sẽ lấy được file theo `<ID>`.
- Tránh các link yêu cầu đăng nhập.

## 6) Lưu ý dung lượng (Win95 thường rất nặng)

- Win95/Win98 bundle thường dùng ổ QCOW2 nên rất lớn và **không hợp để publish nguyên cục**.
- Nếu bạn muốn deploy/public/play nhanh: xem “Windows 9x (sockdrive)” và “Publish Sockdrive bundle”.

Tài liệu chính chủ:

- Getting started: https://js-dos.com/dos-api.html
- Windows 9x (sockdrive): https://js-dos.com/win9x-sockdrive.html
- Install OS: https://js-dos.com/install-os.html
- Publish Sockdrive bundle: https://js-dos.com/publish-sockdrive-bundle.html
- Player API: https://js-dos.com/player-api.html

## 7) Lưu ý bản quyền

Chỉ sử dụng nội dung/game mà bạn có quyền sử dụng (own files / abandonware hợp pháp / game tự làm).
