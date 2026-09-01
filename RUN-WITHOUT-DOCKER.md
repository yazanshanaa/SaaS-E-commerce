# تشغيل سوق برطعة بدون Docker (على ويندوز)

## ليش؟
Docker Desktop بيشغّل محرّكه جوّا WSL2، وهاد بيسبّب **كراش كيرنل (BSOD `0x0000007e`)** بيعيد تشغيل الجهاز — موثّق بـ `restart-diagnosis.txt`. تطبيق Next.js نفسه بريء؛ بس ٣ خدمات كانت على Docker (Postgres / Redis / Mailpit). هالطريقة بتشغّلهم بدون أي WSL2:

- **Postgres** → `embedded-postgres` (مثبّت أصلاً، نفس اللي بتستعمله الاختبارات)، بيانات دائمة في `.pgdata-dev` على المنفذ `5432`.
- **Redis** → **ما بينشغّل**. الكاش بيرجع للداتابيس تلقائياً (`src/server/redis.ts`). محتاج الـ worker؟ شغّل Redis محلي ومرّر `-Worker`.
- **Mailpit** → SMTP sink بسيط داخل العملية بيكتب كل رسالة في `.tmp/dev-mail.json`.

## التشغيل
من PowerShell داخل مجلد المشروع:

```powershell
.\scripts\dev-native.ps1
```

- بيطلب صلاحية أدمن **مرّة وحدة** فقط لتعديل ملف `hosts` (لوحة الأدمن والتاجر بتحتاج أسماء نطاقات).
- خلّي النافذة مفتوحة — هي السيرفر. للإيقاف: `Ctrl+C`.

بعد ما يجهز:
- لوحة المنصة: `http://admin.souqbartaa.test:3000`
- لوحة التاجر: `http://app.souqbartaa.test:3000`
- المتجر التجريبي: بينضاف اسمه تلقائياً **بالتشغيلة الجاية** (لأن الـ slug بينعرف بعد الـ seed).
- الدخول: `admin@souqbartaa.test` / `ChangeMe!2026`
- البريد: `.tmp/dev-mail.json`

### خيارات
```powershell
.\scripts\dev-native.ps1 -Worker     # شغّل الـ worker كمان (بدّه Redis محلي على 6379)
.\scripts\dev-native.ps1 -HostsOnly  # عدّل الـ hosts وبس
.\scripts\dev-native.ps1 -ResetDb    # امسح .pgdata-dev وابنيه من جديد (لو الداتابيس تعطّلت)
```

## ⚠️ لا تشغّل هالسكربتات
بتشغّل Docker وبترجّع الريستارت:
`run-site.ps1` · `go.ps1` · `fix-wsl-and-run.ps1` · `auto-fix-docker.ps1` · `wait-and-run.ps1` · `dev-up.ps1`

يُفضّل كمان تعطّل تشغيل Docker Desktop التلقائي عند الإقلاع (إعدادات Docker → General، أو Task Manager → Startup).

## جذر المشكلة (اختياري، لما تفضى)
لتحديد الـ driver المسبّب للكراش — سكربت آمن (قراءة فقط، ما بيشغّل Docker):

```powershell
.\scripts\diagnose-bsod.ps1
```

بيكتب `bsod-evidence.txt`. للأفضل شغّله كأدمن. الحلول الشائعة لـ `0x7E` مع الـ virtualization: تحديث WSL (`wsl --update`)، تحديث كرت الشاشة/الشبكة، أو إطفاء **Core Isolation → Memory Integrity**، وفحص الرام (Windows Memory Diagnostic).
