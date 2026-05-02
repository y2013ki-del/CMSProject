#!/bin/zsh

set -euo pipefail

RECIPIENT="kyoungin.yu@partner.sec.co.kr"
SCRIPT_PATH="$0"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
SCRIPT_NAME="$(basename "$SCRIPT_PATH")"
FOLDER_NAME="$(basename "$SCRIPT_DIR")"
TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"
TMP_BASE="${TMPDIR:-/tmp}/${FOLDER_NAME}_${TIMESTAMP}"
ZIP_PATH="${TMP_BASE}.zip"
TXT_PATH="${TMP_BASE}.txt"
SUBJECT="[자동발송] ${FOLDER_NAME} 자료 전달드립니다"
BODY=$'안녕하세요.\n\n'"${FOLDER_NAME}"$' 폴더 자료 전달드립니다.\n첨부 파일 확인 부탁드립니다.\n\n감사합니다.'
LOCK_DIR="${TMPDIR:-/tmp}/auto_mail_send_${FOLDER_NAME}.lock"
STATE_FILE="$SCRIPT_DIR/.last_mail_sent_at"
COOLDOWN_SECONDS=90

cleanup_generated() {
  rm -f "$ZIP_PATH" "$TXT_PATH"
}

cleanup_all() {
  cleanup_generated
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

trap cleanup_all EXIT

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  osascript -e 'display alert "이미 발송 중입니다." message "자동 메일 발송이 이미 실행 중입니다. 잠시 후 다시 시도해주세요." as warning'
  exit 1
fi

cd "$SCRIPT_DIR"

NOW_EPOCH="$(date '+%s')"
if [[ -f "$STATE_FILE" ]]; then
  LAST_SENT_AT="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
  if [[ "$LAST_SENT_AT" =~ ^[0-9]+$ ]] && (( NOW_EPOCH - LAST_SENT_AT < COOLDOWN_SECONDS )); then
    osascript -e 'display alert "방금 메일을 보냈습니다." message "중복 발송 방지를 위해 잠시 후 다시 시도해주세요." as warning'
    exit 1
  fi
fi

if ! find . -mindepth 1 -maxdepth 1 \
  ! -name "$SCRIPT_NAME" \
  ! -name '.DS_Store' \
  | grep -q .; then
  osascript -e 'display alert "보낼 파일이 없습니다." message "실행 파일을 제외한 발송 대상 파일이 폴더 안에 없습니다." as warning'
  exit 1
fi

zip -r "$ZIP_PATH" . \
  -x "./$SCRIPT_NAME" \
  -x "./.DS_Store" \
  >/dev/null

cp "$ZIP_PATH" "$TXT_PATH"

osascript <<APPLESCRIPT
tell application id "com.apple.mail"
  set newMessage to make new outgoing message with properties {subject:"$SUBJECT", content:"$BODY" & return & return, visible:false}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:"$RECIPIENT"}
    tell content
      make new attachment with properties {file name:POSIX file "$TXT_PATH"} at after last paragraph
    end tell
    send
  end tell
end tell
APPLESCRIPT

printf '%s\n' "$NOW_EPOCH" > "$STATE_FILE"

osascript -e 'display notification "첨부 txt 발송 후 임시 파일 삭제까지 완료했습니다." with title "Auto Mail"' >/dev/null 2>&1 || true
