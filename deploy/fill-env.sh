#!/usr/bin/env bash
# =============================================================================
# املأ القيم الناقصة في .env — واحدة واحدة، بلصق واحد لكل وحدة.
#
#   sudo bash /srv/souq-bartaa/deploy/fill-env.sh
#
# ليش سكربت وليس `nano`:
#   - ما في تنقّل بين أرقام أسطر، ولا خطر تعديل سطر غلط في ملف من 376 سطر.
#   - القيم تُقرأ بـ `read -s`، فما بتظهر على الشاشة ولا بتدخل `~/.bash_history`.
#     أمر `sed` فيه مفتاح سري يقعد في التاريخ لحد ما يمسحه حدا — وغالباً ما بينمسح.
#   - المفتاح الموجود أصلاً بينحكى عنه ولا بينلمس، فالتشغيل مرتين آمن.
#   - في النهاية بيقول بالضبط إذا الستاك بيقدر يقلع ولا لأ، وشو ناقص.
#
# ENTER فاضي = تخطّي. شغّله كمان مرة لما يجهز الناقص.
# =============================================================================

set -u
ENV_FILE=/srv/souq-bartaa/.env

[ -f "$ENV_FILE" ] || { echo "ما لقيت $ENV_FILE"; exit 1; }

# القيم المطلوبة اللي بدونها docker compose بيرفض يقوم أصلاً (معلّمة بـ :? في الـ compose)
REQUIRED=(
  R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  R2_BACKUP_ACCESS_KEY_ID R2_BACKUP_SECRET_ACCESS_KEY
  BACKUP_AGE_RECIPIENT CLOUDFLARE_API_TOKEN
)

current() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }

write_value() {
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import sys, re
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding='utf-8').read().split('\n')
out, done = [], False
for line in lines:
    if not done and re.match(r'^' + re.escape(key) + r'=', line):
        out.append(f'{key}={val}')
        done = True
    else:
        out.append(line)
if not done:
    out.append(f'{key}={val}')
open(path, 'w', encoding='utf-8').write('\n'.join(out))
PY
}

mask() {
  local v="$1" n=${#1}
  if [ "$n" -le 10 ]; then printf '%s' "$v"; else printf '%s…%s (%d حرف)' "${v:0:4}" "${v: -4}" "$n"; fi
}

ask() {
  local key="$1" where="$2" secret="${3:-yes}"
  local cur; cur="$(current "$key")"
  if [ -n "$cur" ]; then
    printf '  \033[32m✓\033[0m %-34s موجود\n' "$key"
    return
  fi
  echo
  printf '\033[1m%s\033[0m\n' "$key"
  printf '  من: %s\n' "$where"
  local val
  if [ "$secret" = "yes" ]; then
    read -rsp '  الصق ثم Enter (ما رح يظهر): ' val; echo
  else
    read -rp  '  الصق ثم Enter: ' val
  fi
  if [ -z "$val" ]; then printf '  \033[33m…\033[0m تخطّيت\n'; return; fi
  write_value "$key" "$val"
  printf '  \033[32m✓\033[0m انكتب: %s\n' "$(mask "$val")"
}

echo
echo "==============================================================="
echo "  تعبئة .env — الصق كل قيمة لما يطلبها، أو Enter فاضي للتخطّي"
echo "==============================================================="

echo
echo "--- Cloudflare ---"
ask CLOUDFLARE_API_TOKEN "التوكن Zone:DNS:Edit اللي عملناه"
ask CLOUDFLARE_ZONE_ID   "Cloudflare ← souq48.shop ← ملخص ← عمود يمين (مش سر)" no

echo
echo "--- R2: زوج الميديا (souq48-media) ---"
ask R2_ACCESS_KEY_ID     "Access Key ID"
ask R2_SECRET_ACCESS_KEY "Secret Access Key"

echo
echo "--- R2: زوج كتابة النسخ (souq48-backup-write) ---"
ask R2_BACKUP_ACCESS_KEY_ID     "Access Key ID"
ask R2_BACKUP_SECRET_ACCESS_KEY "Secret Access Key"

echo
echo "--- R2: زوج القراءة فقط (souq48-backup-read) ---"
echo "  هدول لشاشة النسخ في لوحة الأدمن. لو تركتهم فاضيين الشاشة"
echo "  بتقول «غير مهيأة» والستاك بيقلع عادي — بس زوج الكتابة فوق بيقدر"
echo "  يمسح كل نسخة تاريخية، وحاوية الويب هي الوحيدة المكشوفة للإنترنت."
ask R2_BACKUP_READ_ACCESS_KEY_ID     "Access Key ID (Object Read only)"
ask R2_BACKUP_READ_SECRET_ACCESS_KEY "Secret Access Key"

echo
echo "--- تشفير النسخ الاحتياطية ---"
echo "  المفتاح العام بس (بيبدأ بـ age1). الملف السري ممنوع يوصل هالسيرفر:"
echo "  بدونه اللي بياخد الصندوق بياخد قاعدة البيانات الحية وبس؛ معه بياخد"
echo "  أربعتاشر يوم من نسخ كل تاجر مرّ على المنصة."
ask BACKUP_AGE_RECIPIENT "مخرجات age-keygen على جهازك — سطر age1..." no

echo
echo "--- البريد ---"
ask RESEND_API_KEY "لوحة Resend ← API Keys"

echo
echo "==============================================================="
missing=()
for k in "${REQUIRED[@]}"; do [ -z "$(current "$k")" ] && missing+=("$k"); done

if [ ${#missing[@]} -eq 0 ]; then
  echo -e "  \033[32mكل المطلوب معبّى — الستاك جاهز يقلع.\033[0m"
  echo
  echo "  الخطوة الجاية:"
  echo "    cd /srv/souq-bartaa"
  echo "    docker compose -f docker-compose.prod.yml build"
  echo "    docker compose -f docker-compose.prod.yml up -d"
else
  echo -e "  \033[33mلسا ناقص ${#missing[@]} — الحاويات بترفض تقوم بدونهم:\033[0m"
  for k in "${missing[@]}"; do echo "    - $k"; done
  echo
  echo "  شغّل السكربت كمان مرة لما يجهزوا. اللي انكتب بيضل مكتوب."
fi
echo "==============================================================="
echo

chown souq:souq "$ENV_FILE" 2>/dev/null || true
chmod 600 "$ENV_FILE"
