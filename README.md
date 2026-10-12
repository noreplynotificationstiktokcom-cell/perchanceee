# Perchance Local REST API

## Trang thai kiem thu thuc te (2026-10-12)

REST server va hang doi da qua kiem thu local, nhung luong iframe tu localhost
CHUA tao anh thanh cong: engine `image-generation.perchance.org` tu choi ket noi
trong iframe va trang hien `PSP-VERIFY-TIMEOUT`. Doi URL ngoai sang `null.perchance.org`
chi sua duoc khung ngoai. Tao anh khi mo truc tiep trang Perchance la luong rieng.
Khong xem 13 test local (worker gia lap) la bang chung API da tao anh that.
Ban bridge nay chua san sang de host production; can thay cach tich hop trinh duyet.

REST API chay bang Node.js, su dung giao thuc iframe + postMessage tai:
https://perchance.org/perchance-ai-api

Iframe su dung URL nhung `https://null.perchance.org/perchance-ai-api` theo huong dan
https://perchance.org/embed-generator. URL trang thuong `https://perchance.org/...`
co the bi tu choi nhung boi X-Frame-Options.

Day la wrapper cua trang Image API tren Perchance, khong phai may chu chay mo hinh AI.
Anh van duoc tao boi Perchance va trang Image API luu anh tren user.uploads.dev voi URL lau dai.
Trang nay cung khong bao dam dung cung model, style hay mac dinh nhu ai-text-to-image-generator.

## Chay tren Windows

Can Node.js >= 22.9. Khong can cai thu vien, GPU hay OpenAI API key.

```powershell
cd D:\AI-Images\perchance-api
npm.cmd start
```

Mo http://127.0.0.1:3000/bridge trong trinh duyet, bam **Ket noi**, va giu tab nay mo.
Trang bridge hien iframe khi dang tao anh. Neu Perchance hien xac minh, hoan thanh thu cong trong trinh duyet.
Khong co bridge ket noi, API tra 503; khong tu dong vuot CAPTCHA/Cloudflare.

## Goi API

```powershell
$body = @{
  prompt = 'a red ceramic teapot on a white table, studio photograph'
  size = '512x512'
  n = 1
  response_format = 'url'
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:3000/v1/images/generations' `
  -ContentType 'application/json' -Body $body -TimeoutSec 210
```

JavaScript:

```javascript
const response = await fetch('http://127.0.0.1:3000/v1/images/generations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'a mountain lake at sunrise', size: '768x512' }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error.message);
console.log(result.data[0].url);
```

Response:

```json
{
  "created": 1791792000,
  "data": [{ "url": "https://user.uploads.dev/your-image", "seed": 7 }]
}
```

`response_format=b64_json` tra base64 tu `dataUrl`, hoac tai anh tu URL `https://user.uploads.dev` neu upstream chi tra URL.
Chi tai tu host nay, khong theo redirect, gioi han 8 MB va timeout 15 giay.

| Truong | Gia tri |
| --- | --- |
| prompt | Bat buoc, 1-4000 ky tu |
| model | `perchance`, neu truyen |
| size / resolution | `512x512`, `512x768`, `768x512`, `768x768` |
| n | `1` |
| negative_prompt / negativePrompt | Tuy chon, toi da 4000 ky tu |
| guidance_scale / guidanceScale | 1-30, mac dinh 7 |
| seed | So nguyen tu -1 den 2147483647 |
| remove_background / removeBackground | Boolean, mac dinh false |
| response_format | `url` (mac dinh) hoac `b64_json` |

Endpoints: `POST /v1/images/generations`, `POST /api/generate` (cung format), `GET /health`.
Request duoc xu ly lan luot, toi da 8 request dang cho/xu ly. Timeout mac dinh 180 giay bao gom thoi gian cho.
Loi co format `{ "error": { "code": "...", "message": "..." } }`.

## Cau hinh va host

```powershell
Copy-Item .env.example .env
```

Sua `.env` de doi `HOST`, `PORT`, `API_KEY`, `GENERATION_TIMEOUT_MS`, `MAX_PENDING`, `CORS_ORIGINS`.
Chay tren VPS/Linux/Windows bang Node.js; dat reverse proxy HTTPS truoc API neu truy cap qua Internet.
De lang nghe ngoai localhost, dat `HOST=0.0.0.0` va `API_KEY` it nhat 24 ky tu.
API key chi cua wrapper nay, khong phai key Perchance. Moi request API can header `Authorization: Bearer <API_KEY>`;
nhap cung key trong trang bridge. Health cung can header nay neu key da duoc cau hinh.
`CORS_ORIGINS` la danh sach origin cach nhau boi dau phay, vi du `https://my-app.example`.
Giu SSE `/worker/events` khong bi buffer va reverse proxy timeout lon hon thoi gian tao anh.

Van can mot trinh duyet mo `/bridge` tren may cua ban de xu ly request; dich vu nay khong phai API server-only.
Neu tab bi dong/ngu dong hoac Perchance loi, request tra loi/timeout thay vi tra anh gia.
Ket qua phu thuoc vao trang Perchance, cookie ben thu ba, kha nang nhung iframe va giao thuc postMessage cua ho.
Giao thuc co the thay doi. Khong co host public nao duoc trien khai boi lenh chay local.

## Kiem thu

```powershell
npm.cmd test
```

Test local dung worker gia lap, khong gui prompt hay tao anh tren Perchance.
